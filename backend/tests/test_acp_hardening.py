"""Regression tests for the ACP/integration hardening fixes.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_acp_hardening.py

All I/O is faked — no network, no SSH, no real DB. Covers:
  (a) on_update accumulates text when content is a LIST of blocks
  (b) an empty turn yields a stopReason diagnostic, not "(empty reply)"
  (c) save_config(enabled=None) PRESERVES the stored on/off state
  (d) request_permission with no "allow" option responds "cancelled"
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import acp, integrations  # noqa: E402

_RealAcpClient = acp.AcpClient  # earlier tests swap acp.AcpClient for a fake; keep the real one


# ---- fakes -------------------------------------------------------------------

class FakeAcpClient:
    """Stands in for acp.AcpClient: drives a scripted list of updates through
    on_update, then returns a canned prompt result. No process, no SSH."""

    script: list[dict] = []
    result: dict = {}

    def __init__(self, *a, **k):
        self.agent_info = {}

    async def start(self):
        return {}

    async def new_session(self, *a, **k):
        return "sess-1"

    async def prompt(self, session_id, text, on_update, timeout=300):
        for u in type(self).script:
            await on_update(u)
        return type(self).result

    async def close(self):
        pass

    async def cancel(self, *a, **k):
        pass


class FakeDB:
    """Minimal key/value store matching the two SQL statements save_config/
    get_config use (SELECT value ... WHERE key=?, and the upsert)."""

    def __init__(self):
        self.store: dict[str, str] = {}

    async def fetch_one(self, sql, params=()):
        k = params[0]
        return {"value": self.store[k]} if k in self.store else None

    async def execute(self, sql, params=()):
        self.store[params[0]] = params[1]


# ---- tests -------------------------------------------------------------------

async def test_content_as_list_accumulates():
    FakeAcpClient.script = [
        {"sessionUpdate": "agent_message_chunk",
         "content": [{"type": "text", "text": "Hello, "}, {"type": "text", "text": "world"}]},
        {"sessionUpdate": "agent_message",
         "content": {"type": "text", "text": "!"}},  # final-message kind, single block
    ]
    FakeAcpClient.result = {"stopReason": "end_turn"}
    acp.AcpClient = FakeAcpClient  # _dispatch_acp imports AcpClient from acp at call time
    cfg = {"ssh": "me@host", "model": ""}
    out = await integrations._dispatch_acp("hermes", cfg, [{"role": "user", "content": "hi"}])
    assert out["reply"] == "Hello, world!", out["reply"]


async def test_empty_turn_is_diagnostic():
    FakeAcpClient.script = [
        {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}},
        {"sessionUpdate": "usage_update", "usage": {"tokens": 28000}},  # no message text at all
    ]
    FakeAcpClient.result = {"stopReason": "end_turn"}
    acp.AcpClient = FakeAcpClient
    cfg = {"ssh": "me@host", "model": ""}
    out = await integrations._dispatch_acp("hermes", cfg, [{"role": "user", "content": "hi"}])
    r = out["reply"]
    assert r != "(empty reply)", r
    assert "stopReason=end_turn" in r, r
    assert "check the remote box" in r, r
    assert "thought/tool" in r, r  # saw_nontext was surfaced


async def test_save_config_enabled_none_preserves():
    integrations.db = FakeDB()
    # seed: enabled True
    await integrations.save_config("hermes", enabled=True, endpoint="", model="",
                                   token="secret", ssh="me@host", transport="acp")
    # a partial PUT (transport-only) arrives as enabled=None -> must NOT disable
    cfg = await integrations.save_config("hermes", enabled=None, endpoint="", model="",
                                         token=None, ssh="me@host", transport="hermes-cli")
    assert cfg["enabled"] is True, cfg["enabled"]
    assert cfg["token"] == "secret", "token must be preserved too"
    # an explicit False still flips it off
    cfg = await integrations.save_config("hermes", enabled=False, endpoint="", model="",
                                         token=None, ssh="me@host", transport="acp")
    assert cfg["enabled"] is False, cfg["enabled"]


async def test_request_permission_no_allow_cancels():
    client = _RealAcpClient.__new__(_RealAcpClient)  # bypass __init__ (needs no process)
    client._on_update = None
    sent: list[dict] = []

    async def fake_send(obj):
        sent.append(obj)

    client._send = fake_send
    # only reject/deny options offered — must NOT be auto-picked
    msg = {"jsonrpc": "2.0", "id": 7, "method": "session/request_permission",
           "params": {"options": [{"optionId": "no", "kind": "reject_once"},
                                  {"optionId": "never", "kind": "reject_always"}]}}
    await client._handle_incoming(msg)
    assert len(sent) == 1, sent
    assert sent[0]["result"]["outcome"]["outcome"] == "cancelled", sent[0]

    # sanity: when an allow option exists, it IS selected
    sent.clear()
    msg["params"]["options"].append({"optionId": "yes", "kind": "allow_once"})
    await client._handle_incoming(msg)
    assert sent[0]["result"]["outcome"] == {"outcome": "selected", "optionId": "yes"}, sent[0]


# ---- runner -------------------------------------------------------------------

TESTS = [
    test_content_as_list_accumulates,
    test_empty_turn_is_diagnostic,
    test_save_config_enabled_none_preserves,
    test_request_permission_no_allow_cancels,
]


def main() -> int:
    failed = 0
    for t in TESTS:
        try:
            asyncio.run(t())
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL  {t.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
