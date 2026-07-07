"""Pipeline orchestrator: runs a pipeline's stages as chained agent tasks.

Each stage is {name, prompt, profile_id?, model?, kind?, repo_path?, cwd?,
verify_command?}. The previous stage's result is appended to the next stage's
prompt, so a Research → Draft → Review chain actually passes work along.
Progress streams to the UI as global `pipeline_update` events.
"""

import asyncio
import json
import logging
import uuid

from .db import db
from .events import bus, utcnow

log = logging.getLogger(__name__)

POLL_SECONDS = 2
HANDOFF_HEADER = "\n\n--- Output from previous stage ({name}) ---\n"


class Orchestrator:
    def __init__(self) -> None:
        self.active: dict[str, asyncio.Task] = {}

    async def start_run(self, pipeline: dict, input_text: str = "") -> dict:
        stages = json.loads(pipeline["stages"] or "[]")
        if not stages:
            raise ValueError("pipeline has no stages")
        run_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO pipeline_runs (id, pipeline_id, status, stage_count, input, started_at)"
            " VALUES (?, ?, 'running', ?, ?, ?)",
            (run_id, pipeline["id"], len(stages), input_text, utcnow()),
        )
        self.active[run_id] = asyncio.create_task(
            self._run(run_id, pipeline, stages, input_text), name=f"pipeline-{run_id[:8]}"
        )
        await self._publish(run_id)
        return {"run_id": run_id}

    async def _run(self, run_id: str, pipeline: dict, stages: list[dict], input_text: str) -> None:
        from .task_manager import manager

        task_ids: list[str] = []
        carry = input_text
        try:
            for index, stage in enumerate(stages):
                prompt = stage.get("prompt", "").strip() or stage.get("name", "continue")
                if carry:
                    prompt += HANDOFF_HEADER.format(name=stages[index - 1]["name"] if index else "operator input") + carry
                task = await manager.create_task({
                    "title": f"⚙ {pipeline['name']} · {index + 1}/{len(stages)} {stage.get('name', '')}"[:200],
                    "prompt": prompt,
                    "kind": stage.get("kind", "general"),
                    "cwd": stage.get("cwd"),
                    "repo_path": stage.get("repo_path"),
                    "base_branch": stage.get("base_branch"),
                    "verify_command": stage.get("verify_command"),
                    "profile_id": stage.get("profile_id"),
                    "integration_key": stage.get("integration_key"),
                    "model": stage.get("model"),
                })
                task_ids.append(task["id"])
                await db.execute(
                    "UPDATE pipeline_runs SET current_stage = ?, task_ids = ? WHERE id = ?",
                    (index, json.dumps(task_ids), run_id),
                )
                await self._publish(run_id)

                while True:
                    await asyncio.sleep(POLL_SECONDS)
                    current = await manager.get_task(task["id"])
                    if current and current["status"] in ("done", "failed", "cancelled"):
                        break
                if current["status"] != "done":
                    await self._finish(run_id, "failed",
                                       f"stage {index + 1} ({stage.get('name')}) {current['status']}:"
                                       f" {current.get('error') or 'no detail'}")
                    return
                carry = current.get("result_summary") or ""
            await self._finish(run_id, "done", None)
        except asyncio.CancelledError:
            await self._finish(run_id, "cancelled", "orchestrator stopped")
            raise
        except Exception as exc:  # noqa: BLE001 — a bad stage must not kill the app
            log.exception("pipeline run %s crashed", run_id)
            await self._finish(run_id, "failed", f"{type(exc).__name__}: {exc}")
        finally:
            self.active.pop(run_id, None)

    async def _finish(self, run_id: str, status: str, error: str | None) -> None:
        await db.execute(
            "UPDATE pipeline_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?",
            (status, error, utcnow(), run_id),
        )
        await self._publish(run_id)

    async def _publish(self, run_id: str) -> None:
        row = await db.fetch_one("SELECT * FROM pipeline_runs WHERE id = ?", (run_id,))
        if row:
            d = dict(row)
            d["task_ids"] = json.loads(d["task_ids"] or "[]")
            bus.publish_global("pipeline_update", d)

    async def cancel_run(self, run_id: str) -> bool:
        task = self.active.get(run_id)
        if task is None:
            return False
        task.cancel()
        return True

    async def shutdown(self) -> None:
        for run_id, task in list(self.active.items()):
            task.cancel()


orchestrator = Orchestrator()
