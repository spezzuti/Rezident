"""Short-lived, single-use tickets for authenticating a WebSocket handshake.

Security review finding #3: browsers/WebViews cannot set request headers on a
WS upgrade, so historically the long-lived bearer token rode the `?token=` query
string — where it lands in access logs, browser history, and referrers. Instead,
an already-authenticated caller (Authorization: Bearer via require_token) POSTs
`/api/ws-ticket` to mint a random ticket that is valid for ~60s and dies on first
use. The durable token never travels in a URL.

In-process store: fine for the single-server deployment this ships as. A
multi-instance deployment (a load balancer fanning out to separate processes)
would need a shared store (e.g. Redis) so a ticket issued by one process can be
consumed by another.
"""

import secrets
import time
from typing import Any

# TTL for a freshly-minted ticket. The client fetches a ticket immediately before
# opening the socket, so a minute is ample slack for a slow handshake.
TTL_SECONDS = 60

# ticket -> (identity, expiry). `expiry` is a time.monotonic() deadline — NOT a
# wall-clock time — so the TTL is immune to system-clock adjustments (NTP steps,
# DST, manual changes). Module-level so a single-process server shares one store.
_tickets: dict[str, tuple[Any, float]] = {}


def _prune(now: float) -> None:
    """Drop every ticket whose deadline has passed. Cheap; the store is tiny
    (one entry per pending handshake) and turns over every ~60s."""
    for t in [t for t, (_, exp) in _tickets.items() if now >= exp]:
        del _tickets[t]


def issue(identity: Any) -> str:
    """Mint a single-use ticket for an already-authenticated identity and return
    it. The identity (whatever require_token resolved) is handed back verbatim by
    consume()."""
    now = time.monotonic()
    _prune(now)
    ticket = secrets.token_urlsafe(24)
    _tickets[ticket] = (identity, now + TTL_SECONDS)
    return ticket


def consume(ticket: str | None) -> Any | None:
    """Redeem a ticket: return its identity and DELETE it (single-use), or None if
    the ticket is missing, already used, or expired."""
    if not ticket:
        return None
    now = time.monotonic()
    _prune(now)
    entry = _tickets.pop(ticket, None)
    if entry is None:
        return None
    identity, expiry = entry
    if now >= expiry:  # defensive: _prune already removed it, but never honor a stale one
        return None
    return identity
