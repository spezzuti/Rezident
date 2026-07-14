"""Tests for the Codex-integration classification + sign-in fixes.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_codex_local.py

All I/O is faked — no network, no real DB, no real Codex login. Covers:
  (a) _slot_runtime maps oauth/local -> "local", api/bridge -> "remote"
  (b) /api/agents labels an enabled codex (oauth) and ollama (local+model)
      slot runtime "local", and an openai (api) / hermes (bridge) slot "remote"
  (c) a Claude profile brained to a LOCAL integration is "local"; brained to a
      remote one is "remote"; an unbrained profile is "local"
  (d) _login_watch success path AUTO-ENABLES the slot (signed in = connected),
      and a failed login leaves it disabled
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from agentos import integrations  # noqa: E402
from agentos.api import system  # noqa: E402


# ---- fakes -------------------------------------------------------------------

class FakeDB:
    """Key/value store for get_config/save_config plus a fetch_all for profiles."""

    def __init__(self):
        self.store: dict[str, str] = {}
        self.profiles: list[dict] = []

    async def fetch_one(self, sql, params=()):
        k = params[0]
        return {"value": self.store[k]} if k in self.store else None

    async def execute(self, sql, params=()):
        self.store[params[0]] = params[1]

    async def fetch_all(self, sql, params=()):
        return list(self.profiles)


class _EofStream:
    async def read(self, n):
        return b""  # immediate EOF — nothing on stdout/stderr


class _FakeLoginProc:
    def __init__(self, rc=0):
        self.returncode = rc
        self.stdout = _EofStream()
        self.stderr = _EofStream()

    async def wait(self):
        return self.returncode


def _use_fakedb() -> FakeDB:
    fake = FakeDB()
    integrations.db = fake
    system.db = fake  # list_agents reads agent_profiles through system.db
    return fake


def _profile(pid, name, brain=None):
    return {"id": pid, "name": name, "integration_key": brain, "model": "",
            "role": "", "icon": "", "color": "", "description": "", "is_default": 0}


# ---- tests -------------------------------------------------------------------

async def test_slot_runtime_helper():
    assert system._slot_runtime("oauth") == "local"
    assert system._slot_runtime("local") == "local"
    assert system._slot_runtime("api") == "remote"
    assert system._slot_runtime("bridge") == "remote"


async def test_agents_roster_excludes_local_conduits():
    _use_fakedb()
    # LOCAL conduits (codex oauth, ollama local) never stand on the roster as
    # themselves — they're plumbing, staffed via recruited companions (user
    # direction, 2026-07-13). Only networked agents join directly: bridges
    # always, api providers once a model is set on the card.
    await integrations.save_config("codex", enabled=True, endpoint="", model="",
                                   token=None, ssh="", transport="codex-cli")
    await integrations.save_config("ollama", enabled=True, endpoint="http://127.0.0.1:11434",
                                   model="llama3.2", token=None)
    await integrations.save_config("openai", enabled=True, endpoint="", model="gpt-4o", token="sk-x")
    await integrations.save_config("hermes", enabled=True, endpoint="", model="hermes-3",
                                   token=None, ssh="me@host", transport="openai")

    agents = await system.list_agents()
    by_key = {a["integration_key"]: a for a in agents if a["kind"] == "integration"}
    assert "codex" not in by_key, sorted(by_key)
    assert "ollama" not in by_key, sorted(by_key)
    assert by_key["openai"]["runtime"] == "remote", by_key["openai"]
    assert by_key["hermes"]["runtime"] == "remote", by_key["hermes"]


async def test_brained_profile_runtime_follows_brain_kind():
    fake = _use_fakedb()
    await integrations.save_config("codex", enabled=True, endpoint="", model="",
                                   token=None, ssh="", transport="codex-cli")
    await integrations.save_config("openai", enabled=True, endpoint="", model="gpt-4o", token="sk-x")
    fake.profiles = [
        _profile("p1", "Local"),                 # unbrained -> local
        _profile("p2", "CodexBrain", "codex"),   # oauth brain -> local
        _profile("p3", "OpenAIBrain", "openai"),  # api brain -> remote
    ]
    agents = await system.list_agents()
    by_id = {a["id"]: a for a in agents if a["kind"] == "claude"}
    assert by_id["p1"]["runtime"] == "local", by_id["p1"]
    assert by_id["p2"]["runtime"] == "local", by_id["p2"]
    assert by_id["p3"]["runtime"] == "remote", by_id["p3"]


async def test_login_success_enables_slot():
    _use_fakedb()
    # codex starts with no stored config (disabled by default)
    assert (await integrations.get_config("codex")).get("enabled") is not True
    proc = _FakeLoginProc(rc=0)
    ses = {"proc": proc, "url": "", "buf": "", "done": False, "ok": False,
           "detail": "", "transport": "codex-cli", "started": 0}
    integrations._login_sessions["codex"] = ses
    await integrations._login_watch("codex", ses, integrations._LOGIN_SPEC["codex-cli"])
    assert ses["done"] is True and ses["ok"] is True, ses
    cfg = await integrations.get_config("codex")
    assert cfg["enabled"] is True, "signed in must auto-enable the slot (no separate Save)"


class _UrlStream:
    """Stub CLI stdout: one chunk carrying the sign-in URL, then EOF."""

    def __init__(self, text: bytes):
        self._chunks = [text]

    async def read(self, n):
        return self._chunks.pop(0) if self._chunks else b""


async def test_login_url_capture_and_button_open():
    """ONE browser-open owner: the CLI opens its own tab (a second opener races
    it into an OAuth 'state mismatch'), so Rezident must NOT auto-open on URL
    capture — but the card's button (host-side open) must work on demand."""
    import asyncio
    import os as _os
    import webbrowser

    _use_fakedb()
    opened: list = []
    orig_start = getattr(_os, "startfile", None)
    orig_web = webbrowser.open
    _os.startfile = lambda u, *a, **k: opened.append(("startfile", u))
    webbrowser.open = lambda u, *a, **k: (opened.append(("webbrowser", u)), True)[1]
    try:
        proc = _FakeLoginProc(rc=0)
        proc.stdout = _UrlStream(b"Open https://auth.openai.com/oauth/authorize?x=1 to continue\n")
        ses = {"proc": proc, "url": "", "buf": "", "done": False, "ok": False,
               "detail": "", "transport": "codex-cli", "started": 0}
        integrations._login_sessions["codex"] = ses
        await integrations._login_watch("codex", ses, integrations._LOGIN_SPEC["codex-cli"])
        await asyncio.sleep(0.25)
        assert ses["url"].startswith("https://auth.openai.com"), ses
        assert not opened, "no auto-open — the CLI owns the browser tab (duplicate = state mismatch)"
        # the manual path (the card's button) must open on demand
        res = integrations.reopen_login_url("codex")
        await asyncio.sleep(0.25)
        assert res["ok"] and res["url"] == ses["url"], res
        assert opened and opened[0][1] == ses["url"], "the button must open via the host"
    finally:
        webbrowser.open = orig_web
        if orig_start is not None:
            _os.startfile = orig_start


