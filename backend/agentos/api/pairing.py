"""Device pairing + management (Android companion, Phase 0.3).

A short-lived, single-use pairing code bridges the master-token desktop and an
unauthenticated phone: the desktop mints a code (master-only), renders it as a
QR, and the phone claims it (no auth — the code IS the gate) to receive its own
per-device token. Codes live in-process only — one server process owns this API,
so an in-memory store is correct and survives exactly as long as it should.
"""

import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import devices
from ..auth import require_master, require_scope
from ..config import settings

router = APIRouter(prefix="/api")

# code -> {exp: unix epoch seconds, base_url: str}. Single-use: burned on claim.
# The base_url is captured at /pair/start (it's what the QR encodes) and returned
# verbatim on /pair/claim so the phone stores the SAME reachable address the desktop
# advertised — never the loopback default, which is unreachable from the phone.
_CODES: dict[str, dict] = {}
_CODE_TTL_SECONDS = 300  # ~5 min
# Brute-force cap: failed claim attempts within the window, tracked PER REMOTE IP.
# A single global counter would let one bad actor's flood lock out the legitimate
# phone (a DoS on pairing itself); keying by IP isolates the offender so a real
# claim from another address always gets through. Codes are token_urlsafe(8)
# (~64 bits) so this is belt-and-suspenders against guessing, but per-IP it also
# can't be weaponized to deny the real device.
_FAILS: dict[str, list[float]] = {}
_FAIL_WINDOW_SECONDS = 60
_FAIL_MAX = 20


def _prune(now: float) -> None:
    for code, entry in list(_CODES.items()):
        if entry["exp"] <= now:
            del _CODES[code]
    cutoff = now - _FAIL_WINDOW_SECONDS
    for ip, hits in list(_FAILS.items()):
        kept = [t for t in hits if t > cutoff]
        if kept:
            _FAILS[ip] = kept
        else:
            del _FAILS[ip]  # drop idle IPs so the map can't grow unbounded


def _primary_lan_ip() -> str | None:
    """The IPv4 the OS would use to reach the outside world = the primary LAN
    interface (skips loopback and virtual adapters, since routing picks the real
    default route). No packets are sent — connecting a UDP socket just resolves
    the source address. Returns None when offline."""
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()
    return ip if ip and not ip.startswith("127.") else None


def _default_base_url() -> str:
    """Best-effort reachable base URL from the running bind state. The desktop
    knows its own MagicDNS/Tailscale name best, so /pair/start lets the request
    body override this. When bound to a wildcard/loopback the phone can't use that
    address, so probe the primary LAN IP (e.g. 192.168.0.29) instead."""
    from ..config import bind_state
    from .. import tailscale

    # Prefer the bundled Tailscale node's address when it's connected — the phone
    # (also on the tailnet) reaches it over WireGuard with no LAN/VPS exposure and
    # the server stays loopback-bound. Falls through to the LAN probe otherwise.
    ts_url = tailscale.tailnet_base_url()
    if ts_url:
        return ts_url

    host = bind_state().get("effective") or settings.host or "127.0.0.1"
    if host in ("0.0.0.0", "::", "127.0.0.1", "::1", "localhost"):
        host = _primary_lan_ip() or "127.0.0.1"
    return f"http://{host}:{settings.port}"


class PairStartBody(BaseModel):
    base_url: str | None = None  # desktop override (MagicDNS/Tailscale name)


class PairClaimBody(BaseModel):
    code: str
    label: str = Field(min_length=1, max_length=80)


class FcmBody(BaseModel):
    fcm_token: str | None = None  # None clears the stored token (e.g. on logout)


@router.post("/pair/start", dependencies=[Depends(require_master)])
async def pair_start(body: PairStartBody) -> dict:
    """Master-only: mint a single-use pairing code + the base URL the phone should
    hit. Returns {code, base_url, expires_at}."""
    now = time.time()
    _prune(now)
    code = secrets.token_urlsafe(8)
    expires = now + _CODE_TTL_SECONDS
    base_url = (body.base_url or "").strip() or _default_base_url()
    _CODES[code] = {"exp": expires, "base_url": base_url}
    return {
        "code": code,
        "base_url": base_url,
        "expires_at": _iso(expires),
    }


@router.post("/pair/claim")
async def pair_claim(body: PairClaimBody, request: Request) -> dict:
    """UNAUTHENTICATED but code-gated: validate + burn a pairing code, mint a
    device token. Invalid/expired/reused code -> 409. Rate-limited PER REMOTE IP
    so a flood from one address can't lock out the real phone."""
    now = time.time()
    _prune(now)
    ip = request.client.host if request.client else "unknown"
    if len(_FAILS.get(ip, ())) >= _FAIL_MAX:
        raise HTTPException(status_code=429, detail="Too many pairing attempts; try again shortly")
    code = (body.code or "").strip()
    entry = _CODES.get(code)
    if not code or entry is None or entry["exp"] <= now:
        _FAILS.setdefault(ip, []).append(now)
        raise HTTPException(status_code=409, detail="Invalid, expired, or already-used pairing code")
    del _CODES[code]  # single-use: burn on success
    device_id, token = await devices.create_device(body.label, devices.DEFAULT_SCOPES)
    # Return the base_url captured at /pair/start (what the QR advertised), so the
    # phone stores the reachable address — not the loopback default.
    return {"device_id": device_id, "token": token, "base_url": entry["base_url"]}


@router.get("/devices", dependencies=[Depends(require_master)])
async def get_devices() -> list[dict]:
    """Master-only: list paired devices (no token_hash leaked)."""
    return await devices.list_devices()


@router.post("/devices/{device_id}/fcm")
async def register_fcm(device_id: str, body: FcmBody, identity: dict = Depends(require_scope("notify"))) -> dict:
    """Register/update a device's FCM push token. SELF-ONLY: the master token may set
    any device's token, but a device token may only touch ITS OWN — a phone can't
    register push for another device. Anything else is a 403."""
    if identity["kind"] != "master" and identity.get("device", {}).get("id") != device_id:
        raise HTTPException(status_code=403, detail="A device may only register its own FCM token")
    await devices.set_fcm_token(device_id, (body.fcm_token or None))
    return {"ok": True}


@router.post("/devices/{device_id}/revoke", dependencies=[Depends(require_master)])
async def revoke(device_id: str) -> dict:
    """Master-only: revoke a device token."""
    if not await devices.revoke_device(device_id):
        raise HTTPException(status_code=404, detail="Unknown device")
    return {"ok": True}


@router.delete("/devices/{device_id}", dependencies=[Depends(require_master)])
async def delete(device_id: str) -> dict:
    """Master-only: hard-delete a device (removes the row, not just soft-revoke)."""
    if not await devices.delete_device(device_id):
        raise HTTPException(status_code=404, detail="Unknown device")
    return {"ok": True}


def _iso(epoch: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
