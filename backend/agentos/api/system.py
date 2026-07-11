import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import __version__
from ..auth import require_master, require_token
from ..db import db
from ..integrations import _DEFAULT_MODEL, INTEGRATION_SLOTS, TOKEN_HINTS, IntegrationError, dispatch, dispatch_messages, get_config, is_slot, launch_login, login_status, probe, save_config, slot_kind, slot_transports

router = APIRouter()
log = logging.getLogger(__name__)


def _slot_runtime(kind: str) -> str:
    """Runtime LABEL for an integration by its connection kind. Codex (oauth) and
    Ollama (local) run on THIS machine, so they read as local; hosted APIs and
    SSH bridges are remote. This is a display/classification label only — Codex is
    still dispatched via the one-shot integration path (gated on integration_key,
    not on this label)."""
    return "local" if kind in ("oauth", "local") else "remote"


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
    from ..lease import lease

    data = _readiness()
    try:
        data["dispatcher"] = await lease.describe()  # localhost pid/role only — no secret
    except Exception:  # noqa: BLE001 — readiness is the desktop boot gate and must be
        # 'ok in every state'; a DB error mid-shutdown or under a write-lock must
        # degrade, never 500 the endpoint the shell polls before a token exists.
        log.warning("lease.describe() failed in readiness; degrading", exc_info=True)
        data["dispatcher"] = {"held": None, "holder_pid": None, "since": None,
                              "alive": False, "error": "unavailable"}
    return data


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


class SecurityBody(BaseModel):
    allow_insecure_lan: bool


@router.get("/api/system/network", dependencies=[Depends(require_token)])
async def network_status() -> dict:
    """Current bind + LAN-exposure policy state. bind host is fixed at startup, so
    `effective_host`/`downgraded` reflect the RUNNING server while
    `allow_insecure_lan` reflects the (live) override — a mismatch means a toggle
    was flipped and takes effect on the next restart."""
    from ..config import bind_state, insecure_lan_allowed

    st = bind_state()
    return {
        "allow_insecure_lan": insecure_lan_allowed(),
        "requested_host": st["requested"],
        "effective_host": st["effective"],
        "downgraded": st["downgraded"],
        "warning": st["warning"],
    }


@router.post("/api/system/security", dependencies=[Depends(require_master)])
async def security_set(body: SecurityBody) -> dict:
    """Persist the LAN-access override (security:allow_insecure_lan). Does NOT rebind
    a running server — the bind host is fixed at startup — so this takes effect on
    the next restart. Returns the same shape as GET /api/system/network."""
    import json

    from ..config import SECURITY_LAN_KEY

    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (SECURITY_LAN_KEY, json.dumps(bool(body.allow_insecure_lan))),
    )
    return await network_status()


class AutostartBody(BaseModel):
    enable: bool
    host: str | None = None  # bind for the boot service: 127.0.0.1 or 0.0.0.0


@router.get("/api/system/autostart", dependencies=[Depends(require_master)])
async def autostart_status() -> dict:
    from .. import autostart

    return await autostart.status()


@router.post("/api/system/autostart", dependencies=[Depends(require_master)])
async def autostart_apply(body: AutostartBody) -> dict:
    """Opt-in boot-level autostart. Install/uninstall each raise ONE Windows
    admin (UAC) prompt on the machine — that consent dialog is the real gate."""
    from .. import autostart

    if body.enable:
        host = body.host or "0.0.0.0"
        if host not in ("127.0.0.1", "0.0.0.0"):
            raise HTTPException(422, "host must be 127.0.0.1 or 0.0.0.0")
        result = await autostart.install(host)
    else:
        result = await autostart.uninstall()
    return {**result, "status": await autostart.status()}


class IntegrationBody(BaseModel):
    enabled: bool | None = None  # None preserves the stored on/off state (partial PUTs)
    endpoint: str = ""
    token: str | None = None  # blank/None preserves the stored token
    model: str = ""
    notes: str | None = None  # None preserves stored notes
    ssh: str = ""  # bridge slots only — "user@host[:port]" tunnel/CLI destination
    transport: str | None = None  # clamped server-side to the slot's legal set; None preserves


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
        key = slot["key"]
        cfg = await get_config(key)
        cfg["has_token"] = bool(cfg.pop("token", ""))  # never leak the secret
        # kind + legal transports drive which fields the UIs render per slot
        out.append({**slot, **cfg, "kind": slot_kind(key), "transports": slot_transports(key),
                    "default_model": _DEFAULT_MODEL.get(key, ""), "token_hint": TOKEN_HINTS.get(key, "")})
    return out


