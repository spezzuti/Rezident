import json
import secrets

from fastapi import Depends, HTTPException, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import devices, ws_tickets
from .config import settings

_bearer = HTTPBearer(auto_error=False)


def _master_ok(candidate: str | None) -> bool:
    """Constant-time compare against the single master token (the web path)."""
    return bool(candidate) and bool(settings.token) and secrets.compare_digest(candidate, settings.token)


async def resolve_identity(candidate: str | None) -> dict | None:
    """Resolve a presented bearer to a caller identity, or None if it matches
    nothing. The master token is checked FIRST (fast, constant-time, no DB) and
    grants every scope; otherwise fall back to a per-device token lookup.

    Returns a dict: {"kind": "master", "scopes": None} for the master token
    (None scopes = all), or {"kind": "device", "device": <row>, "scopes": [...]}
    for a valid device token. None means unauthenticated."""
    if _master_ok(candidate):
        return {"kind": "master", "scopes": None}
    if candidate:
        device = await devices.verify_device_token(candidate)
        if device is not None:
            try:
                scopes = json.loads(device.get("scopes") or "[]")
            except (TypeError, ValueError):
                scopes = []
            return {"kind": "device", "device": device, "scopes": scopes}
    return None


async def require_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """Accept the master token OR a valid per-device token. Returns the resolved
    identity so scope-aware routes can reuse it; existing routes ignore it."""
    identity = await resolve_identity(credentials.credentials if credentials else None)
    if identity is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or missing token")
    return identity


async def require_master(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """Master-token only. Device tokens are rejected — used to gate pairing/device
    management so a paired phone can't mint or revoke other devices."""
    identity = await resolve_identity(credentials.credentials if credentials else None)
    if identity is None:
        # No/invalid token → 401 (re-authenticate). A VALID device token that simply
        # isn't the master → 403 (forbidden, but still authenticated): 401 here would
        # make the companion app treat a master-only route as "token dead" and drop
        # its connection, bouncing the user back to pairing.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or missing token")
    if identity["kind"] != "master":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Master token required")
    return identity


def require_scope(scope: str):
    """Dependency factory gating a route on a scope. The master token passes
    always (all scopes); a device passes only if `scope` is in its scopes list.
    Available for future per-scope gating — not retrofitted onto existing routers
    in this chunk."""

    async def dependency(
        credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    ) -> dict:
        identity = await resolve_identity(credentials.credentials if credentials else None)
        if identity is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or missing token")
        if identity["kind"] != "master" and scope not in (identity.get("scopes") or []):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Scope '{scope}' required")
        return identity

    return dependency


async def require_ws_token(websocket: WebSocket) -> bool:
    """Authenticate a WS handshake. Browsers cannot set WS headers, so the
    credential rides the query string.

    Preferred path (finding #3): a short-lived, single-use `?ticket=` minted via
    POST /api/ws-ticket — the durable token never travels in a URL. If a ticket is
    present and redeems to an identity, the caller is authenticated.

    Fallback path (back-compat): the existing `?token=` bearer, so an already-open
    client — or one that couldn't fetch a ticket — is never worse off than before.
    Fine over Tailscale (encrypted transport); never log full WS URLs. Accepts the
    master token OR a valid per-device token."""
    if ws_tickets.consume(websocket.query_params.get("ticket")) is not None:
        return True
    return await resolve_identity(websocket.query_params.get("token")) is not None
