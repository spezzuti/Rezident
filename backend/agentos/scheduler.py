"""Cron scheduler: a 30-second asyncio loop firing task templates via croniter.

overlap_policy 'skip' refuses to fire while the schedule's previous task is
still active; 'queue' fires regardless (the task queue serializes execution).
"""

import asyncio
import json
import logging
from datetime import datetime, timezone

from croniter import croniter

from .db import db
from .events import utcnow
from .schemas import ACTIVE_STATUSES

log = logging.getLogger(__name__)

TICK_SECONDS = 30


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def next_fire(cron_expr: str, after: datetime) -> datetime:
    return croniter(cron_expr, after).get_next(datetime)


class Scheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="scheduler")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — scheduler must survive bad rows
                log.exception("scheduler tick failed")
            await asyncio.sleep(TICK_SECONDS)

    async def _tick(self) -> None:
        now = _now()
        rows = await db.fetch_all("SELECT * FROM schedules WHERE enabled = 1")
        for row in rows:
            schedule = dict(row)
            if not croniter.is_valid(schedule["cron_expr"]):
                log.warning("schedule %s has invalid cron %r", schedule["id"], schedule["cron_expr"])
                continue
            if not schedule["next_run_at"]:
                await db.execute(
                    "UPDATE schedules SET next_run_at = ? WHERE id = ?",
                    (_iso(next_fire(schedule["cron_expr"], now)), schedule["id"]),
                )
                continue
            if _parse(schedule["next_run_at"]) > now:
                continue
            await self.fire(schedule, scheduled=True)

    async def fire(self, schedule: dict, scheduled: bool = False) -> dict | None:
        from .task_manager import manager

        if scheduled and schedule["overlap_policy"] == "skip" and schedule.get("last_task_id"):
            prev = await manager.get_task(schedule["last_task_id"])
            if prev and prev["status"] in ACTIVE_STATUSES:
                log.info("schedule %s skipped (previous run still active)", schedule["name"])
                await db.execute(
                    "UPDATE schedules SET next_run_at = ? WHERE id = ?",
                    (_iso(next_fire(schedule["cron_expr"], _now())), schedule["id"]),
                )
                return None

        template = json.loads(schedule["task_template"] or "{}")
        if template.get("dream"):
            from .dreams import start_dream

            result = await start_dream()
            await db.execute(
                "UPDATE schedules SET last_run_at = ?, last_task_id = ?, next_run_at = ? WHERE id = ?",
                (utcnow(), result["task_id"], _iso(next_fire(schedule["cron_expr"], _now())), schedule["id"]),
            )
            return None
        stamp = datetime.now().strftime("%m/%d %H:%M")
        task = await manager.create_task({
            "title": f"⏰ {schedule['name']} — {stamp}"[:200],
            "prompt": template.get("prompt", schedule["name"]),
            "kind": template.get("kind", "general"),
            "cwd": template.get("cwd"),
            "repo_path": template.get("repo_path"),
            "base_branch": template.get("base_branch"),
            "verify_command": template.get("verify_command"),
            "profile_id": template.get("profile_id"),
            "schedule_id": schedule["id"],
        })
        await db.execute(
            "UPDATE schedules SET last_run_at = ?, last_task_id = ?, next_run_at = ? WHERE id = ?",
            (utcnow(), task["id"], _iso(next_fire(schedule["cron_expr"], _now())), schedule["id"]),
        )
        return task


scheduler = Scheduler()
