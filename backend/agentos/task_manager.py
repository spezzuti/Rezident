"""TaskManager: queue, lifecycle state machine, asyncio task ownership.

The kanban board and Mission Control are driven purely by the event stream —
every status transition is validated here, persisted to tasks.status, emitted
as a per-task `status_change` event, and mirrored as a global task summary.
"""

import asyncio
import json
import logging
import os
import uuid
from typing import Any

import aiosqlite

from .config import settings
from .db import db, row_to_dict
from .events import bus, utcnow
from .schemas import ACTIVE_STATUSES

log = logging.getLogger(__name__)


async def task_is_active(task_id: str) -> bool:
    """True iff the task row exists and is currently in an ACTIVE status.

    A worker calls this to notice it was moved out of an active state by ANOTHER
    process — a cancel POSTed to a standby (#3) or the lease-takeover orphan sweep
    (#2) — so it can self-abort instead of burning paid spend on work whose durable
    row is already terminal. ACTIVE_STATUSES covers queued/running/awaiting_approval/
    waiting_input/verifying, so a task legitimately mid-run reads active and lives.

    Fail SAFE on a read error: a transient 'database is locked' must NOT abort a
    healthy run — assume active and let the next self-check (a few seconds later)
    reconsider. Killing a good task on an uncertain read is the one outcome this
    whole mechanism exists to avoid."""
    try:
        row = await db.fetch_one("SELECT status FROM tasks WHERE id = ?", (task_id,))
    except Exception:  # noqa: BLE001 — a read hiccup must never trigger a self-abort
        return True
    return row is not None and row["status"] in ACTIVE_STATUSES

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
        # The orphan sweep + first drain are lease-gated: only the dispatch holder
        # may fail another process's tasks or claim queued work. on_acquire covers
        # every LATER False->True; if we already hold at boot (lease.start ran
        # first, before on_acquire was wired) sweep once here — no double-sweep.
        from .lease import lease

        lease.on_acquire = self._on_lease_acquired
        self._dispatcher = asyncio.create_task(self._dispatch_loop(), name="task-dispatcher")
        if lease.held:
            # Boot path: lease.start() acquired before on_acquire was wired (so its
            # own retry machinery disarmed with no callback). Run the sweep once,
            # directly, and let it fail LOUD — a broken DB at startup should abort
            # the boot, not leave a half-initialized dispatcher limping. The
            # retriable-callback path (lease._callback_pending) guards the RUNTIME
            # takeover case, where the renewal loop must survive a transient error.
            await self._on_lease_acquired()

    async def _on_lease_acquired(self) -> None:
        await self._mark_orphans()
        self._dispatch_wakeup.set()

    async def shutdown(self) -> None:
        self._shutting_down = True
        if self._dispatcher:
            self._dispatcher.cancel()
        # Resolve any pending approvals with deny so can_use_tool callbacks
        # unwind instead of hanging the SDK client forever.
        from .approvals import broker

        broker.deny_all_pending("Rezident is shutting down")
        for rt in list(self.running.values()):
            rt.cancel_requested = True
            rt.aio_task.cancel()
        if self.running:
            await asyncio.gather(*(rt.aio_task for rt in self.running.values()), return_exceptions=True)

    async def _mark_orphans(self) -> None:
        """Tasks left active by a PREVIOUS process are unrecoverable (one live
        client per task) — mark them failed; their session_id allows manual retry.

        This sweep now fires on EVERY lease takeover (via on_acquire), not only at
        boot — so it must never fail work THIS process is currently running. Tasks
        in self.running (and their pending approvals) are excluded: that set holds
        our live tasks AND our chats, which bypass the lease gate by design and are
        genuinely alive here. At boot self.running is empty, so the exclusion is a
        no-op and this behaves exactly as the original full sweep."""
        # Stamp the sweep start BEFORE reading anything: a task that goes live during
        # the sweep (a chat launch, or a drain that flips queued->running after the
        # fetch below) records started_at >= sweep_start via _launch's COALESCE stamp,
        # so the guard on the UPDATE can tell it apart from a genuine orphan.
        sweep_start = utcnow()
        own = list(self.running)
        status_ph = ",".join("?" * len(ACTIVE_STATUSES))
        # NOT IN () is a SQL syntax error in SQLite — only append the clause when we
        # actually have running ids to exclude (the boot/empty case skips it cleanly).
        own_ph = ",".join("?" * len(own))
        task_sql = f"SELECT id FROM tasks WHERE status IN ({status_ph})"
        task_params: list = list(ACTIVE_STATUSES)
        if own:
            task_sql += f" AND id NOT IN ({own_ph})"
            task_params += own
        rows = await db.fetch_all(task_sql, task_params)
        # Re-snapshot self.running immediately before the writes: the fetch above and
        # each UPDATE below await, so a task can become live in between. own_now skips
        # anything already registered locally; the started_at guard is the durable
        # backstop for the narrow window where _launch has flipped the DB row to
        # running (stamping started_at) but not yet inserted into self.running — that
        # row's started_at >= sweep_start so it is left alone, while a genuine orphan
        # from a dead instance (started before this sweep, or a NULL-started queued
        # leftover) is still failed. If we lose the race and _launch's queued->running
        # UPDATE lands after our fail, its `WHERE status='queued'` finds 'failed' and
        # no-ops, so no live worker is ever left behind.
        own_now = set(self.running)
        for row in rows:
            if row["id"] in own_now:
                continue
            won = await db.execute_returning(
                "UPDATE tasks SET status='failed', error='orphaned by backend restart', finished_at=?"
                " WHERE id=? AND (started_at IS NULL OR started_at < ?) RETURNING id",
                (utcnow(), row["id"], sweep_start),
            )
            if won is not None:
                log.warning("Marked orphaned task %s as failed", row["id"])
        appr_sql = (
            "UPDATE approvals SET status='cancelled', deny_reason='orphaned by backend restart',"
            " resolved_at=? WHERE status='pending'"
        )
        appr_params: list = [utcnow()]
        if own:
            appr_sql += f" AND task_id NOT IN ({own_ph})"
            appr_params += own
        await db.execute(appr_sql, tuple(appr_params))

    # -- creation / dispatch -------------------------------------------------

    async def create_task(self, fields: dict[str, Any]) -> dict[str, Any] | None:
        """Insert a queued task and return it. Returns None ONLY on the scheduled-
        occurrence idempotency path: when `scheduled_for` collides with an already-
        fired (schedule_id, scheduled_for) on the partial unique index, the row
        already exists (a prior fire committed it before crashing), so we report
        "no new task". Only scheduler.fire()/start_dream() pass scheduled_for, so no
        other caller can hit the None path — every existing caller that consumes the
        returned dict is unaffected."""
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
            "scheduled_for": fields.get("scheduled_for"),
            "parent_task_id": fields.get("parent_task_id"),
            "worktree_path": fields.get("worktree_path"),
            "branch": fields.get("branch"),
            # Roundtable participants+rounds ride as a JSON blob (NULL for every other
            # kind). A caller may hand us the pydantic dump (a dict) or an already-
            # serialized string — normalize to text either way.
            "roundtable": _encode_roundtable(fields.get("roundtable")),
            "created_at": utcnow(),
        }
        placeholders = ", ".join(f":{k}" for k in cols)
        try:
            await db.execute(f"INSERT INTO tasks ({', '.join(cols)}) VALUES ({placeholders})", cols)
        except aiosqlite.IntegrityError:
            # This (schedule_id, scheduled_for) occurrence already fired — a previous
            # fire committed the task INSERT, then crashed before advancing the
            # schedule's next_run_at, and this is the replay. NOT fatal: no second
            # paid run is created; the caller (scheduler.fire) still advances the
            # clock. Non-scheduled tasks carry scheduled_for=NULL and are exempt from
            # the partial index, so they can never reach this branch.
            log.info(
                "occurrence already fired (schedule_id=%s scheduled_for=%s) — skipping duplicate task",
                fields.get("schedule_id"), fields.get("scheduled_for"),
            )
            return None
        task = await self.get_task(task_id)
        assert task is not None
        await bus.emit_task_event(task_id, "status_change", {"from": None, "to": "queued"})
        bus.publish_global("task_upsert", task)
        if task["kind"] in ("chat", "roundtable"):
            # Chats and roundtables bypass the queue and the concurrency budget:
            # both idle in waiting_input between messages (a roundtable parks for the
            # moderator between round-batches) and shouldn't starve real tasks.
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
            # A raise out of _drain_queue (a transient DB error, an event-persist
            # failure, a runner-construction exception) must NOT kill the dispatcher —
            # that would silently wedge ALL queued work while the app still looks
            # healthy. Log it, back off briefly so a persistent fault can't hot-loop,
            # and keep draining. (Except Exception spares CancelledError, so shutdown
            # still cancels the loop cleanly.)
            try:
                await self._drain_queue()
            except Exception:  # noqa: BLE001 — the dispatcher must survive any drain error
                log.exception("dispatch drain failed; backing off and continuing")
                await asyncio.sleep(1.0)

    async def _drain_queue(self) -> None:
        # Only the dispatch-lease holder claims queued work; a standby still
        # creates/reads/finishes tasks and serves chats (chats bypass the queue),
        # it just never launches queued tasks against the shared DB.
        from .lease import lease

        if not lease.held:
            return

        def _busy() -> int:
            return sum(1 for rt in self.running.values() if rt.kind not in ("chat", "roundtable"))
        while _busy() < settings.max_concurrent:
            # Re-check the lease INSIDE the loop: a holder that loses the lease
            # mid-drain (heartbeat went stale, another instance took over) must stop
            # launching new paid runs immediately, not finish draining the batch it
            # started while it still held. Each _launch awaits, so the lease can flip
            # between iterations.
            if not lease.held:
                return
            row = await db.fetch_one(
                "SELECT id FROM tasks WHERE status='queued' AND kind NOT IN ('chat', 'roundtable')"
                " ORDER BY created_at LIMIT 1"
            )
            if row is None:
                break
            await self._launch(row["id"])

    async def _launch(self, task_id: str) -> None:
        # Test seam (ONE branch): AGENTOS_TEST_NOOP_RUNNER swaps in a zero-cost
        # runner with the same surface (__init__(task), running_task, run()).
        if os.environ.get("AGENTOS_TEST_NOOP_RUNNER") == "1":
            from .testing import NoopRunner as Runner
        else:
            from .runner import AgentRunner as Runner

        if task_id in self.running:
            return
        # Belt-and-suspenders atomic claim: only the writer that flips queued->
        # running proceeds. The lease already serializes the dispatcher, but a
        # chat launch racing the drain (or any second live loop) must never
        # double-launch one task. This is transition(task_id,'running') for the
        # queued->running edge, done conditionally — so its side effects
        # (status_change event + global task_upsert) are mirrored by hand below.
        now = utcnow()
        row = await db.execute_returning(
            "UPDATE tasks SET status='running', started_at=COALESCE(started_at, :now)"
            " WHERE id=:id AND status='queued' RETURNING id",
            {"id": task_id, "now": now},
        )
        if row is None:
            return  # not queued (already claimed / gone) — another writer won
        await bus.emit_task_event(task_id, "status_change", {"from": "queued", "to": "running"})
        task = await self.get_task(task_id)
        if task is None:
            return
        bus.publish_global("task_upsert", task)
        runner = Runner(task)
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
        params: dict[str, Any] = {"status": new_status, "id": task_id, "expected": current}
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
        # Compare-and-swap: only the writer that finds the task STILL in `current`
        # (the status we just validated against) commits the transition. Two callers
        # racing the same terminal edge — e.g. a cancel() and the runner's completion,
        # both validating against 'running' — would otherwise both write a terminal
        # state and both emit status_change/task_upsert/add_episode, double-firing the
        # side effects and leaving a task shown 'done' despite being cancelled. If the
        # UPDATE touches no row another writer already moved it out of `current`, so we
        # lost the race: return WITHOUT emitting any event, push, or episode. Mirrors
        # the atomic queued->running claim in _launch. _safe_transition/_fail already
        # tolerate a no-op here (they only swallowed the ValueError from the pre-check).
        won = await db.execute_returning(
            f"UPDATE tasks SET {', '.join(sets)} WHERE id = :id AND status = :expected RETURNING id",
            params,
        )
        if won is None:
            return

        await bus.emit_task_event(task_id, "status_change", {"from": current, "to": new_status, **extra})
        updated = await self.get_task(task_id)
        if updated:
            bus.publish_global("task_upsert", updated)
            if new_status in ("done", "failed") and not updated["title"].startswith("⚙ "):
                # Orchestrator stage tasks are titled "⚙ <pipeline> · N/M …"
                # (orchestrator.py:54). Suppress their per-stage finish push so a
                # pipeline run notifies ONCE at the run level, not per stage.
                from . import notify
                notify.fire("finish", updated["title"], new_status)  # opt-in "task finished" push
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
        # Model watch: a failure carrying the CLI's model-unavailability signature
        # stands that model's companions down (they vanish from the rosters for a
        # retry window). Cheap regex pre-check — DB lookups only on a real match.
        from . import model_watch

        if model_watch.is_unavailability_error(error):
            try:
                task = await self.get_task(task_id)
                model = (task or {}).get("model") or ""
                if not model and (task or {}).get("profile_id"):
                    row = await db.fetch_one(
                        "SELECT model FROM agent_profiles WHERE id = ?", (task["profile_id"],)
                    )
                    model = (row["model"] if row else "") or ""
                await model_watch.note_failure(model, error)
            except Exception:  # noqa: BLE001 — bookkeeping must never break teardown
                pass

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
            # We don't own this task's live worker locally — it's active on ANOTHER
            # process (e.g. the lease holder while this is a standby). We move the
            # durable row to cancelled here; the remote worker's own throttled
            # self-check (runner._should_stop / task_is_active) sees it left
            # ACTIVE_STATUSES and aborts there. So returning True is honest: the task
            # IS being cancelled, just by the owner in response to this DB write.
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

    # -- delete --------------------------------------------------------------

    async def delete_task(self, task_id: str) -> bool:
        """Hard-delete a terminal task and everything hanging off it. Returns False
        when the task is still in an ACTIVE status — the API turns that into a 409:
        an active task owns a live worker (and its worktree) and must be cancelled
        first. A row that's already gone returns True (idempotent).

        No ON DELETE CASCADE exists, so task_events and approvals are removed by hand
        before the task row. Worktree cleanup is best-effort: a locked directory
        (Windows: node_modules, a running process) must never fail the delete — the
        rows go regardless and the leftover directory can be cleared by hand."""
        task = await self.get_task(task_id)
        if task is None:
            return True
        if task["status"] in ACTIVE_STATUSES:
            return False
        await db.execute("DELETE FROM task_events WHERE task_id = ?", (task_id,))
        await db.execute("DELETE FROM approvals WHERE task_id = ?", (task_id,))
        await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        if task.get("worktree_path"):
            from . import worktree

            try:
                await worktree.remove_worktree(task, delete_branch=True)
            except Exception:  # noqa: BLE001 — a locked worktree dir must never fail the delete
                log.warning("worktree cleanup failed for deleted task %s (leftover dir?)", task_id)
        return True


def _encode_roundtable(raw: Any) -> str | None:
    """Normalize a roundtable config into the JSON text stored on the task row.
    A dict (the pydantic RoundtableConfig dump) is serialized; an already-JSON
    string is passed through; None/empty stays NULL so non-roundtable tasks store
    nothing. Never raises — a malformed value degrades to NULL."""
    if raw is None:
        return None
    if isinstance(raw, str):
        return raw.strip() or None
    try:
        return json.dumps(raw)
    except (TypeError, ValueError):
        return None


manager = TaskManager()
