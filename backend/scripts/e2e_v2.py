"""V2 E2E: Pantheon seeds, chat session (multi-turn, stays alive), pipeline run."""

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


async def wait_status(tid: str, targets: tuple[str, ...], timeout=120):
    for _ in range(timeout // 2):
        await asyncio.sleep(2)
        t = rest("GET", f"/api/tasks/{tid}")
        if t["status"] in targets:
            return t
    raise TimeoutError(f"task {tid} never reached {targets}")


async def test_pantheon() -> bool:
    profiles = rest("GET", "/api/profiles")
    names = {p["name"] for p in profiles}
    ok = {"Mercury", "Athena", "Vulcan", "Standard"}.issubset(names)
    mercury = next(p for p in profiles if p["name"] == "Mercury")
    ok = ok and mercury["model"] == "haiku" and mercury["icon"] == "☿"
    print(f"pantheon seeded: {ok} ({sorted(names)})")
    return ok


async def test_chat() -> bool:
    chat = rest("POST", "/api/tasks", {
        "title": "☿ Mercury · smoke chat",
        "prompt": "Without using tools, reply with exactly: channel-open",
        "kind": "chat",
        "profile_id": "agent-mercury",
    })
    cid = chat["id"]
    t = await wait_status(cid, ("waiting_input", "failed", "cancelled"))
    first_ok = t["status"] == "waiting_input"
    print(f"chat first exchange -> {t['status']} (session alive: {first_ok})")

    rest("POST", f"/api/tasks/{cid}/message", {"text": "Now reply with exactly: second-message-ok"})
    t = await wait_status(cid, ("waiting_input", "failed", "cancelled"))
    events = rest("GET", f"/api/tasks/{cid}/events")
    texts = [e["payload"].get("text", "") for e in events if e["type"] == "assistant_text"]
    second_ok = t["status"] == "waiting_input" and any("second-message-ok" in x for x in texts)
    print(f"chat second exchange ok: {second_ok} (assistant said: {texts[-1] if texts else '?'})")

    rest("POST", f"/api/tasks/{cid}/cancel")
    t = await wait_status(cid, ("cancelled", "failed"))
    ended = t["status"] == "cancelled"
    print(f"chat ended cleanly: {ended}, cost accumulated: ${t['total_cost_usd']:.4f}")
    return first_ok and second_ok and ended and t["total_cost_usd"] > 0


async def test_pipeline() -> bool:
    p = rest("POST", "/api/pipelines", {
        "name": "smoke pipeline",
        "stages": [
            {"name": "Pick", "prompt": "Without tools: pick a single random fruit and reply with only its name."},
            {"name": "Rhyme", "prompt": "Without tools: write a one-line rhyme about the fruit named in the previous stage output. Reply with only the rhyme."},
        ],
    })
    run = rest("POST", f"/api/pipelines/{p['id']}/run", {"input": ""})
    run_id = run["run_id"]
    print(f"pipeline run {run_id}")
    for _ in range(90):
        await asyncio.sleep(3)
        runs = rest("GET", "/api/pipelines/runs/recent")
        r = next((x for x in runs if x["id"] == run_id), None)
        if r and r["status"] in ("done", "failed", "cancelled"):
            break
    print(f"run status: {r['status']} stages: {r['current_stage'] + 1}/{r['stage_count']} error: {r.get('error')}")
    ok = r["status"] == "done" and len(r["task_ids"]) == 2
    if ok:
        stage2 = rest("GET", f"/api/tasks/{r['task_ids'][1]}")
        print(f"stage 2 output: {stage2.get('result_summary')!r}")
        ok = bool(stage2.get("result_summary"))
    rest("DELETE", f"/api/pipelines/{p['id']}")
    return ok


async def main() -> int:
    results = {
        "pantheon": await test_pantheon(),
        "chat": await test_chat(),
        "pipeline": await test_pipeline(),
    }
    print()
    for k, v in results.items():
        print(f"  {k}: {'PASS' if v else 'FAIL'}")
    print(f"\nE2E V2 {'PASS' if all(results.values()) else 'FAIL'}")
    return 0 if all(results.values()) else 1


raise SystemExit(asyncio.run(main()))
