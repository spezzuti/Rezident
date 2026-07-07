from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import __version__
from ..auth import require_token
from ..db import db
from ..integrations import INTEGRATION_SLOTS, IntegrationError, dispatch, dispatch_messages, get_config, is_slot, probe, save_config

router = APIRouter()


@router.get("/api/health")
async def health() -> dict:
    """Unauthenticated liveness probe."""
    return {"status": "ok", "version": __version__}


@router.get("/api/readiness")
async def readiness() -> dict:
    """Unauthenticated first-run dependency gate: is claude present + signed in,
    is Git Bash available, etc. Deliberately token-free so the desktop shell can
    show an actionable checklist before a token exists."""
    from ..environment import readiness as _readiness

    return _readiness()


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
    token: str | None = None  # blank/None preserves the stored token
    model: str = ""
    notes: str = ""
    ssh: str = ""  # optional "user@host[:port]" for a tunneled remote runtime
    transport: str | None = None  # "openai" (HTTP) | "hermes-cli" (SSH); None preserves


class DispatchBody(BaseModel):
    prompt: str


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatBody(BaseModel):
    messages: list[ChatMessage]


@router.get("/api/integrations", dependencies=[Depends(require_token)])
async def list_integrations() -> list[dict]:
    out = []
    for slot in INTEGRATION_SLOTS:
        cfg = await get_config(slot["key"])
        cfg["has_token"] = bool(cfg.pop("token", ""))  # never leak the secret
        out.append({**slot, **cfg})
    return out


@router.put("/api/integrations/{key}", dependencies=[Depends(require_token)])
async def save_integration(key: str, body: IntegrationBody) -> dict:
    if not is_slot(key):
        raise HTTPException(404, "unknown integration slot")
    await save_config(key, enabled=body.enabled, endpoint=body.endpoint, model=body.model,
                      notes=body.notes, token=body.token, ssh=body.ssh, transport=body.transport)
    return {"ok": True}


@router.post("/api/integrations/{key}/test", dependencies=[Depends(require_token)])
async def test_integration(key: str) -> dict:
    """Live connectivity + auth check (opens the SSH tunnel first if configured)."""
    if not is_slot(key):
        raise HTTPException(404, "unknown integration slot")
    return await probe(key)


@router.post("/api/integrations/{key}/dispatch", dependencies=[Depends(require_token)])
async def dispatch_integration(key: str, body: DispatchBody) -> dict:
    """Send a prompt/mission to the runtime and return its reply."""
    if not is_slot(key):
        raise HTTPException(404, "unknown integration slot")
    try:
        return await dispatch(key, body.prompt)
    except IntegrationError as exc:
        raise HTTPException(422, str(exc))


@router.post("/api/integrations/{key}/chat", dependencies=[Depends(require_token)])
async def chat_integration(key: str, body: ChatBody) -> dict:
    """Multi-turn: send a full message history and return the runtime's next reply.
    Powers the GRID//OS IRC relay's live DM channels (history kept client-side)."""
    if not is_slot(key):
        raise HTTPException(404, "unknown integration slot")
    try:
        return await dispatch_messages(key, [m.model_dump() for m in body.messages])
    except IntegrationError as exc:
        raise HTTPException(422, str(exc))


@router.get("/api/agents", dependencies=[Depends(require_token)])
async def list_agents() -> list[dict]:
    """Unified roster — local Claude personas + enabled external integrations in
    one shape, so any theme can offer 'pick any agent' everywhere (deploy, chat,
    pipelines). Selecting one with integration_key routes execution to that
    runtime; otherwise it's local Claude with profile_id."""
    agents: list[dict] = []
    for p in await db.fetch_all("SELECT * FROM agent_profiles ORDER BY is_default DESC, name"):
        agents.append({
            "id": p["id"], "name": p["name"], "kind": "claude", "runtime": "local",
            "profile_id": p["id"], "integration_key": None,
            "model": p["model"] or "", "role": p["role"] or "", "icon": p["icon"] or "◆",
            "color": p["color"] or "#7fc8ff", "description": p["description"] or "", "available": True,
        })
    for slot in INTEGRATION_SLOTS:
        cfg = await get_config(slot["key"])
        if not cfg.get("enabled"):
            continue
        agents.append({
            "id": "integration:" + slot["key"], "name": slot["name"], "kind": "integration", "runtime": "remote",
            "profile_id": None, "integration_key": slot["key"],
            "model": cfg.get("model") or "", "role": slot["blurb"], "icon": slot["icon"],
            "color": "#34e2ff", "description": slot["blurb"], "available": cfg.get("last_status") != "unreachable",
        })
    return agents
