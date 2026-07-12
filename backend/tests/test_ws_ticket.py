"""Short-lived, single-use WebSocket tickets (Security review finding #3).

The long-lived bearer no longer has to ride the `?token=` WS query string; an
authenticated caller mints a ticket that is valid for ~60s and dies on first use
(agentos.ws_tickets). Covered here:

  - issue -> consume returns the exact identity, ONCE
  - a second consume of the same ticket returns None (single-use)
  - an expired ticket returns None (past monotonic deadline injected)
  - a bogus / missing ticket returns None

The project ships no pytest — run standalone with the venv python:

    backend/.venv/Scripts/python.exe backend/tests/test_ws_ticket.py
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import ws_tickets  # noqa: E402


def test_issue_then_consume_returns_identity_once():
    identity = {"kind": "master", "scopes": None}
    ticket = ws_tickets.issue(identity)
    assert isinstance(ticket, str) and ticket, "issue must return a non-empty ticket string"
    got = ws_tickets.consume(ticket)
    assert got is identity, "first consume must return the exact identity that was issued"


def test_second_consume_is_none_single_use():
    ticket = ws_tickets.issue({"kind": "device", "device": {"id": "d1"}, "scopes": ["notify"]})
    assert ws_tickets.consume(ticket) is not None, "first consume should succeed"
    assert ws_tickets.consume(ticket) is None, "a ticket must be redeemable only once"


def test_expired_ticket_is_none():
    identity = {"kind": "master", "scopes": None}
    ticket = ws_tickets.issue(identity)
    # Inject a deadline in the past (monotonic, matching the store's clock) so the
    # ticket is expired without waiting out the real 60s TTL.
    ws_tickets._tickets[ticket] = (identity, time.monotonic() - 1)
    assert ws_tickets.consume(ticket) is None, "an expired ticket must not authenticate"
    assert ticket not in ws_tickets._tickets, "an expired ticket must be evicted from the store"


def test_bogus_ticket_is_none():
    assert ws_tickets.consume("not-a-real-ticket") is None, "an unknown ticket must return None"
    assert ws_tickets.consume("") is None, "an empty ticket must return None"
    assert ws_tickets.consume(None) is None, "a missing ticket must return None"


TESTS = [
    test_issue_then_consume_returns_identity_once,
    test_second_consume_is_none_single_use,
    test_expired_ticket_is_none,
    test_bogus_ticket_is_none,
]


def main() -> int:
    failed = 0
    for t in TESTS:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            import traceback
            print(f"FAIL  {t.__name__}: {type(exc).__name__}: {exc}")
            traceback.print_exc()
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
