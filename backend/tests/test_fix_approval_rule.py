"""Regression: the /approvals/{id}/resolve create_rule side channel (GPT-Sol
finding #1). Auto-approve rules are master-gated everywhere else (a rule runs tool
calls WITHOUT a human), but resolve_approval used to (a) let any 'approvals'-scoped
device create one and (b) insert it BEFORE validating the approval, so a bogus
resolve still left a rule behind. Now: create_rule is master-only, and the insert
happens only AFTER a successful resolution.

Run: backend/.venv/Scripts/python.exe backend/tests/test_fix_approval_rule.py
"""

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

from fastapi import HTTPException  # noqa: E402

import agentos.api.approvals as ap  # noqa: E402
from agentos.api.approvals import ResolveBody, RuleCreate, resolve_approval  # noqa: E402
from agentos.config import settings  # noqa: E402
from agentos.db import db  # noqa: E402

MASTER = {"kind": "master", "scopes": None}
DEVICE = {"kind": "device", "scopes": ["tasks", "approvals", "notify"]}


async def _fresh_db() -> None:
    settings.data_dir = Path(tempfile.mkdtemp(prefix="apprule-"))
    if db._conn is not None:
        await db.close()
    await db.connect()


async def _rule_count() -> int:
    row = await db.fetch_one("SELECT COUNT(*) AS c FROM auto_approve_rules")
    return row["c"]


def _body(with_rule: bool):
    rule = RuleCreate(tool_name="Bash", pattern="rm", action="allow") if with_rule else None
    return ResolveBody(action="approve", create_rule=rule)


async def run() -> bool:
    await _fresh_db()
    base = await _rule_count()  # migrations seed default auto-approve rules — assert deltas
    passed = 0

    # 1. a scoped DEVICE presenting create_rule -> 403, and NO rule inserted
    try:
        await resolve_approval("bogus", _body(True), identity=DEVICE)
        raise AssertionError("expected HTTPException 403")
    except HTTPException as e:
        assert e.status_code == 403, f"expected 403, got {e.status_code}"
    assert await _rule_count() == base, "a device must not create a rule"
    print("PASS  device_create_rule_forbidden_no_insert"); passed += 1

    # 2. MASTER + create_rule but the resolve FAILS (bogus id) -> 404, NO rule
    #    (proves the insert is after-success, not before-validation)
    ap.broker.resolve = lambda *a, **k: False
    try:
        await resolve_approval("bogus", _body(True), identity=MASTER)
        raise AssertionError("expected HTTPException 404")
    except HTTPException as e:
        assert e.status_code == 404, f"expected 404, got {e.status_code}"
    assert await _rule_count() == base, "a failed resolve must not leave a rule"
    print("PASS  failed_resolve_creates_no_rule"); passed += 1

    # 3. MASTER + create_rule + a SUCCESSFUL resolve -> rule created
    ap.broker.resolve = lambda *a, **k: True
    out = await resolve_approval("ok", _body(True), identity=MASTER)
    assert out == {"ok": True}
    assert await _rule_count() == base + 1, "master rule should be created after success"
    print("PASS  master_rule_created_after_success"); passed += 1

    # 4. a DEVICE can still resolve normally when it isn't creating a rule
    out = await resolve_approval("ok", _body(False), identity=DEVICE)
    assert out == {"ok": True}
    assert await _rule_count() == base + 1, "a plain device resolve adds no rule"
    print("PASS  device_plain_resolve_allowed"); passed += 1

    await db.close()
    print(f"\n{passed}/4 passed")
    return passed == 4


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(run()) else 1)
