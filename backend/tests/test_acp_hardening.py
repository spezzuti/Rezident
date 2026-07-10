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


# ---- F3: the ACP reader survives a non-dict JSON line -------------------------

class _FakeStdout:
    def __init__(self, lines):
        self._lines = list(lines)

    async def readline(self):
        return self._lines.pop(0) if self._lines else b""


class _FakeProc:
    def __init__(self, stdout):
        self.stdout = stdout
        self.returncode = None


async def test_reader_tolerates_non_dict_json():
    # a valid JSON scalar/array line ([], "log", 42) between two real responses must
    # NOT break the read loop (it would AttributeError on msg.get and fail all pending
    # calls); the reader skips it and still resolves both real responses.
    client = _RealAcpClient.__new__(_RealAcpClient)  # bypass __init__ (no process)
    client._on_update = None
    loop = asyncio.get_event_loop()
    f1, f2 = loop.create_future(), loop.create_future()
    client._pending = {1: f1, 2: f2}
    client._proc = _FakeProc(_FakeStdout([
        b'{"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n',
        b'[]\n',                 # array — not a JSON-RPC message
        b'"scalar log line"\n',  # string scalar
        b'42\n',                 # number scalar
        b'{"jsonrpc":"2.0","id":2,"result":{"ok":2}}\n',
    ]))
    await client._read_loop()
    assert f1.done() and not f1.exception() and f1.result()["result"] == {"ok": 1}, "first response lost"
    assert f2.done() and not f2.exception() and f2.result()["result"] == {"ok": 2}, "reader broke on the junk line"


# ---- F4: SSH destination grammar validation + argv `--` -----------------------

async def test_parse_ssh_rejects_and_accepts():
    IE = integrations.IntegrationError
    for bad in ("-oProxyCommand=/x", "evil host", "", "   ", "user@host:99999",
                "user@host:0", "bad\thost", "-l"):
        try:
            integrations._parse_ssh(bad)
        except IE:
            pass
        else:
            raise AssertionError(f"_parse_ssh must reject {bad!r}")

    assert integrations._parse_ssh("user@host") == ("user@host", 22)
    assert integrations._parse_ssh("user@host:2222") == ("user@host", 2222)
    assert integrations._parse_ssh("[::1]:22") == ("[::1]", 22)              # bracketed IPv6 + port
    assert integrations._parse_ssh("user@[::1]") == ("user@[::1]", 22)       # bracketed IPv6, default port
    assert integrations._parse_ssh("user@[::1]:2200") == ("user@[::1]", 2200)


async def test_ssh_argv_has_double_dash_before_dest():
    # _ssh_base_args (CLI + ACP-probe): `--` immediately precedes the destination.
    base = integrations._ssh_base_args("me@host", 2222)
    assert "--" in base and base[base.index("--") + 1] == "me@host", base
    assert "me@host" not in base[: base.index("--")], "dest must appear only after --"

    # the acp.AcpClient.start() argv builder: capture argv by making the spawn fail.
    captured = {}

    async def fake_exec(*args, **kwargs):
        captured["args"] = list(args)
        raise FileNotFoundError()

    orig = acp.asyncio.create_subprocess_exec
    acp.asyncio.create_subprocess_exec = fake_exec  # type: ignore[assignment]
    try:
        client = _RealAcpClient("me@host", 2222)
        try:
            await client.start()
        except acp.AcpError:
            pass  # start() wraps FileNotFoundError; we only want the captured argv
    finally:
        acp.asyncio.create_subprocess_exec = orig  # type: ignore[assignment]
    args = captured["args"]
    assert "--" in args and args[args.index("--") + 1] == "me@host", args
    assert "me@host" not in args[: args.index("--")], "dest must appear only after --"


# ---- F2: WS token redacted from uvicorn access logs ---------------------------

async def test_access_log_token_redaction():
    import logging

    from agentos import logfilter

    logfilter.install_access_log_redaction()
    logfilter.install_access_log_redaction()  # idempotent
    accesslog = logging.getLogger("uvicorn.access")
    assert sum(isinstance(f, logfilter.RedactTokenFilter) for f in accesslog.filters) == 1, "installed once"

    flt = next(f for f in accesslog.filters if isinstance(f, logfilter.RedactTokenFilter))
    # mimic a uvicorn access record: args tuple, the path (with query) is one arg.
    rec = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:53000", "GET", "/ws?token=SUPERSECRET123&x=1", "1.1", 101),
        None,
    )
    assert flt.filter(rec) is True
    out = rec.getMessage()
    assert "SUPERSECRET123" not in out, out
    assert "token=REDACTED" in out, out
    assert "&x=1" in out, "non-token params survive"

    # also scrubs a pre-formatted message string and a #token fragment
    rec2 = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                             "GET /app#token=abcDEF", None, None)
    flt.filter(rec2)
    assert "abcDEF" not in rec2.getMessage() and "token=REDACTED" in rec2.getMessage()


# ---- runner -------------------------------------------------------------------

TESTS = [
    test_content_as_list_accumulates,
    test_empty_turn_is_diagnostic,
    test_save_config_enabled_none_preserves,
    test_request_permission_no_allow_cancels,
    test_reader_tolerates_non_dict_json,
    test_parse_ssh_rejects_and_accepts,
    test_ssh_argv_has_double_dash_before_dest,
    test_access_log_token_redaction,
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
