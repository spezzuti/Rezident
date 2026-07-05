import secrets

from fastapi import Depends, HTTPException, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings

_bearer = HTTPBearer(auto_error=False)


def _token_ok(candidate: str | None) -> bool:
    return bool(candidate) and bool(settings.token) and secrets.compare_digest(candidate, settings.token)


async def require_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    if not _token_ok(credentials.credentials if credentials else None):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or missing token")


async def require_ws_token(websocket: WebSocket) -> bool:
    """Browsers cannot set WS headers, so the token rides the query string.

    Fine over Tailscale (encrypted transport); never log full WS URLs.
    """
    return _token_ok(websocket.query_params.get("token"))
