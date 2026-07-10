"""Test-only agent runner.

The AGENTOS_TEST_NOOP_RUNNER seam (task_manager._launch) swaps this in for the
real AgentRunner so lease/dispatch integration tests exercise the full task
lifecycle at zero Claude cost. It mirrors the surface TaskManager uses:
__init__(task), a running_task backref, and an async run() that finishes the task.
"""

import asyncio
import os
import time


class NoopRunner:
    def __init__(self, task: dict) -> None:
        self.task = task
        self.task_id: str = task["id"]
        self.running_task = None  # RunningTask backref, set by TaskManager

    async def run(self) -> None:
        from .schemas import ACTIVE_STATUSES
        from .task_manager import manager

        secs = float(os.environ.get("AGENTOS_TEST_RUN_SECONDS", "0.3"))
        # Cooperative self-check mirroring the real AgentRunner: instead of one flat
        # sleep, poll our own task row every ~0.1s and bail the moment it leaves
        # ACTIVE_STATUSES — i.e. another process cancelled it or the takeover orphan
        # sweep failed it. On an early bail we DELIBERATELY do not stamp
        # result_summary, so a test proves the worker aborted (the summary never
        # carries this process's pid). This gives the lease integration harness teeth
        # for the standby-cancel scenario. Long runs (> TTL) still let a test kill the
        # holder mid-flight.
        deadline = time.monotonic() + secs
        while time.monotonic() < deadline:
            await asyncio.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
            task = await manager.get_task(self.task_id)
            if task is None or task["status"] not in ACTIVE_STATUSES:
                return  # cancelled/failed elsewhere — self-abort without stamping
        await manager.transition(self.task_id, "done", result_summary=f"noop pid={os.getpid()}")
