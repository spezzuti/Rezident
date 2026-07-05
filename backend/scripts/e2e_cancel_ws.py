"""Phase 1 E2E part 2: WS replay-then-tail + cancel mid-run.

Creates a slow task, watches its stream over the real WebSocket (connecting
AFTER the task started, to prove replay works), cancels mid-run, and checks
the terminal status plus zero zombie claude processes.
"""

import asyncio
import json
import sys
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
TOKEN = (BACKEND / ".env").read_text().strip().split("=", 1)[1]
BASE = "http://127.0.0.1:8734"


def rest(method: str, path: str, body: dict | None = None) -> dict | list:
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())


def claude_proc_count() -> int:
    import subprocess
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "(Get-Process claude -ErrorAction SilentlyContinue | Measure-Object).Count"],
        capture_output=True, text=True,
    )
    return int(out.stdout.strip() or 0)


async def main() -> int:
    baseline = claude_proc_count()
    task = rest("POST", "/api/tasks", {
        "title": "cancel target",
        "prompt": "Count slowly: run the bash command 'sleep 2' ten times in a row, "
                  "one at a time, reporting progress between each.",
    })
    task_id = task["id"]
    print(f"created {task_id}")
    await asyncio.sleep(8)  # let it get going before we even connect

    try:
        import websockets
    except ImportError:
        print("installing websockets…")
        import subprocess
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "websockets"], check=True)
        import websockets

    async with websockets.connect(f"ws://127.0.0.1:8734/ws?token={TOKEN}") as ws:
        await ws.send(json.dumps({"subscribe": ["global", f"task:{task_id}"]}))
        cancelled = False
        seqs: list[int] = []
        try:
            async with asyncio.timeout(60):
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("channel") == f"task:{task_id}":
                        seqs.append(msg["seq"])
                    if len(seqs) >= 6 and not cancelled:
                        print(f"streamed {len(seqs)} events; cancelling…")
                        rest("POST", f"/api/tasks/{task_id}/cancel")
                        cancelled = True
                    if msg.get("type") == "status_change" and msg["payload"].get("to") in ("cancelled", "failed", "done"):
                        print(f"terminal status via WS: {msg['payload']['to']}")
                        break
        except TimeoutError:
            print("TIMEOUT waiting for terminal status")
        monotonic = all(b > a for a, b in zip(seqs, seqs[1:]))
        # Replay proof: task ran 8s before we connected, so if the stream is
        # complete-from-the-start, the first seq we saw must be 1.
        got_replay = bool(seqs) and seqs[0] == 1
        print(f"seqs monotonic: {monotonic}, replay-from-seq-1: {got_replay} ({len(seqs)} events)")

    await asyncio.sleep(5)
    final = rest("GET", f"/api/tasks/{task_id}")
    print(f"final status: {final['status']}")

    # This Claude Code session itself runs claude.exe, so compare against the
    # pre-task baseline instead of expecting zero.
    delta = claude_proc_count() - baseline
    print(f"claude.exe process delta vs baseline: {delta:+d}")

    ok = final["status"] == "cancelled" and monotonic and got_replay and delta <= 0
    print("E2E CANCEL+WS", "PASS" if ok else "FAIL")
    return 0 if ok else 1


raise SystemExit(asyncio.run(main()))
