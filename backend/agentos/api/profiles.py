import json
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from fastapi.responses import FileResponse

from ..auth import require_master, require_token
from ..db import db
from ..events import utcnow
from ..homes import delete_home, home_stats, list_home, read_preview, resolve_file

# Read routes stay require_token (board views work on the phone); create/update/
# delete are master-only.
router = APIRouter(prefix="/api/profiles", dependencies=[Depends(require_token)])


class ProfileBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str | None = None
    system_prompt_append: str | None = None
    allowed_tools: list[str] = []
    disallowed_tools: list[str] = []
    knowledge_base_ids: list[str] = []
    permission_mode: Literal["default", "acceptEdits", "plan", "dontAsk"] = "default"
    model: str | None = None
    max_turns: int | None = None
    inject_memory: bool = True
    is_default: bool = False
    icon: str = "◆"
    color: str = "#7fc8ff"
    role: str = ""
    # the agent's brain: None = local Claude (full tool access); an integration
    # key = remote-brained crew member running over that connection
    integration_key: str | None = None


def _brain(body: ProfileBody) -> str | None:
    """Validate the brain selection: a real slot or local (None)."""
    from ..integrations import is_slot

    key = (body.integration_key or "").strip() or None
    if key and not is_slot(key):
        raise HTTPException(422, f"unknown integration '{key}' for this agent's brain")
    if key and body.is_default:
        raise HTTPException(422, "a remote-brained agent can't be the default — the default handles local work")
    return key


def _row(r) -> dict:
    d = dict(r)
    d["allowed_tools"] = json.loads(d["allowed_tools"] or "[]")
    d["disallowed_tools"] = json.loads(d["disallowed_tools"] or "[]")
    d["knowledge_base_ids"] = json.loads(d["knowledge_base_ids"] or "[]")
    return d


@router.get("")
async def list_profiles() -> list[dict]:
    from ..model_watch import unavailable_models

    gone = await unavailable_models()
    out = []
    for r in await db.fetch_all("SELECT * FROM agent_profiles ORDER BY created_at"):
        d = _row(r)
        # a companion whose model has left the subscription vanishes gracefully —
        # nothing is deleted; it rejoins on its own once the retry window passes
        if (d.get("model") or "") in gone:
            continue
        d["home"] = home_stats(d["id"])
        out.append(d)
    return out


# What travels in a crew file: the PERSONA. Machine-local state stays home —
# ids (regenerated), is_default (the destination has its own), knowledge-base
# ids (they name this machine's indexes), homes, memories.
_CREW_FIELDS = ["name", "description", "system_prompt_append", "allowed_tools",
                "disallowed_tools", "permission_mode", "model", "max_turns",
                "inject_memory", "icon", "color", "role", "integration_key"]


@router.get("/export", dependencies=[Depends(require_master)])
async def export_profiles() -> dict:
    """The whole cabinet as a portable crew file (persona fields only)."""
    profiles = []
    for r in await db.fetch_all("SELECT * FROM agent_profiles ORDER BY created_at"):
        d = _row(r)
        profiles.append({k: d.get(k) for k in _CREW_FIELDS})
    return {"rezident_crew": 1, "exported_at": utcnow(), "profiles": profiles}


class CrewFile(BaseModel):
    rezident_crew: int = 1
    profiles: list[dict] = Field(default_factory=list, max_length=200)


@router.post("/import", dependencies=[Depends(require_master)])
async def import_profiles(body: CrewFile) -> dict:
    """Recruit companions from a crew file. Existing names are skipped (never
    overwritten); unknown brains are skipped with the reason; everything else
    goes through the same validation as a hand-recruited companion."""
    existing = {
        (r["name"] or "").lower()
        for r in await db.fetch_all("SELECT name FROM agent_profiles")
    }
    imported: list[str] = []
    skipped: list[dict] = []
    for raw in body.profiles:
        name = str(raw.get("name") or "").strip()
        if not name:
            skipped.append({"name": "(unnamed)", "reason": "no name"})
            continue
        if name.lower() in existing:
            skipped.append({"name": name, "reason": "already on the roster"})
            continue
        data = {k: raw.get(k) for k in _CREW_FIELDS if raw.get(k) is not None}
        data["name"] = name
        data["is_default"] = False  # the destination keeps its own default
        try:
            prof = ProfileBody(**data)
            brain = _brain(prof)
        except HTTPException as exc:
            skipped.append({"name": name, "reason": str(exc.detail)})
            continue
        except Exception as exc:  # noqa: BLE001 — one bad entry never sinks the file
            skipped.append({"name": name, "reason": f"invalid: {str(exc)[:120]}"})
            continue
        profile_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO agent_profiles (id, name, description, system_prompt_append, allowed_tools,"
            " disallowed_tools, permission_mode, model, max_turns, inject_memory, is_default, created_at,"
            " icon, color, role, integration_key, knowledge_base_ids)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, '[]')",
            (profile_id, prof.name, prof.description, prof.system_prompt_append,
             json.dumps(prof.allowed_tools), json.dumps(prof.disallowed_tools),
             prof.permission_mode, prof.model, prof.max_turns, int(prof.inject_memory),
             utcnow(), prof.icon, prof.color, prof.role, brain),
        )
        existing.add(name.lower())
        imported.append(name)
    return {"imported": imported, "skipped": skipped}


