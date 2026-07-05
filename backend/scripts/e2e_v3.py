"""V3 E2E: environment scan, integration slots, dreaming."""

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


async def test_environment() -> bool:
    env = rest("GET", "/api/system/environment")
    installed = [a for a in env["agents"] if a["installed"]]
    claude = next(a for a in env["agents"] if a["key"] == "claude")
    checklist_ok = all(c["ok"] for c in env["checklist"] if c["key"] in ("claude_cli", "claude_auth", "git_bash", "db"))
    print(f"detected {len(installed)} tools: {[a['key'] for a in installed]}")
    print(f"claude: {claude['version']} @ {claude['path']}")
    print(f"core checklist all green: {checklist_ok}")
    return claude["installed"] and checklist_ok


async def test_integrations() -> bool:
    slots = rest("GET", "/api/integrations")
    keys = {s["key"] for s in slots}
    ok = {"hermes", "openclaw", "redacted"}.issubset(keys)
    rest("PUT", "/api/integrations/redacted", {
        "enabled": True, "endpoint": "http://localhost:9999", "token": "test-secret", "notes": "reserved for redacted",
    })
    slots = rest("GET", "/api/integrations")
    redacted = next(s for s in slots if s["key"] == "redacted")
    saved = redacted["enabled"] and redacted["endpoint"] == "http://localhost:9999" and redacted["has_token"] and "token" not in redacted
    print(f"integration slots: {sorted(keys)}; redacted config saved (token write-only): {saved}")
    rest("PUT", "/api/integrations/redacted", {"enabled": False, "endpoint": "", "token": "", "notes": ""})
    return ok and saved


async def test_dream() -> bool:
    rest("POST", "/api/dreams/run")
    for _ in range(120):
        await asyncio.sleep(3)
        dreams = rest("GET", "/api/dreams")
        d = dreams[0]
        if d["status"] in ("complete", "failed"):
            break
    ok = d["status"] == "complete" and d["content"] and "## Suggestions" in d["content"]
    print(f"dream status: {d['status']} cost=${d['cost_usd']:.3f}")
    if d["content"]:
        print("dream excerpt:", d["content"][:300].replace("\n", " | "))
    return bool(ok)


async def main() -> int:
    results = {
        "environment": await test_environment(),
        "integrations": await test_integrations(),
        "dream": await test_dream(),
    }
    print()
    for k, v in results.items():
        print(f"  {k}: {'PASS' if v else 'FAIL'}")
    print(f"\nE2E V3 {'PASS' if all(results.values()) else 'FAIL'}")
    return 0 if all(results.values()) else 1


raise SystemExit(asyncio.run(main()))
