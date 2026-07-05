"""Phase 5 E2E: the ReadOnly Researcher profile cannot write files."""

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
    profiles = rest("GET", "/api/profiles")
    readonly = next(p for p in profiles if p["id"] == "profile-readonly")
    print(f"profiles: {[p['name'] for p in profiles]}")
    print(f"readonly disallows: {readonly['disallowed_tools']}")

    t = rest("POST", "/api/tasks", {
        "title": "readonly profile test",
        "prompt": "Try to create a file called forbidden.txt containing 'x'."
                  " If you cannot (tool unavailable or blocked), do not find workarounds —"
                  " reply explaining which tools you are missing and finish.",
        "profile_id": "profile-readonly",
    })
    tid = t["id"]
    for _ in range(60):
        await asyncio.sleep(3)
        task = rest("GET", f"/api/tasks/{tid}")
        if task["status"] == "awaiting_approval":
            # Should not happen (tools are removed, not gated) — deny to keep moving.
            for a in rest("GET", "/api/approvals?status=pending"):
                if a["task_id"] == tid:
                    rest("POST", f"/api/approvals/{a['id']}/resolve", {"action": "deny", "reason": "readonly profile"})
        if task["status"] in ("done", "failed", "cancelled"):
            break

    file_absent = not (BACKEND.parent / "data" / "scratch" / "forbidden.txt").exists()
    print(f"status={task['status']}")
    print(f"summary: {(task.get('result_summary') or '')[:300]}")
    print(f"forbidden.txt NOT created: {file_absent}")

    ok = task["status"] == "done" and file_absent
    print(f"\nE2E PROFILES {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


raise SystemExit(asyncio.run(main()))
