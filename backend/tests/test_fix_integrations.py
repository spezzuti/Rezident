"""Regression test for the outbound-HTTP redirect hardening (track: integrations).

The three outbound httpx clients in agentos.integrations (the connection probe,
the chat dispatch, and the embeddings dispatch) must be created with
follow_redirects=False. httpx does NOT strip custom auth headers (Anthropic's
'x-api-key', or the bearer) when it follows a cross-origin redirect, so a
provider endpoint that 30x-redirects elsewhere would leak the API key. The
providers we talk to never need a redirect, so we simply stop following them.

This also pins the invariant that the fix does NOT touch auth: the Anthropic
slot still sends both the Bearer and its native x-api-key header.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_fix_integrations.py

All I/O is faked — no network, no DB.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

import httpx  # noqa: E402

from agentos import integrations  # noqa: E402


# ---- fakes -------------------------------------------------------------------

_calls: list[dict] = []  # one record per httpx.AsyncClient(...) construction


class _FakeResponse:
    """Satisfies every reader in the three code paths at once: OpenAI chat
    shape, OpenAI embeddings shape, and a models list for the probe."""

    status_code = 200
    text = ""

    def json(self):
        return {
            "choices": [{"message": {"content": "hi"}}],  # dispatch_messages
            "data": [{"embedding": [0.0, 1.0]}],          # dispatch_embeddings + probe count
        }


class _RecordingClient:
    """Stands in for httpx.AsyncClient: records the follow_redirects kwarg and
    the headers of each request, then returns a canned response. No sockets."""

    def __init__(self, *args, **kwargs):
        self._rec = {"follow_redirects": kwargs.get("follow_redirects"), "headers": None}
        _calls.append(self._rec)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None, **kw):
        self._rec["headers"] = headers
        return _FakeResponse()

    async def post(self, url, json=None, headers=None, **kw):
        self._rec["headers"] = headers
        return _FakeResponse()


def _ready_cfg(**over) -> dict:
    cfg = {"enabled": True, "token": "sk-test-123", "model": "", "transport": "openai",
           "endpoint": "http://127.0.0.1:12345"}
    cfg.update(over)
    return cfg


class _Patch:
    """Swap module/attr targets for the duration of a test, then restore."""

    def __init__(self):
        self._saved = []

    def set(self, obj, name, value):
        self._saved.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def restore(self):
        for obj, name, value in reversed(self._saved):
            setattr(obj, name, value)


def _install(p: _Patch):
    _calls.clear()
    p.set(httpx, "AsyncClient", _RecordingClient)  # integrations refs httpx.AsyncClient at call time

    async def fake_get_config(key):
        return _ready_cfg()

    async def fake_effective_base(cfg):
        return "http://127.0.0.1:12345"

    async def fake_finish_probe(key, cfg, result):
        return result  # skip the DB write

    p.set(integrations, "get_config", fake_get_config)
    p.set(integrations, "_effective_base", fake_effective_base)
    p.set(integrations, "_finish_probe", fake_finish_probe)


# ---- tests -------------------------------------------------------------------

async def test_dispatch_messages_no_redirect_and_keeps_xapikey():
    p = _Patch()
    _install(p)
    try:
        out = await integrations.dispatch_messages(
            "anthropic", [{"role": "user", "content": "hi"}])
    finally:
        p.restore()
    assert out["reply"] == "hi", out
    assert len(_calls) == 1, _calls
    assert _calls[0]["follow_redirects"] is False, "chat dispatch must NOT follow redirects"
    # the fix must not have disturbed auth: Anthropic sends x-api-key AND the bearer
    hdrs = _calls[0]["headers"] or {}
    assert hdrs.get("x-api-key") == "sk-test-123", "x-api-key is Anthropic's primary auth — must survive"
    assert hdrs.get("Authorization") == "Bearer sk-test-123", hdrs


async def test_dispatch_embeddings_no_redirect():
    p = _Patch()
    _install(p)
    try:
        vecs = await integrations.dispatch_embeddings("openai", ["a", "b"])
    finally:
        p.restore()
    assert vecs == [[0.0, 1.0]], vecs
    assert len(_calls) == 1 and _calls[0]["follow_redirects"] is False, _calls


async def test_probe_no_redirect():
    p = _Patch()
    _install(p)
    try:
        res = await integrations.probe("openai")
    finally:
        p.restore()
    assert res["ok"] is True, res
    assert _calls, "probe made no outbound request"
    assert all(c["follow_redirects"] is False for c in _calls), _calls


async def test_source_never_follows_redirects():
    """Belt-and-suspenders: no outbound client in the module may follow redirects,
    so a future edit that adds one can't silently reintroduce the header leak."""
    src = Path(integrations.__file__).read_text(encoding="utf-8")
    assert "follow_redirects=True" not in src, "an outbound client still follows redirects"
    # every AsyncClient construction explicitly opts out
    idx = 0
    seen = 0
    while True:
        idx = src.find("httpx.AsyncClient(", idx)
        if idx == -1:
            break
        seen += 1
        segment = src[idx:src.find(")", idx)]
        assert "follow_redirects=False" in segment, f"AsyncClient without follow_redirects=False: {segment!r}"
        idx += 1
    assert seen >= 3, f"expected the 3 known outbound clients, found {seen}"


# ---- runner -------------------------------------------------------------------

TESTS = [
    test_dispatch_messages_no_redirect_and_keeps_xapikey,
    test_dispatch_embeddings_no_redirect,
    test_probe_no_redirect,
    test_source_never_follows_redirects,
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
