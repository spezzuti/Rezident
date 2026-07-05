import json
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..approvals import Decision, broker, mark_resolved
from ..auth import require_token
from ..db import db
from ..events import utcnow

router = APIRouter(prefix="/api", dependencies=[Depends(require_token)])


class RuleCreate(BaseModel):
    tool_name: str
    field: str | None = None
    match_type: Literal["regex", "prefix", "glob"] = "prefix"
    pattern: str = Field(min_length=1)
    action: Literal["allow", "deny", "ask"]
    priority: int = 100
    description: str | None = None


class ResolveBody(BaseModel):
    action: Literal["approve", "approve_edit", "deny"]
    input: dict[str, Any] | None = None
    reason: str | None = None
    interrupt: bool = False
    create_rule: RuleCreate | None = None


def _row_to_approval(row) -> dict:
    d = dict(row)
    for key in ("tool_input", "resolved_input"):
        if isinstance(d.get(key), str):
            try:
                d[key] = json.loads(d[key])
            except json.JSONDecodeError:
                pass
    return d


@router.get("/approvals")
async def list_approvals(status: str | None = "pending", limit: int = 100) -> list[dict]:
    if status:
        rows = await db.fetch_all(
            "SELECT a.*, t.title AS task_title FROM approvals a"
            " LEFT JOIN tasks t ON t.id = a.task_id"
            " WHERE a.status = ? ORDER BY a.created_at LIMIT ?",
            (status, limit),
        )
    else:
        rows = await db.fetch_all(
            "SELECT a.*, t.title AS task_title FROM approvals a"
            " LEFT JOIN tasks t ON t.id = a.task_id"
            " ORDER BY a.created_at DESC LIMIT ?",
            (limit,),
        )
    return [_row_to_approval(r) for r in rows]


@router.post("/approvals/{approval_id}/resolve")
async def resolve_approval(approval_id: str, body: ResolveBody) -> dict:
    if body.create_rule is not None:
        rule = body.create_rule
        await db.execute(
            "INSERT INTO auto_approve_rules (id, tool_name, field, match_type, pattern, action, priority, description)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), rule.tool_name, rule.field, rule.match_type,
             rule.pattern, rule.action, rule.priority, rule.description),
        )

    ok = broker.resolve(
        approval_id,
        Decision(action=body.action, input=body.input, reason=body.reason, interrupt=body.interrupt),
    )
    if not ok:
        # Not in memory: either already resolved or orphaned by a restart.
        row = await db.fetch_one("SELECT status FROM approvals WHERE id = ?", (approval_id,))
        if row is None:
            raise HTTPException(404, "approval not found")
        if row["status"] == "pending":
            await mark_resolved(approval_id, "cancelled", deny_reason="orphaned by backend restart")
            raise HTTPException(409, "approval was orphaned by a restart; its task is no longer running")
        raise HTTPException(409, f"approval already {row['status']}")
    return {"ok": True}


# ---- rules CRUD --------------------------------------------------------------


@router.get("/rules")
async def list_rules() -> list[dict]:
    rows = await db.fetch_all("SELECT * FROM auto_approve_rules ORDER BY priority, created_at")
    return [dict(r) for r in rows]


@router.post("/rules", status_code=201)
async def create_rule(rule: RuleCreate) -> dict:
    rule_id = str(uuid.uuid4())
    await db.execute(
        "INSERT INTO auto_approve_rules (id, tool_name, field, match_type, pattern, action, priority, description, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (rule_id, rule.tool_name, rule.field, rule.match_type, rule.pattern,
         rule.action, rule.priority, rule.description, utcnow()),
    )
    row = await db.fetch_one("SELECT * FROM auto_approve_rules WHERE id = ?", (rule_id,))
    return dict(row)


class RulePatch(BaseModel):
    enabled: bool | None = None
    pattern: str | None = None
    action: Literal["allow", "deny", "ask"] | None = None
    priority: int | None = None
    description: str | None = None


@router.patch("/rules/{rule_id}")
async def patch_rule(rule_id: str, body: RulePatch) -> dict:
    sets, params = [], []
    for key, value in body.model_dump(exclude_none=True).items():
        sets.append(f"{key} = ?")
        params.append(int(value) if isinstance(value, bool) else value)
    if not sets:
        raise HTTPException(400, "nothing to update")
    params.append(rule_id)
    await db.execute(f"UPDATE auto_approve_rules SET {', '.join(sets)} WHERE id = ?", tuple(params))
    row = await db.fetch_one("SELECT * FROM auto_approve_rules WHERE id = ?", (rule_id,))
    if row is None:
        raise HTTPException(404, "rule not found")
    return dict(row)


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: str) -> dict:
    await db.execute("DELETE FROM auto_approve_rules WHERE id = ?", (rule_id,))
    return {"ok": True}
