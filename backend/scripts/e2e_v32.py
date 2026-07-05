"""V3.2 E2E: robot companions, dream structured actions + one-tap apply."""

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
    names = {p["name"] for p in profiles}
    robots_ok = {"Securitron", "Eyebot", "Mister Handy", "Curie", "Liberty Prime"}.issubset(names)
    print(f"robot companions: {robots_ok} ({sorted(names)})")

    rest("POST", "/api/dreams/run")
    for _ in range(150):
        await asyncio.sleep(3)
        d = rest("GET", "/api/dreams")[0]
        if d["status"] in ("complete", "failed"):
            break
    actions = d.get("actions", [])
    prose_clean = "```json" not in (d.get("content") or "")
    print(f"dream: {d['status']}, {len(actions)} actions parsed, prose free of json block: {prose_clean}")
    for a in actions[:5]:
        print(f"  - {a.get('type')}: {a.get('name') or a.get('pattern') or (a.get('content') or '')[:50]}")

    applied_ok = False
    if actions:
        # apply the first non-destructive action type we find
        idx = next((i for i, a in enumerate(actions) if a.get("type") in ("fact", "schedule", "rule", "pipeline", "agent")), None)
        if idx is not None:
            res = rest("POST", f"/api/dreams/{d['id']}/apply", {"action_index": idx})
            print(f"applied action {idx}: {res['created']}")
            d2 = rest("GET", "/api/dreams")[0]
            applied_ok = idx in d2.get("applied", [])
            # double-apply must 409
            try:
                rest("POST", f"/api/dreams/{d['id']}/apply", {"action_index": idx})
                dup_blocked = False
            except urllib.error.HTTPError as e:
                dup_blocked = e.code == 409
            print(f"applied recorded: {applied_ok}, duplicate blocked: {dup_blocked}")
            applied_ok = applied_ok and dup_blocked

    ok = robots_ok and d["status"] == "complete" and len(actions) > 0 and prose_clean and applied_ok
    print(f"\nE2E V3.2 {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


import urllib.error  # noqa: E402

raise SystemExit(asyncio.run(main()))
