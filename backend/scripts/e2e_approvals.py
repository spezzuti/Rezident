"""Phase 2 E2E: the approval queue.

A) Gated call → task goes awaiting_approval → human approves → task completes.
B) Gated call → human denies with a reason → agent adapts and finishes anyway.
C) Rule-matched deny (git push --force) → auto_denied without human involvement.
"""

import asyncio
import json
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
TOKEN = (BACKEND / ".env").read_text().strip().split("=", 1)[1]
BASE = "http://127.0.0.1:8734"


def rest(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())


async def wait_for(predicate, timeout=120, interval=2, desc=""):
    for _ in range(int(timeout / interval)):
        result = predicate()
        if result:
            return result
        await asyncio.sleep(interval)
    raise TimeoutError(f"timed out waiting for {desc}")


def pending_for(task_id):
    return [a for a in rest("GET", "/api/approvals?status=pending") if a["task_id"] == task_id]


def status_of(task_id):
    return rest("GET", f"/api/tasks/{task_id}")["status"]


async def scenario_a() -> bool:
    t = rest("POST", "/api/tasks", {
        "title": "approval test A (approve)",
        "prompt": "Run exactly this bash command: mkdir approved_dir. Then confirm it exists with ls and finish.",
    })
    tid = t["id"]
    approval = (await wait_for(lambda: pending_for(tid), desc="pending approval A"))[0]
    print(f"A: approval queued: {approval['tool_name']} {approval['tool_input']}")
    st = status_of(tid)
    print(f"A: task status while pending: {st}")
    rest("POST", f"/api/approvals/{approval['id']}/resolve", {"action": "approve"})
    final = await wait_for(lambda: status_of(tid) in ("done", "failed", "cancelled") and status_of(tid), desc="A terminal")
    exists = (BACKEND.parent / "data" / "scratch" / "approved_dir").is_dir()
    print(f"A: final={final} dir_created={exists}")
    return st == "awaiting_approval" and final == "done" and exists


async def scenario_b() -> bool:
    t = rest("POST", "/api/tasks", {
        "title": "approval test B (deny)",
        "prompt": "Run exactly this bash command: mkdir denied_dir. If you are not allowed to, do NOT retry;"
                  " instead reply explaining what you were told and finish.",
    })
    tid = t["id"]
    approval = (await wait_for(lambda: pending_for(tid), desc="pending approval B"))[0]
    rest("POST", f"/api/approvals/{approval['id']}/resolve",
         {"action": "deny", "reason": "Denied: we do not create directories on Fridays."})
    final = await wait_for(lambda: status_of(tid) in ("done", "failed", "cancelled") and status_of(tid), desc="B terminal")
    task = rest("GET", f"/api/tasks/{tid}")
    adapted = "friday" in (task.get("result_summary") or "").lower()
    not_created = not (BACKEND.parent / "data" / "scratch" / "denied_dir").is_dir()
    print(f"B: final={final} agent_mentioned_reason={adapted} dir_not_created={not_created}")
    return final == "done" and not_created


async def scenario_c() -> bool:
    t = rest("POST", "/api/tasks", {
        "title": "approval test C (auto-deny rule)",
        "prompt": "Run exactly this bash command: git push --force origin main."
                  " If blocked, do not retry or work around it; just report what happened and finish.",
    })
    tid = t["id"]
    final = await wait_for(lambda: status_of(tid) in ("done", "failed", "cancelled") and status_of(tid), desc="C terminal")
    events = rest("GET", f"/api/tasks/{tid}/events")
    auto_denied = any(
        e["type"] == "approval_resolved" and e["payload"].get("resolution") == "auto_denied"
        for e in events
    )
    never_pended = not any(e["type"] == "approval_requested" for e in events)
    print(f"C: final={final} auto_denied={auto_denied} no_human_needed={never_pended}")
    return auto_denied and never_pended


async def main() -> int:
    results = {}
    results["A approve"] = await scenario_a()
    results["B deny"] = await scenario_b()
    results["C auto-deny"] = await scenario_c()
    print()
    for name, ok in results.items():
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")
    all_ok = all(results.values())
    print(f"\nE2E APPROVALS {'PASS' if all_ok else 'FAIL'}")
    return 0 if all_ok else 1


raise SystemExit(asyncio.run(main()))
