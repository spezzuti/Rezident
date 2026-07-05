"""Phase 6 E2E: schedule CRUD, run_now fires a task, tick computes next_run_at."""

import asyncio
import json
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
TOKEN = (BACKEND / ".env").read_text().strip().split("=", 1)[1]
BASE = "http://127.0.0.1:8734"


def rest(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())


async def main() -> int:
    # Invalid cron rejected
    bad_rejected = False
    try:
        rest("POST", "/api/schedules", {"name": "bad", "cron_expr": "not a cron", "prompt": "x"})
    except urllib.error.HTTPError as e:
        bad_rejected = e.code == 422
    print(f"invalid cron rejected: {bad_rejected}")

    s = rest("POST", "/api/schedules", {
        "name": "scheduler smoke",
        "cron_expr": "0 3 * * *",
        "prompt": "Without using tools, reply with exactly: scheduled-run-ok",
    })
    sid = s["id"]

    fired = rest("POST", f"/api/schedules/{sid}/run_now")
    tid = fired["task_id"]
    print(f"run_now fired task {tid}")

    for _ in range(40):
        await asyncio.sleep(3)
        task = rest("GET", f"/api/tasks/{tid}")
        if task["status"] in ("done", "failed", "cancelled"):
            break
    ran_ok = task["status"] == "done" and "scheduled-run-ok" in (task.get("result_summary") or "")
    print(f"scheduled task ran: {ran_ok} (status={task['status']})")

    await asyncio.sleep(32)  # one scheduler tick
    s2 = next(x for x in rest("GET", "/api/schedules") if x["id"] == sid)
    next_set = bool(s2["next_run_at"]) and bool(s2["last_run_at"]) and s2["last_task_id"] == tid
    print(f"next_run_at={s2['next_run_at']} last_task_id ok: {s2['last_task_id'] == tid}")

    rest("DELETE", f"/api/schedules/{sid}")
    gone = all(x["id"] != sid for x in rest("GET", "/api/schedules"))
    print(f"deleted: {gone}")

    ok = bad_rejected and ran_ok and next_set and gone
    print(f"\nE2E SCHEDULER {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


import urllib.error  # noqa: E402

raise SystemExit(asyncio.run(main()))
