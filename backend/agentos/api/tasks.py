from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_token
from ..db import db, loads_payload, row_to_dict
from ..schemas import MessageIn, TaskCreate
from ..task_manager import manager

router = APIRouter(prefix="/api/tasks", dependencies=[Depends(require_token)])


@router.post("", status_code=201)
async def create_task(body: TaskCreate) -> dict:
    return await manager.create_task(body.model_dump())


@router.get("")
async def list_tasks(status: str | None = None, limit: int = 200) -> list[dict]:
    if status:
        rows = await db.fetch_all(
            "SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?", (status, limit)
        )
    else:
        rows = await db.fetch_all("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


@router.get("/{task_id}")
async def get_task(task_id: str) -> dict:
    task = await manager.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    return task


@router.get("/{task_id}/events")
async def get_events(task_id: str, after_seq: int = 0, limit: int = 1000) -> list[dict]:
    rows = await db.fetch_all(
        "SELECT task_id, seq, ts, type, payload FROM task_events"
        " WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        (task_id, after_seq, limit),
    )
    return [loads_payload(r) for r in rows]


@router.post("/{task_id}/cancel")
async def cancel_task(task_id: str) -> dict:
    ok = await manager.cancel(task_id)
    if not ok:
        raise HTTPException(409, "task is not active")
    return {"ok": True}


@router.post("/{task_id}/message")
async def send_message(task_id: str, body: MessageIn) -> dict:
    rt = manager.running.get(task_id)
    if rt is None or rt.runner is None or rt.runner.client is None:
        raise HTTPException(409, "task has no live agent session")
    await rt.runner.send_user_message(body.text)
    return {"ok": True}
