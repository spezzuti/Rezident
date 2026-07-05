import json

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import __version__
from ..auth import require_token
from ..db import db

router = APIRouter()

INTEGRATION_SLOTS = [
    {"key": "hermes", "name": "Hermes", "icon": "⚚", "blurb": "Jack Roberts' agent runtime — bridge tasks & personas"},
    {"key": "openclaw", "name": "OpenClaw", "icon": "🦞", "blurb": "Browser-operating agent — hand off web missions"},
    {"key": "redacted", "name": "redacted", "icon": "Ⓜ", "blurb": "Reserved slot for your redacted integration"},
]


@router.get("/api/health")
async def health() -> dict:
    """Unauthenticated liveness probe."""
    return {"status": "ok", "version": __version__}


@router.get("/api/auth/check", dependencies=[Depends(require_token)])
async def auth_check() -> dict:
    """Used by the login page to validate a token before storing it."""
    return {"ok": True}


@router.get("/api/stats", dependencies=[Depends(require_token)])
async def stats() -> dict:
    by_status = {
        row["status"]: row["n"]
        for row in await db.fetch_all("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
    }
    today = await db.fetch_one(
        "SELECT COALESCE(SUM(total_cost_usd),0) AS cost, COALESCE(SUM(input_tokens),0) AS inp,"
        " COALESCE(SUM(output_tokens),0) AS outp FROM tasks WHERE created_at >= date('now')"
    )
    week = await db.fetch_one(
        "SELECT COALESCE(SUM(total_cost_usd),0) AS cost FROM tasks WHERE created_at >= date('now','-6 days')"
    )
    return {
        "tasks_by_status": by_status,
        "cost_today_usd": today["cost"] if today else 0,
        "tokens_today": {"input": today["inp"] if today else 0, "output": today["outp"] if today else 0},
        "cost_week_usd": week["cost"] if week else 0,
    }


@router.get("/api/system/environment", dependencies=[Depends(require_token)])
async def environment(force: bool = False) -> dict:
    from ..environment import scan

    return await scan(force=force)


class IntegrationBody(BaseModel):
    enabled: bool = False
    endpoint: str = ""
    token: str = ""
    notes: str = ""


@router.get("/api/integrations", dependencies=[Depends(require_token)])
async def list_integrations() -> list[dict]:
    out = []
    for slot in INTEGRATION_SLOTS:
        row = await db.fetch_one("SELECT value FROM settings WHERE key = ?", (f"integration:{slot['key']}",))
        config = json.loads(row["value"]) if row else {"enabled": False, "endpoint": "", "token": "", "notes": ""}
        config["has_token"] = bool(config.pop("token", ""))
        out.append({**slot, **config})
    return out


@router.put("/api/integrations/{key}", dependencies=[Depends(require_token)])
async def save_integration(key: str, body: IntegrationBody) -> dict:
    if key not in {s["key"] for s in INTEGRATION_SLOTS}:
        from fastapi import HTTPException

        raise HTTPException(404, "unknown integration slot")
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (f"integration:{key}", json.dumps(body.model_dump())),
    )
    return {"ok": True}