@router.get("/{profile_id}/home")
async def profile_home(profile_id: str) -> dict:
    row = await db.fetch_one("SELECT id FROM agent_profiles WHERE id = ?", (profile_id,))
    if row is None:
        raise HTTPException(404, "profile not found")
    return list_home(profile_id)


async def _require_profile(profile_id: str) -> None:
    if await db.fetch_one("SELECT id FROM agent_profiles WHERE id = ?", (profile_id,)) is None:
        raise HTTPException(404, "profile not found")


@router.get("/{profile_id}/home/file")
async def profile_home_file(profile_id: str, path: str) -> dict:
    """Inline preview of one home file (text capped, binaries flagged)."""
    await _require_profile(profile_id)
    try:
        return read_preview(profile_id, path)
    except ValueError:
        raise HTTPException(400, "invalid path")
    except FileNotFoundError:
        raise HTTPException(404, "file not found")


@router.get("/{profile_id}/home/download")
async def profile_home_download(profile_id: str, path: str) -> FileResponse:
    """Raw download of one home file (any type/size)."""
    await _require_profile(profile_id)
    try:
        p = resolve_file(profile_id, path)
    except ValueError:
        raise HTTPException(400, "invalid path")
    except FileNotFoundError:
        raise HTTPException(404, "file not found")
    return FileResponse(p, filename=p.name)


@router.post("", status_code=201, dependencies=[Depends(require_master)])
async def create_profile(body: ProfileBody) -> dict:
    brain = _brain(body)
    profile_id = str(uuid.uuid4())
    if body.is_default:
        await db.execute("UPDATE agent_profiles SET is_default = 0")
    await db.execute(
        "INSERT INTO agent_profiles (id, name, description, system_prompt_append, allowed_tools,"
        " disallowed_tools, permission_mode, model, max_turns, inject_memory, is_default, created_at,"
        " icon, color, role, integration_key, knowledge_base_ids)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (profile_id, body.name, body.description, body.system_prompt_append,
         json.dumps(body.allowed_tools), json.dumps(body.disallowed_tools),
         body.permission_mode, body.model, body.max_turns,
         int(body.inject_memory), int(body.is_default), utcnow(),
         body.icon, body.color, body.role, brain, json.dumps(body.knowledge_base_ids)),
    )
    return _row(await db.fetch_one("SELECT * FROM agent_profiles WHERE id = ?", (profile_id,)))


@router.put("/{profile_id}", dependencies=[Depends(require_master)])
async def update_profile(profile_id: str, body: ProfileBody) -> dict:
    brain = _brain(body)
    if body.is_default:
        await db.execute("UPDATE agent_profiles SET is_default = 0")
    await db.execute(
        "UPDATE agent_profiles SET name=?, description=?, system_prompt_append=?, allowed_tools=?,"
        " disallowed_tools=?, permission_mode=?, model=?, max_turns=?, inject_memory=?, is_default=?,"
        " icon=?, color=?, role=?, integration_key=?, knowledge_base_ids=?"
        " WHERE id=?",
        (body.name, body.description, body.system_prompt_append,
         json.dumps(body.allowed_tools), json.dumps(body.disallowed_tools),
         body.permission_mode, body.model, body.max_turns,
         int(body.inject_memory), int(body.is_default),
         body.icon, body.color, body.role, brain, json.dumps(body.knowledge_base_ids), profile_id),
    )
    row = await db.fetch_one("SELECT * FROM agent_profiles WHERE id = ?", (profile_id,))
    if row is None:
        raise HTTPException(404, "profile not found")
    return _row(row)


@router.delete("/{profile_id}", dependencies=[Depends(require_master)])
async def delete_profile(profile_id: str) -> dict:
    row = await db.fetch_one("SELECT is_default FROM agent_profiles WHERE id = ?", (profile_id,))
    if row and row["is_default"]:
        raise HTTPException(409, "cannot delete the default profile")
    await db.execute("DELETE FROM agent_profiles WHERE id = ?", (profile_id,))
    # the companion's home goes with it — both UIs state this in their confirm
    return {"ok": True, "home_deleted": delete_home(profile_id)}
