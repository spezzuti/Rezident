"""Phase 4 E2E: a saved fact is visible to a fresh agent; episodes accumulate."""

import asyncio
import json
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
TOKEN = (BACKEND / ".env").read_text().strip().split("=", 1)[1]
BASE = "http://127.0.0.1:8734"

MAGIC = "the operator's favorite codeword is BLUEHERON42"


def rest(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())


async def main() -> int:
    fact = rest("POST", "/api/memory/facts", {"content": MAGIC})
    t = rest("POST", "/api/tasks", {
        "title": "memory recall test",
        "prompt": "Without using any tools: what is the operator's favorite codeword?"
                  " Reply with just the codeword.",
    })
    tid = t["id"]
    for _ in range(60):
        await asyncio.sleep(3)
        task = rest("GET", f"/api/tasks/{tid}")
        if task["status"] in ("done", "failed", "cancelled"):
            break
    recalled = "BLUEHERON42" in (task.get("result_summary") or "")
    print(f"status={task['status']} summary={task.get('result_summary')!r}")
    print(f"fact recalled by fresh agent: {recalled}")

    episodes = rest("GET", "/api/memory/episodes")
    has_episode = any(e["task_id"] == tid for e in episodes)
    print(f"episode recorded: {has_episode} ({len(episodes)} total)")

    rest("DELETE", f"/api/memory/facts/{fact['id']}")
    remaining = [f for f in rest("GET", "/api/memory/facts") if f["id"] == fact["id"]]
    print(f"fact deleted: {not remaining}")

    ok = task["status"] == "done" and recalled and has_episode and not remaining
    print(f"\nE2E MEMORY {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


raise SystemExit(asyncio.run(main()))
