import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_token
from ..db import db
from ..events import utcnow
from ..orchestrator import orchestrator

router = APIRouter(prefix="/api/pipelines", dependencies=[Depends(require_token)])


class Stage(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    prompt: str = ""
    profile_id: str | None = None
    integration_key: str | None = None
    model: str | None = None
    kind: str = "general"
    cwd: str | None = None
    repo_path: str | None = None
    base_branch: str | None = None
    verify_command: str | None = None


class PipelineBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    stages: list[Stage] = []


class RunBody(BaseModel):
    input: str = ""


def _row(r) -> dict:
    d = dict(r)
    d["stages"] = json.loads(d["stages"] or "[]")
    return d


def _run_row(r) -> dict:
    d = dict(r)
    d["task_ids"] = json.loads(d["task_ids"] or "[]")
    return d


@router.get("")
async def list_pipelines() -> list[dict]:
    return [_row(r) for r in await db.fetch_all("SELECT * FROM pipelines ORDER BY created_at")]


@router.post("", status_code=201)
async def create_pipeline(body: PipelineBody) -> dict:
    pipeline_id = str(uuid.uuid4())
    now = utcnow()
    await db.execute(
        "INSERT INTO pipelines (id, name, description, stages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (pipeline_id, body.name, body.description,
         json.dumps([s.model_dump() for s in body.stages]), now, now),
    )
    return _row(await db.fetch_one("SELECT * FROM pipelines WHERE id = ?", (pipeline_id,)))


@router.put("/{pipeline_id}")
async def update_pipeline(pipeline_id: str, body: PipelineBody) -> dict:
    await db.execute(
        "UPDATE pipelines SET name=?, description=?, stages=?, updated_at=? WHERE id=?",
        (body.name, body.description, json.dumps([s.model_dump() for s in body.stages]),
         utcnow(), pipeline_id),
    )
    row = await db.fetch_one("SELECT * FROM pipelines WHERE id = ?", (pipeline_id,))
    if row is None:
        raise HTTPException(404, "pipeline not found")
    return _row(row)


@router.delete("/{pipeline_id}")
async def delete_pipeline(pipeline_id: str) -> dict:
    await db.execute("DELETE FROM pipelines WHERE id = ?", (pipeline_id,))
    return {"ok": True}


@router.post("/{pipeline_id}/run")
async def run_pipeline(pipeline_id: str, body: RunBody) -> dict:
    row = await db.fetch_one("SELECT * FROM pipelines WHERE id = ?", (pipeline_id,))
    if row is None:
        raise HTTPException(404, "pipeline not found")
    try:
        return await orchestrator.start_run(dict(row), body.input)
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.get("/runs/recent")
async def recent_runs(limit: int = 30) -> list[dict]:
    rows = await db.fetch_all(
        "SELECT r.*, p.name AS pipeline_name FROM pipeline_runs r"
        " LEFT JOIN pipelines p ON p.id = r.pipeline_id"
        " ORDER BY r.started_at DESC LIMIT ?", (limit,),
    )
    return [_run_row(r) for r in rows]


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str) -> dict:
    ok = await orchestrator.cancel_run(run_id)
    if not ok:
        raise HTTPException(409, "run is not active")
    return {"ok": True}
