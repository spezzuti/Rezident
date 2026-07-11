"""Per-device credential registry (Android companion app).

Each paired phone holds its own bearer token — revocable, optionally expiring,
scoped — accepted ALONGSIDE the single master token (see auth.py). Only the
SHA-256 of a token is ever persisted; the raw value is shown once at creation
(pairing) and never again.
"""

import hashlib
import json
import secrets
import uuid

from .db import db, row_to_dict

DEFAULT_SCOPES = ["tasks", "approvals", "notify"]


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


async def create_device(label: str, scopes: list[str] | None = None) -> tuple[str, str]:
    """Mint a device + its raw token. Returns (device_id, raw_token); the raw
    token is NOT stored — only its hash — so this is the sole moment it exists."""
    device_id = uuid.uuid4().hex
    raw = secrets.token_urlsafe(32)
    await db.execute(
        "INSERT INTO devices (id, label, token_hash, scopes) VALUES (?, ?, ?, ?)",
        (device_id, label, _hash(raw), json.dumps(scopes if scopes is not None else DEFAULT_SCOPES)),
    )
    return device_id, raw


async def verify_device_token(raw: str) -> dict | None:
    """Resolve a presented raw token to its device row (minus token_hash), or None
    if unknown, revoked, or expired. Lookup is by hashed equality on an indexed
    column — not timing-sensitive the way a raw-secret compare is — so an indexed
    lookup is fine. On success, bumps last_seen (throttled, see below)."""
    if not raw:
        return None
    row = await db.fetch_one("SELECT * FROM devices WHERE token_hash = ?", (_hash(raw),))
    d = row_to_dict(row)
    if d is None or d["revoked"]:
        return None
    expires_at = d.get("expires_at")
    if expires_at:
        # ISO-Z timestamps sort lexicographically; compare against the same 'now' format.
        now = await db.fetch_one("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
        if now and expires_at <= now["now"]:
            return None
    # Throttle the last_seen write: bumping it on EVERY authenticated request would
    # serialize all device auth through the global write-lock. Only touch the row
    # when we've never recorded a sighting or the last one is >~60s stale. The read
    # below doesn't take the write-lock; the UPDATE runs only when actually needed.
    last_seen = d.get("last_seen")
    if not last_seen:
        stale = True
    else:
        cutoff = await db.fetch_one(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds') AS cutoff"
        )
        stale = bool(cutoff) and last_seen < cutoff["cutoff"]
    if stale:
        await db.execute(
            "UPDATE devices SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            (d["id"],),
        )
    d.pop("token_hash", None)
    return d


async def set_fcm_token(device_id: str, fcm: str | None) -> None:
    await db.execute("UPDATE devices SET fcm_token = ? WHERE id = ?", (fcm, device_id))


async def list_devices() -> list[dict]:
    """All devices, token_hash stripped (never leak the credential hash)."""
    rows = await db.fetch_all(
        "SELECT id, label, scopes, fcm_token, created_at, last_seen, expires_at, revoked"
        " FROM devices ORDER BY created_at DESC"
    )
    return [dict(r) for r in rows]


async def revoke_device(device_id: str) -> bool:
    """Mark a device revoked. Returns whether a row with that id matched."""
    row = await db.execute_returning(
        "UPDATE devices SET revoked = 1 WHERE id = ? RETURNING id",
        (device_id,),
    )
    return row is not None


async def delete_device(device_id: str) -> bool:
    """Hard-delete a device row. Returns whether a row with that id matched. Unlike
    revoke_device (which soft-revokes, keeping the row so the token stays dead but
    listed), this removes the row entirely."""
    row = await db.execute_returning(
        "DELETE FROM devices WHERE id = ? RETURNING id",
        (device_id,),
    )
    return row is not None
