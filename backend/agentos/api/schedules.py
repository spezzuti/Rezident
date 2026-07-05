import json
import uuid
from typing import Literal

from croniter import croniter
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_token
from ..db import db
from ..events import utcnow
from ..scheduler import scheduler

router = APIRouter(prefix="/api/schedules", dependencies=[Depends(require_token)])


class ScheduleBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    cron_expr: str
    prompt: str = Field(min_length=1)
    kind: Literal["general", "repo"] = "general"
    cwd: str | None = None
    repo_path: str | None = None
    base_branch: str | None = None
    verify_command: str | None = None
    profile_id: str | None = None
    enabled: bool = True
    overlap_policy: Literal["skip", "queue"] = "skip"
    dream: bool = False


def _row(r) -> dict:
    d = dict(r)
    d["task_template"] = json.loads(d["task_template"] or "{}")
    return d


def _template(body: ScheduleBody) -> str:
    return json.dumps({
        "prompt": body.prompt, "kind": body.kind, "cwd": body.cwd,
        "repo_path": body.repo_path, "base_branch": body.base_branch,
        "verify_command": body.verify_command, "profile_id": body.profile_id,
        "dream": body.dream,
    })


def _validate_cron(expr: str) -> None:
    if not croniter.is_valid(expr):
        raise HTTPException(422, f"invalid cron expression: {expr!r} (use e.g. '0 9 * * *')")


@router.get("")
async def list_schedules() -> list[dict]:
    return [_row(r) for r in await db.fetch_all("SELECT * FROM schedules ORDER BY created_at")]


@router.post("", status_code=201)
async def create_schedule(body: ScheduleBody) -> dict:
    _validate_cron(body.cron_expr)
    schedule_id = str(uuid.uuid4())
    await db.execute(
        "INSERT INTO schedules (id, name, cron_expr, task_template, enabled, overlap_policy, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (schedule_id, body.name, body.cron_expr, _template(body),
         int(body.enabled), body.overlap_policy, utcnow()),
    )
    return _row(await db.fetch_one("SELECT * FROM schedules WHERE id = ?", (schedule_id,)))


@router.put("/{schedule_id}")
async def update_schedule(schedule_id: str, body: ScheduleBody) -> dict:
    _validate_cron(body.cron_expr)
    await db.execute(
        "UPDATE schedules SET name=?, cron_expr=?, task_template=?, enabled=?, overlap_policy=?,"
        " next_run_at=NULL WHERE id=?",
        (body.name, body.cron_expr, _template(body), int(body.enabled), body.overlap_policy, schedule_id),
    )
    row = await db.fetch_one("SELECT * FROM schedules WHERE id = ?", (schedule_id,))
    if row is None:
        raise HTTPException(404, "schedule not found")
    return _row(row)


@router.delete("/{schedule_id}")
async def delete_schedule(schedule_id: str) -> dict:
    await db.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))
    return {"ok": True}


@router.post("/{schedule_id}/run_now")
async def run_now(schedule_id: str) -> dict:
    row = await db.fetch_one("SELECT * FROM schedules WHERE id = ?", (schedule_id,))
    if row is None:
        raise HTTPException(404, "schedule not found")
    task = await scheduler.fire(dict(row), scheduled=False)
    return {"ok": True, "task_id": task["id"] if task else None}