@router.put("/api/integrations/{key}", dependencies=[Depends(require_master)])
async def save_integration(key: str, body: IntegrationBody) -> dict:
    if not is_slot(key):
        raise HTTPException(404, "unknown integration slot")
    await save_config(key, enabled=body.enabled, endpoint=body.endpoint, model=body.model,
                      notes=body.notes, token=body.token, ssh=body.ssh, transport=body.transport)
    return {"ok": True}


@router.post("/api/integrations/{key}/login", dependencies=[Depends(require_master)])
async def login_integration(key: str) -> dict:
    """Start the hidden browser sign-in for an OAuth slot (Codex/Gemini). The
    vendor CLI runs windowless in the background and opens the sign-in page in
    the browser; poll GET …/login until done."""
    if not is_slot(key):
        raise HTTPException(404, "unknown integration slot")
    try:
        return await launch_login(key)
    except IntegrationError as exc:
        raise HTTPException(422, str(exc))


@router.get("/api/integrations/{key}/login", dependencies=[Depends(require_master)])
async def login_integration_status(key: str) -> dict:
    """Progress of a running sign-in: {running, done, ok, url, detail}."""
    if not is_slot(key):
        raise HTTPException(404, "unknown integration slot")
    return login_status(key)


@router.post("/api/integrations/{key}/test", dependencies=[Depends(require_master)])
async def test_integration(key: str) -> dict:
    """Live connectivity + auth check (opens the SSH tunnel first if configured)."""
    if not is_slot(key):
        raise HTTPException(404, "unknown integration slot")
    return await probe(key)


@router.post("/api/integrations/{key}/dispatch", dependencies=[Depends(require_master)])
async def dispatch_integration(key: str, body: DispatchBody) -> dict:
    """Send a prompt/mission to the runtime and return its reply."""
    if not is_slot(key):
        raise HTTPException(404, "unknown integration slot")
    try:
        return await dispatch(key, body.prompt)
    except IntegrationError as exc:
        raise HTTPException(422, str(exc))


@router.post("/api/integrations/{key}/chat", dependencies=[Depends(require_master)])
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
        # a remote-brained crew member routes by profile_id alone — the runner
        # resolves its integration, so persona + memory stay with the profile
        brain = (p["integration_key"] or "").strip()
        # a profile is only as remote as its brain — a persona brained to a LOCAL
        # integration (Codex/Ollama) runs locally; unbrained personas are local Claude
        runtime = _slot_runtime(slot_kind(brain)) if brain else "local"
        agents.append({
            "id": p["id"], "name": p["name"], "kind": "claude", "runtime": runtime,
            "profile_id": p["id"], "integration_key": None, "brain": brain or None,
            "model": p["model"] or "", "role": p["role"] or "", "icon": p["icon"] or "◆",
            "color": p["color"] or "#7fc8ff", "description": p["description"] or "", "available": True,
        })
    for slot in INTEGRATION_SLOTS:
        cfg = await get_config(slot["key"])
        if not cfg.get("enabled"):
            continue
        # a bare key/local connection isn't an agent — it only joins the roster
        # once a model is set on its card (recruits are the real way to staff it)
        if slot_kind(slot["key"]) in ("api", "local") and not (cfg.get("model") or "").strip():
            continue
        agents.append({
            "id": "integration:" + slot["key"], "name": slot["name"], "kind": "integration", "runtime": _slot_runtime(slot_kind(slot["key"])),
            "profile_id": None, "integration_key": slot["key"],
            "model": cfg.get("model") or "", "role": slot["blurb"], "icon": slot["icon"],
            "color": "#34e2ff", "description": slot["blurb"], "available": cfg.get("last_status") != "unreachable",
        })
    return agents
