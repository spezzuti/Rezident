"""Chunk A — scheduled-occurrence idempotency (#4).

A crash between scheduler.fire()'s task-INSERT commit and its next_run_at-advance
commit would re-fire the SAME cron occurrence on restart -> a duplicate PAID task,
even with a single instance. The fix: fire() stamps the occurrence's next_run_at as
the task's `scheduled_for` and advances next_run_at LAST; a partial unique index on
(schedule_id, scheduled_for) makes the replay INSERT no-op (create_task returns None)
so the occurrence never fires twice.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_scheduler_idempotency.py
"""

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

os.environ["AGENTOS_TEST_NOOP_RUNNER"] = "1"  # zero-cost runner; no Claude, no money

from agentos.config import settings  # noqa: E402
from agentos.db import db  # noqa: E402
from agentos.scheduler import scheduler  # noqa: E402

DUE = "2000-01-01T00:00:00.000Z"  # a long-past occurrence so next_fire always moves forward


async def _fresh_db():
    tmp = tempfile.mkdtemp(prefix="sched-idem-")
    settings.data_dir = Path(tmp)
    if db._conn is not None:
        await db.close()
    await db.connect()
    return tmp


async def _seed_schedule(sid: str, template: str = "{}", next_run_at: str = DUE) -> dict:
    await db.execute(
        "INSERT INTO schedules (id, name, cron_expr, task_template, enabled, overlap_policy, next_run_at)"
        " VALUES (?,?,?,?,1,'queue',?)",
        (sid, f"sched-{sid}", "* * * * *", template, next_run_at),
    )
    return dict(await db.fetch_one("SELECT * FROM schedules WHERE id=?", (sid,)))


async def _count_occurrence(sid: str, scheduled_for: str) -> int:
    row = await db.fetch_one(
        "SELECT COUNT(*) AS n FROM tasks WHERE schedule_id=? AND scheduled_for=?", (sid, scheduled_for)
    )
    return row["n"]


# ---- (i) crash-replay is idempotent -----------------------------------------

async def test_crash_replay_no_duplicate():
    tmp = await _fresh_db()
    try:
        await _seed_schedule("s1")

        # Crash simulation: the next_run_at-advance UPDATE raises AFTER the task
        # INSERT has already committed, exactly reproducing a mid-fire crash.
        orig_execute = db.execute

        async def crashing_execute(sql, params=()):
            if "UPDATE schedules SET last_run_at" in sql:
                raise RuntimeError("simulated crash before advancing next_run_at")
            return await orig_execute(sql, params)

        db.execute = crashing_execute  # type: ignore[assignment]
        try:
            row = dict(await db.fetch_one("SELECT * FROM schedules WHERE id='s1'"))
            try:
                await scheduler.fire(row, scheduled=False)
            except RuntimeError:
                pass  # the crash we injected
        finally:
            db.execute = orig_execute  # type: ignore[assignment]

        assert await _count_occurrence("s1", DUE) == 1, "the pre-crash fire created exactly one task"
        sched = await db.fetch_one("SELECT next_run_at FROM schedules WHERE id='s1'")
        assert sched["next_run_at"] == DUE, "crash left next_run_at un-advanced (still the due occurrence)"

        # Restart replay: re-read the (un-advanced) schedule and fire the SAME
        # occurrence again. create_task must hit the unique index and no-op.
        row2 = dict(await db.fetch_one("SELECT * FROM schedules WHERE id='s1'"))
        replay = await scheduler.fire(row2, scheduled=False)
        assert replay is None, "the replay must NOT create a second paid task"
        assert await _count_occurrence("s1", DUE) == 1, "still exactly ONE task for the occurrence after replay"
        sched2 = await db.fetch_one("SELECT next_run_at FROM schedules WHERE id='s1'")
        assert sched2["next_run_at"] != DUE, "replay still advances next_run_at so the schedule moves on"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- (ii) concurrent double-fire yields one task ----------------------------

async def test_concurrent_double_fire_single_task():
    tmp = await _fresh_db()
    try:
        await _seed_schedule("s2")
        row = dict(await db.fetch_one("SELECT * FROM schedules WHERE id='s2'"))

        # Two fires racing the SAME schedule snapshot (same due) — e.g. a duplicated
        # tick. The atomic INSERT + unique index lets exactly one win.
        results = await asyncio.gather(
            scheduler.fire(dict(row), scheduled=False),
            scheduler.fire(dict(row), scheduled=False),
            return_exceptions=True,
        )
        for r in results:
            assert not isinstance(r, Exception), f"a losing fire must return None, not raise: {r!r}"
        created = [r for r in results if r is not None]
        assert len(created) == 1, f"exactly one fire creates a task, got {len(created)}"
        assert await _count_occurrence("s2", DUE) == 1, "exactly one task exists for the occurrence"
        sched = await db.fetch_one("SELECT next_run_at FROM schedules WHERE id='s2'")
        assert sched["next_run_at"] != DUE, "next_run_at advanced past the consumed occurrence"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- (iii) a genuinely different occurrence still fires ----------------------

async def test_different_occurrence_still_fires():
    tmp = await _fresh_db()
    try:
        await _seed_schedule("s3")

        row1 = dict(await db.fetch_one("SELECT * FROM schedules WHERE id='s3'"))
        t1 = await scheduler.fire(row1, scheduled=False)
        assert t1 is not None, "first occurrence fires"

        # next_run_at has advanced to a NEW occurrence — firing it must create a
        # second, distinct task (the guard only blocks the same occurrence).
        row2 = dict(await db.fetch_one("SELECT * FROM schedules WHERE id='s3'"))
        assert row2["next_run_at"] != DUE
        t2 = await scheduler.fire(row2, scheduled=False)
        assert t2 is not None, "a different next occurrence still creates a task"

        assert t1["id"] != t2["id"], "the two occurrences are distinct tasks"
        total = await db.fetch_one("SELECT COUNT(*) AS n FROM tasks WHERE schedule_id='s3'")
        assert total["n"] == 2, f"two distinct occurrences -> two tasks, got {total['n']}"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- (iv) dream branch is idempotent too -------------------------------------

async def test_dream_branch_crash_replay_no_duplicate():
    tmp = await _fresh_db()
    try:
        await _seed_schedule("s4", template='{"dream": true}')

        orig_execute = db.execute

        async def crashing_execute(sql, params=()):
            if "UPDATE schedules SET last_run_at" in sql:
                raise RuntimeError("simulated crash before advancing next_run_at")
            return await orig_execute(sql, params)

        db.execute = crashing_execute  # type: ignore[assignment]
        try:
            row = dict(await db.fetch_one("SELECT * FROM schedules WHERE id='s4'"))
            try:
                await scheduler.fire(row, scheduled=False)
            except RuntimeError:
                pass
        finally:
            db.execute = orig_execute  # type: ignore[assignment]

        assert await _count_occurrence("s4", DUE) == 1, "the dream fire created exactly one task"

        row2 = dict(await db.fetch_one("SELECT * FROM schedules WHERE id='s4'"))
        await scheduler.fire(row2, scheduled=False)  # replay
        assert await _count_occurrence("s4", DUE) == 1, "dream replay creates no duplicate task"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


TESTS = [
    test_crash_replay_no_duplicate,
    test_concurrent_double_fire_single_task,
    test_different_occurrence_still_fires,
    test_dream_branch_crash_replay_no_duplicate,
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
