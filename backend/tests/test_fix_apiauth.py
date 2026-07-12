"""Regression tests for the 'apiauth' hardening track.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_fix_apiauth.py

Covers:
  FIX 1 — install_access_log_redaction() is idempotent AND is wired into
          agentos.main's lifespan (the raw `uvicorn agentos.main:app` path).
  FIX 2 — GET /api/memory/claude-files is gated by require_master, not just the
          router-level require_token.
  FIX 3 — GET /api/integrations coarsens ssh/endpoint/notes for a NON-master
          identity while the master keeps the full view.
  FIX 4 — PairClaimBody.label is length-bounded (1..80).
"""

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

BACKEND = Path(__file__).resolve().parents[1]


# ---- FIX 1: WS token redaction installed on the uvicorn.main path -------------

async def test_access_log_redaction_idempotent_and_wired():
    from agentos.logfilter import RedactTokenFilter, _redact, install_access_log_redaction

    # the scrubber actually rewrites a live-looking token
    assert _redact("GET /ws?token=SEKRET123&x=1") == "GET /ws?token=REDACTED&x=1"

    logger = logging.getLogger("uvicorn.access")
    # start from a clean slate so the count assertion is deterministic
    logger.filters = [f for f in logger.filters if not isinstance(f, RedactTokenFilter)]
    install_access_log_redaction()
    install_access_log_redaction()  # idempotent: second call must not add a duplicate
    installed = [f for f in logger.filters if isinstance(f, RedactTokenFilter)]
    assert len(installed) == 1, f"exactly one redaction filter expected, got {len(installed)}"

    # the lifespan must actually call it (guards against the wiring being removed)
    src = (BACKEND / "agentos" / "main.py").read_text(encoding="utf-8")
    assert "install_access_log_redaction()" in src, "main.py lifespan must install the redaction filter"


# ---- FIX 2: /claude-files is master-only -------------------------------------

def _dep_calls(route) -> set:
    """Every dependency callable reachable from a route (route-level Depends +
    the flattened dependant tree), so the check is robust to where FastAPI stores
    a given dependency."""
    calls: set = set()
    for d in getattr(route, "dependencies", []) or []:
        calls.add(getattr(d, "dependency", None))

    def walk(dependant) -> None:
        for sub in getattr(dependant, "dependencies", []) or []:
            calls.add(getattr(sub, "call", None))
            walk(sub)

    walk(route.dependant)
    return calls


async def test_claude_files_requires_master():
    from agentos.api import memory as memory_api
    from agentos.auth import require_master, require_token

    def find(path: str, method: str):
        # several handlers can share a path (e.g. GET/POST /facts), so match method too
        for r in memory_api.router.routes:
            if getattr(r, "path", None) == path and method in (getattr(r, "methods", None) or ()):
                return r
        return None

    claude = find("/api/memory/claude-files", "GET")
    assert claude is not None, "claude-files route must exist"
    calls = _dep_calls(claude)
    assert require_master in calls, "claude-files must be gated by require_master"

    # sanity: the read-only facts LIST (GET) stays require_token-only, proving the
    # master gate is specific to the sensitive file-read route, not the whole router.
    facts = find("/api/memory/facts", "GET")
    assert facts is not None
    assert require_master not in _dep_calls(facts), "GET list_facts must not be master-gated"
    assert require_token in _dep_calls(facts), "GET list_facts must still require a token"


# ---- FIX 3: integrations coarsened for non-master ----------------------------

async def test_integrations_coarsened_for_non_master():
    from agentos.api import system as system_api

    slot = {"key": "codexbridge", "name": "Codex Bridge", "icon": "x", "blurb": "b"}

    async def fake_get_config(key):
        # fresh dict each call — the handler pops 'token' and mutates the result
        return {
            "enabled": True,
            "endpoint": "https://secret.internal:9000",
            "ssh": "root@10.0.0.5:22",
            "notes": "prod box, do not share",
            "model": "gpt-x",
            "last_status": "ok",
            "token": "SUPERSECRET",
        }

    orig = {
        "INTEGRATION_SLOTS": system_api.INTEGRATION_SLOTS,
        "get_config": system_api.get_config,
        "slot_kind": system_api.slot_kind,
        "slot_transports": system_api.slot_transports,
    }
    system_api.INTEGRATION_SLOTS = [slot]
    system_api.get_config = fake_get_config
    system_api.slot_kind = lambda key: "bridge"
    system_api.slot_transports = lambda key: ["ssh"]
    try:
        master = await system_api.list_integrations(identity={"kind": "master", "scopes": None})
        assert len(master) == 1
        m = master[0]
        assert m["endpoint"] == "https://secret.internal:9000", "master keeps endpoint"
        assert m["ssh"] == "root@10.0.0.5:22", "master keeps ssh"
        assert m["notes"] == "prod box, do not share", "master keeps notes"
        assert m["has_token"] is True and "token" not in m, "secret token never leaks"

        device = await system_api.list_integrations(
            identity={"kind": "device", "device": {"id": "d1"}, "scopes": ["notify"]}
        )
        assert len(device) == 1
        d = device[0]
        # the sensitive infra fields are stripped...
        assert d["endpoint"] == "", "device must not see endpoint"
        assert d["ssh"] == "", "device must not see ssh"
        assert d["notes"] is None, "device must not see notes"
        # ...while name/model/enabled/status survive
        assert d["name"] == "Codex Bridge"
        assert d["model"] == "gpt-x"
        assert d["enabled"] is True
        assert d["last_status"] == "ok"
        assert "token" not in d, "secret token never leaks to a device either"
    finally:
        system_api.INTEGRATION_SLOTS = orig["INTEGRATION_SLOTS"]
        system_api.get_config = orig["get_config"]
        system_api.slot_kind = orig["slot_kind"]
        system_api.slot_transports = orig["slot_transports"]


# ---- FIX 4: pairing label length is bounded ----------------------------------

async def test_pair_claim_label_bounded():
    from pydantic import ValidationError

    from agentos.api.pairing import PairClaimBody

    # a normal label is accepted unchanged
    ok = PairClaimBody(code="abc", label="Pixel 8")
    assert ok.label == "Pixel 8"

    # empty label rejected (min_length=1)
    try:
        PairClaimBody(code="abc", label="")
        raise AssertionError("empty label must be rejected")
    except ValidationError:
        pass

    # over-long label rejected (max_length=80)
    try:
        PairClaimBody(code="abc", label="L" * 81)
        raise AssertionError("81-char label must be rejected")
    except ValidationError:
        pass

    # exactly 80 is the boundary and still accepted
    assert len(PairClaimBody(code="abc", label="L" * 80).label) == 80


# ---- runner ------------------------------------------------------------------

TESTS = [
    test_access_log_redaction_idempotent_and_wired,
    test_claude_files_requires_master,
    test_integrations_coarsened_for_non_master,
    test_pair_claim_label_bounded,
]


def main() -> int:
    failed = 0
    for t in TESTS:
        try:
            asyncio.run(t())
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
