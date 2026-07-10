"""Chunk C — durable worker self-check (#3 + #2).

A worker must abort promptly when its task is moved out of an active status by
ANOTHER process — a cancel POSTed to a standby (#3) or the lease-takeover orphan
sweep (#2). task_is_active() is the durable read; the NoopRunner (and the real
AgentRunner via _should_stop) polls it and self-aborts WITHOUT stamping a result,
so a cancelled task's row is never overwritten to done.

Standalone (the project ships no pytest): run with the venv python

    backend/.venv/Scripts/python.exe backend/tests/test_worker_selfcheck.py
"""

import asyncio
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ -> import agentos.*

os.environ["AGENTOS_TEST_NOOP_RUNNER"] = "1"

from agentos.config import settings  # noqa: E402
from agentos.db import db  # noqa: E402
from agentos.events import utcnow  # noqa: E402
from agentos.schemas import ACTIVE_STATUSES, TERMINAL_STATUSES  # noqa: E402
from agentos.task_manager import manager, task_is_active  # noqa: E402


async def _fresh_db():
    tmp = tempfile.mkdtemp(prefix="selfcheck-")
    settings.data_dir = Path(tmp)
    if db._conn is not None:
        await db.close()
    await db.connect()
    return tmp


# ---- unit: task_is_active across every status --------------------------------

async def test_task_is_active_matrix():
    tmp = await _fresh_db()
    try:
        for i, status in enumerate(ACTIVE_STATUSES + TERMINAL_STATUSES):
            await db.execute(
                "INSERT INTO tasks (id, title, prompt, status, created_at) VALUES (?,?,?,?,?)",
                (f"t{i}", "T", "P", status, utcnow()),
            )
            active = await task_is_active(f"t{i}")
            assert active == (status in ACTIVE_STATUSES), f"{status}: task_is_active={active}"
        assert await task_is_active("does-not-exist") is False, "a missing task is not active"
    finally:
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---- single-process: a cross-coroutine cancel makes the worker self-abort -----

async def test_worker_self_aborts_on_cancel():
    tmp = await _fresh_db()
    os.environ["AGENTOS_TEST_RUN_SECONDS"] = "5"  # long run: plenty of poll intervals
    try:
        # create + launch a NoopRunner task directly (no dispatcher/lease needed —
        # _launch does the atomic queued->running claim itself)
        task = await manager.create_task({"title": "long noop", "prompt": "noop", "kind": "general"})
        await manager._launch(task["id"])
        assert task["id"] in manager.running, "task launched into a live worker"

        await asyncio.sleep(0.3)  # let the runner enter its poll loop
        assert (await manager.get_task(task["id"]))["status"] == "running"

        # Another coroutine (standing in for another process) cancels the task by
        # moving its durable row to cancelled.
        cancelled_at = time.monotonic()
        await manager.transition(task["id"], "cancelled")

        # The worker's cooperative self-check must notice within a poll interval and
        # exit — WITHOUT stamping a result_summary (which would prove it kept running).
        for _ in range(50):  # up to ~5s, but should be well under 1s
            if task["id"] not in manager.running:
                break
            await asyncio.sleep(0.1)
        elapsed = time.monotonic() - cancelled_at
        assert task["id"] not in manager.running, "worker must exit after the remote cancel"
        assert elapsed < 2.0, f"worker must abort within a poll interval, took {elapsed:.2f}s"

        row = await manager.get_task(task["id"])
        assert row["status"] == "cancelled", f"row must STAY cancelled, not be overwritten: {row['status']}"
        assert not row.get("result_summary"), \
            f"a self-aborted worker must not stamp a result: {row.get('result_summary')!r}"
    finally:
        os.environ.pop("AGENTOS_TEST_RUN_SECONDS", None)
        for rt in list(manager.running.values()):  # never leak a live worker into the next test
            rt.aio_task.cancel()
        await db.close()
        shutil.rmtree(tmp, ignore_errors=True)


TESTS = [
    test_task_is_active_matrix,
    test_worker_self_aborts_on_cancel,
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
