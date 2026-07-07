"""TaskManager: queue, lifecycle state machine, asyncio task ownership.

The kanban board and Mission Control are driven purely by the event stream —
every status transition is validated here, persisted to tasks.status, emitted
as a per-task `status_change` event, and mirrored as a global task summary.
"""

import asyncio
import logging
import uuid
from typing import Any

from .config import settings
from .db import db, row_to_dict
from .events import bus, utcnow
from .schemas import ACTIVE_STATUSES

log = logging.getLogger(__name__)

VALID_TRANSITIONS: dict[str, set[str]] = {
    "queued": {"running", "cancelled", "failed"},
    "running": {"awaiting_approval", "waiting_input", "verifying", "done", "failed", "cancelled"},
    "awaiting_approval": {"running", "failed", "cancelled"},
    "waiting_input": {"running", "failed", "cancelled", "done"},
    "verifying": {"done", "failed", "cancelled"},
}


class RunningTask:
    def __init__(self, task_id: str, aio_task: asyncio.Task, kind: str = "general") -> None:
        self.task_id = task_id
        self.aio_task = aio_task
        self.kind = kind
        self.runner: Any = None  # set by AgentRunner once the client exists
        self.cancel_requested = False


class TaskManager:
    def __init__(self) -> None:
        self.running: dict[str, RunningTask] = {}
        self._dispatch_wakeup = asyncio.Event()
        self._dispatcher: asyncio.Task | None = None
        self._shutting_down = False

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        await self._mark_orphans()
        self._dispatcher = asyncio.create_task(self._dispatch_loop(), name="task-dispatcher")

    async def shutdown(self) -> None:
        self._shutting_down = True
        if self._dispatcher:
            self._dispatcher.cancel()
        # Resolve any pending approvals with deny so can_use_tool callbacks
        # unwind instead of hanging the SDK client forever.
        from .approvals import broker

        broker.deny_all_pending("AgentOS is shutting down")
        for rt in list(self.running.values()):
            rt.cancel_requested = True
            rt.aio_task.cancel()
        if self.running:
            await asyncio.gather(*(rt.aio_task for rt in self.running.values()), return_exceptions=True)

    async def _mark_orphans(self) -> None:
        """Tasks left active by a previous process are unrecoverable (one live
        client per task) — mark them failed; their session_id allows manual retry."""
        rows = await db.fetch_all(
            f"SELECT id FROM tasks WHERE status IN ({','.join('?' * len(ACTIVE_STATUSES))})",
            ACTIVE_STATUSES,
        )
        for row in rows:
            await db.execute(
                "UPDATE tasks SET status='failed', error='orphaned by backend restart', finished_at=? WHERE id=?",
                (utcnow(), row["id"]),
            )
            log.warning("Marked orphaned task %s as failed", row["id"])
        await db.execute(
            "UPDATE approvals SET status='cancelled', deny_reason='orphaned by backend restart',"
            " resolved_at=? WHERE status='pending'",
            (utcnow(),),
        )

    # -- creation / dispatch -------------------------------------------------

    async def create_task(self, fields: dict[str, Any]) -> dict[str, Any]:
        task_id = str(uuid.uuid4())
        cols = {
            "id": task_id,
            "title": fields["title"],
            "prompt": fields["prompt"],
            "kind": fields.get("kind", "general"),
            "status": "queued",
            "cwd": fields.get("cwd"),
            "repo_path": fields.get("repo_path"),
            "base_branch": fields.get("base_branch"),
            "verify_command": fields.get("verify_command"),
            "profile_id": fields.get("profile_id"),
            "integration_key": fields.get("integration_key"),
            "model": fields.get("model"),
            "max_turns": fields.get("max_turns"),
            "schedule_id": fields.get("schedule_id"),
            "parent_task_id": fields.get("parent_task_id"),
            "worktree_path": fields.get("worktree_path"),
            "branch": fields.get("branch"),
            "created_at": utcnow(),
        }
        placeholders = ", ".join(f":{k}" for k in cols)
        await db.execute(f"INSERT INTO tasks ({', '.join(cols)}) VALUES ({placeholders})", cols)
        task = await self.get_task(task_id)
        assert task is not None
        await bus.emit_task_event(task_id, "status_change", {"from": None, "to": "queued"})
        bus.publish_global("task_upsert", task)
        if task["kind"] == "chat":
            # Chats bypass the queue and the concurrency budget: they idle in
            # waiting_input between messages and shouldn't starve real tasks.
            await self._launch(task_id)
            return await self.get_task(task_id) or task
        self._dispatch_wakeup.set()
        return task

    async def get_task(self, task_id: str) -> dict[str, Any] | None:
        return row_to_dict(await db.fetch_one(
            "SELECT t.*, p.color AS agent_color, p.icon AS agent_icon, p.name AS agent_name"
            " FROM tasks t LEFT JOIN agent_profiles p ON p.id = t.profile_id WHERE t.id = ?",
            (task_id,),
        ))

    async def _dispatch_loop(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._dispatch_wakeup.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
            self._dispatch_wakeup.clear()
            if self._shutting_down:
                return
            def _busy() -> int:
                return sum(1 for rt in self.running.values() if rt.kind != "chat")
            while _busy() < settings.max_concurrent:
                row = await db.fetch_one(
                    "SELECT id FROM tasks WHERE status='queued' AND kind != 'chat'"
                    " ORDER BY created_at LIMIT 1"
                )
                if row is None:
                    break
                await self._launch(row["id"])

    async def _launch(self, task_id: str) -> None:
        from .runner import AgentRunner

        if task_id in self.running:
            return
        task = await self.get_task(task_id)
        if task is None or task["status"] != "queued":
            return
        # Transition synchronously BEFORE spawning: the dispatch loop re-selects
        # queued tasks, so leaving the DB status stale here double-launches.
        await self.transition(task_id, "running")
        task = await self.get_task(task_id)
        runner = AgentRunner(task)
        aio_task = asyncio.create_task(self._run_wrapper(task_id, runner), name=f"task-{task_id[:8]}")
        rt = RunningTask(task_id, aio_task, kind=task["kind"])
        rt.runner = runner
        runner.running_task = rt
        self.running[task_id] = rt

    async def _run_wrapper(self, task_id: str, runner: Any) -> None:
        try:
            await runner.run()
        except asyncio.CancelledError:
            await self._safe_transition(task_id, "cancelled")
            raise
        except Exception as exc:  # noqa: BLE001 — task failures must never kill the dispatcher
            log.exception("Task %s crashed", task_id)
            await self._fail(task_id, f"{type(exc).__name__}: {exc}")
        finally:
            self.running.pop(task_id, None)
            self._dispatch_wakeup.set()

    # -- transitions ---------------------------------------------------------

    async def transition(self, task_id: str, new_status: str, **extra: Any) -> None:
        task = await self.get_task(task_id)
        if task is None:
            raise ValueError(f"Unknown task {task_id}")
        current = task["status"]
        if new_status not in VALID_TRANSITIONS.get(current, set()):
            raise ValueError(f"Invalid transition {current} -> {new_status} for task {task_id}")

        sets = ["status = :status"]
        params: dict[str, Any] = {"status": new_status, "id": task_id}
        if new_status == "running" and task["started_at"] is None:
            sets.append("started_at = :started_at")
            params["started_at"] = utcnow()
        if new_status in ("done", "failed", "cancelled"):
            sets.append("finished_at = :finished_at")
            params["finished_at"] = utcnow()
        for key in ("error", "result_summary", "session_id"):
            if key in extra:
                sets.append(f"{key} = :{key}")
                params[key] = extra[key]
        await db.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = :id", params)

        await bus.emit_task_event(task_id, "status_change", {"from": current, "to": new_status, **extra})
        updated = await self.get_task(task_id)
        if updated:
            bus.publish_global("task_upsert", updated)
            if new_status in ("done", "failed", "cancelled"):
                from .memory import add_episode

                await add_episode(updated)

    async def _safe_transition(self, task_id: str, new_status: str, **extra: Any) -> None:
        try:
            await self.transition(task_id, new_status, **extra)
        except ValueError:
            pass  # already terminal

    async def _fail(self, task_id: str, error: str) -> None:
        await self._safe_transition(task_id, "failed", error=error)

    # -- cancel --------------------------------------------------------------

    async def cancel(self, task_id: str) -> bool:
        task = await self.get_task(task_id)
        if task is None or task["status"] not in ACTIVE_STATUSES:
            return False
        if task["status"] == "queued":
            await self.transition(task_id, "cancelled")
            return True
        rt = self.running.get(task_id)
        if rt is None:
            await self._safe_transition(task_id, "cancelled")
            return True
        rt.cancel_requested = True

        from .approvals import broker

        broker.deny_pending_for_task(task_id, "Task cancelled by operator", interrupt=True)
        if rt.runner is not None:
            await rt.runner.request_interrupt()
        try:
            await asyncio.wait_for(asyncio.shield(rt.aio_task), timeout=15)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001
            rt.aio_task.cancel()
        await self._safe_transition(task_id, "cancelled")
        return True


manager = TaskManager()
