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
        raise HTTPException(409, "task has no live agent session — use retry to resume it")
    await rt.runner.send_user_message(body.text)
    return {"ok": True}


class RetryBody(MessageIn):
    text: str = "Continue the task. Address whatever caused the previous attempt to fail."


@router.post("/{task_id}/retry", status_code=201)
async def retry_task(task_id: str, body: RetryBody | None = None) -> dict:
    parent = await manager.get_task(task_id)
    if parent is None:
        raise HTTPException(404, "task not found")
    if parent["status"] not in ("done", "failed", "cancelled"):
        raise HTTPException(409, "task is still active")
    prompt = (body.text if body else RetryBody().text)
    if parent["status"] == "failed" and parent.get("error"):
        prompt += f"\n\nPrevious attempt error:\n{parent['error'][:1500]}"
    return await manager.create_task({
        "title": f"↻ {parent['title']}"[:200],
        "prompt": prompt,
        "kind": parent["kind"],
        "cwd": parent["cwd"],
        "repo_path": parent["repo_path"],
        "base_branch": parent["base_branch"],
        "verify_command": parent["verify_command"],
        "parent_task_id": parent["id"],
        # Reuse the same worktree so the retry sees prior work in place.
        "worktree_path": parent["worktree_path"],
        "branch": parent["branch"],
    })


@router.get("/{task_id}/diff")
async def get_diff(task_id: str) -> dict:
    from .. import worktree

    task = await manager.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    if task["kind"] != "repo":
        return {"diff": ""}
    return {"diff": await worktree.get_diff(task)}


@router.post("/{task_id}/worktree/merge")
async def merge_worktree(task_id: str) -> dict:
    from ..worktree import GitError, merge

    task = await manager.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    if task["status"] not in ("done", "failed", "cancelled"):
        raise HTTPException(409, "finish or cancel the task before merging")
    try:
        message = await merge(task)
    except GitError as exc:
        raise HTTPException(409, str(exc))
    await db.execute("UPDATE tasks SET worktree_path=NULL WHERE id=?", (task_id,))
    return {"ok": True, "message": message}


@router.post("/{task_id}/worktree/discard")
async def discard_worktree(task_id: str) -> dict:
    from ..worktree import GitError, discard

    task = await manager.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    if task["status"] not in ("done", "failed", "cancelled"):
        raise HTTPException(409, "finish or cancel the task before discarding")
    try:
        message = await discard(task)
    except GitError as exc:
        raise HTTPException(409, str(exc))
    await db.execute("UPDATE tasks SET worktree_path=NULL, branch=NULL WHERE id=?", (task_id,))
    return {"ok": True, "message": message}
