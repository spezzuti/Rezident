"""Test-only agent runner.

The AGENTOS_TEST_NOOP_RUNNER seam (task_manager._launch) swaps this in for the
real AgentRunner so lease/dispatch integration tests exercise the full task
lifecycle at zero Claude cost. It mirrors the surface TaskManager uses:
__init__(task), a running_task backref, and an async run() that finishes the task.
"""

import asyncio
import os


class NoopRunner:
    def __init__(self, task: dict) -> None:
        self.task = task
        self.task_id: str = task["id"]
        self.running_task = None  # RunningTask backref, set by TaskManager

    async def run(self) -> None:
        from .task_manager import manager

        secs = float(os.environ.get("AGENTOS_TEST_RUN_SECONDS", "0.3"))
        await asyncio.sleep(secs)  # long runs (> TTL) let a test kill the holder mid-flight
        await manager.transition(self.task_id, "done", result_summary=f"noop pid={os.getpid()}")
