from fastapi import APIRouter, Depends

from .. import __version__
from ..auth import require_token
from ..db import db

router = APIRouter()


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
