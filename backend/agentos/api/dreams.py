import json
import uuid

from croniter import croniter
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import require_token
from ..db import db
from ..dreams import start_dream
from ..events import utcnow

router = APIRouter(prefix="/api/dreams", dependencies=[Depends(require_token)])


def _row(r) -> dict:
    d = dict(r)
    for key in ("actions", "applied"):
        try:
            d[key] = json.loads(d.get(key) or "[]")
        except (TypeError, json.JSONDecodeError):
            d[key] = []
    return d


@router.get("")
async def list_dreams(limit: int = 30) -> list[dict]:
    rows = await db.fetch_all("SELECT * FROM dreams ORDER BY created_at DESC LIMIT ?", (limit,))
    return [_row(r) for r in rows]


@router.post("/run", status_code=201)
async def run_dream() -> dict:
    return await start_dream()


class ApplyBody(BaseModel):
    action_index: int


@router.post("/{dream_id}/apply")
async def apply_action(dream_id: str, body: ApplyBody) -> dict:
    row = await db.fetch_one("SELECT * FROM dreams WHERE id = ?", (dream_id,))
    if row is None:
        raise HTTPException(404, "dream not found")
    dream = _row(row)
    if body.action_index < 0 or body.action_index >= len(dream["actions"]):
        raise HTTPException(422, "no such action")
    if body.action_index in dream["applied"]:
        raise HTTPException(409, "already applied")

    action = dream["actions"][body.action_index]
    kind = action.get("type")
    now = utcnow()
    created = ""

    if kind == "schedule":
        if not croniter.is_valid(action.get("cron", "")):
            raise HTTPException(422, f"invalid cron in suggestion: {action.get('cron')!r}")
        await db.execute(
            "INSERT INTO schedules (id, name, cron_expr, task_template, enabled, overlap_policy, created_at)"
            " VALUES (?, ?, ?, ?, 1, 'skip', ?)",
            (str(uuid.uuid4()), action.get("name", "dreamed schedule"), action["cron"],
             json.dumps({"prompt": action.get("prompt", ""), "kind": "general"}), now),
        )
        created = f"schedule '{action.get('name')}'"
    elif kind == "rule":
        await db.execute(
            "INSERT INTO auto_approve_rules (id, tool_name, field, match_type, pattern, action, priority, description, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 'suggested by a simulation', ?)",
            (str(uuid.uuid4()), action.get("tool", "Bash"),
             action.get("field") or ("command" if action.get("tool", "Bash") == "Bash" else "file_path"),
             action.get("match_type", "prefix"), action.get("pattern", ""),
             action.get("action", "ask"), 20 if action.get("action") == "deny" else 80, now),
        )
        created = f"rule {action.get('action')} {action.get('pattern')!r}"
    elif kind == "agent":
        await db.execute(
            "INSERT INTO agent_profiles (id, name, description, system_prompt_append, allowed_tools, disallowed_tools,"
            " permission_mode, model, inject_memory, is_default, created_at, icon, color, role)"
            " VALUES (?, ?, 'recruited from a simulation', ?, '[]', '[]', 'default', ?, 1, 0, ?, '◆', '#818cf8', ?)",
            (str(uuid.uuid4()), action.get("name", "Dreamed Unit"), action.get("persona"),
             action.get("model"), now, action.get("role", "")),
        )
        created = f"companion '{action.get('name')}'"
    elif kind == "fact":
        await db.execute(
            "INSERT INTO memory_facts (id, content, tags, source, created_at, updated_at) VALUES (?, ?, 'dreamed', 'agent', ?, ?)",
            (str(uuid.uuid4()), action.get("content", ""), now, now),
        )
        created = "holotape fact"
    elif kind == "pipeline":
        stages = [
            {"name": s.get("name", f"Stage {i+1}"), "prompt": s.get("prompt", ""), "profile_id": None, "model": None, "kind": "general"}
            for i, s in enumerate(action.get("stages", []))
        ]
        await db.execute(
            "INSERT INTO pipelines (id, name, description, stages, created_at, updated_at) VALUES (?, ?, 'built from a simulation', ?, ?, ?)",
            (str(uuid.uuid4()), action.get("name", "Dreamed pipeline"), json.dumps(stages), now, now),
        )
        created = f"pipeline '{action.get('name')}'"
    else:
        raise HTTPException(422, f"unknown action type {kind!r}")

    dream["applied"].append(body.action_index)
    await db.execute("UPDATE dreams SET applied = ? WHERE id = ?", (json.dumps(dream["applied"]), dream_id))
    return {"ok": True, "created": created}