async def test_launch_login_spawn_path_never_zombies():
    """Drive the REAL launch_login spawn path (the 2026-07-14 field 500 lived
    here: a function-scoped import my tests never reached). The spawned 'CLI'
    is the python interpreter — the spawn itself must succeed, and whatever
    the outcome, the session must SETTLE (done) rather than zombie 'running'."""
    import asyncio
    import sys

    fake = _use_fakedb()
    integrations._login_sessions.pop("codex", None)
    # explicit binary override via endpoint: python exits nonzero on 'login',
    # which exercises spawn + watch + settle without any real vendor CLI
    await integrations.save_config("codex", enabled=False, endpoint=sys.executable,
                                   model="", token=None, ssh="", transport="codex-cli")
    st = await integrations.launch_login("codex")
    assert isinstance(st, dict), st
    for _ in range(40):  # the watch settles as soon as the interpreter exits
        ses = integrations._login_sessions.get("codex") or {}
        if ses.get("done"):
            break
        await asyncio.sleep(0.2)
    ses = integrations._login_sessions.get("codex") or {}
    assert ses.get("done"), f"session must settle, never zombie: {ses.get('detail')!r}"
    fake  # keep the fixture alive to the end


async def test_login_failure_leaves_slot_disabled():
    _use_fakedb()
    proc = _FakeLoginProc(rc=1)
    ses = {"proc": proc, "url": "", "buf": "", "done": False, "ok": False,
           "detail": "", "transport": "codex-cli", "started": 0}
    integrations._login_sessions["codex"] = ses
    await integrations._login_watch("codex", ses, integrations._LOGIN_SPEC["codex-cli"])
    assert ses["done"] is True and ses["ok"] is False, ses
    cfg = await integrations.get_config("codex")
    assert cfg.get("enabled") is not True, "a failed sign-in must NOT enable the slot"


# ---- runner -------------------------------------------------------------------

TESTS = [
    test_slot_runtime_helper,
    test_agents_roster_excludes_local_conduits,
    test_brained_profile_runtime_follows_brain_kind,
    test_login_success_enables_slot,
    test_login_url_capture_and_button_open,
    test_launch_login_spawn_path_never_zombies,
    test_login_failure_leaves_slot_disabled,
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
