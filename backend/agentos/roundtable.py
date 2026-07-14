"""Roundtable orchestrator — 2+ agents taking turns on ONE shared transcript.

A kind='roundtable' task hosts a discussion: each turn, every participant (in
order) reads the ENTIRE speaker-labeled transcript so far and replies to the
latest point — agree, disagree, or build on it. The task's persisted event stream
IS the transcript (no sidecar file): each turn is emitted as an attributed
`assistant_text` event, so a reconnecting UI replays the whole conversation and
labels Claude-vs-Codex per line.

Both agents are driven STATELESSLY over the shared transcript so turns are
symmetric and attributable:
  * a local Claude persona   -> a one-shot Claude Agent SDK completion per turn
  * an integration (Codex/…) -> integrations.dispatch_messages(key, messages)

Because Codex's CLI transport flattens every assistant turn to the bare label
"Assistant" (see integrations._flatten_for_cli), speaker names are baked into the
message CONTENT ("Securitron: …" / "Codex: …") rather than relying on roles — so
Codex can always tell who said what.

The user is the Moderator: the topic seeds the transcript, and between round-
batches the session parks in `waiting_input` to await a moderator message (via the
same _chat_queue / send_user_message path as chat). A genuine agreement ends the
session early when a participant emits the [CONSENSUS] token.

A single agent's turn failing (e.g. Codex not signed in) is surfaced as an
attributed error event and the discussion continues — one bad turn never crashes
the session.
"""

import asyncio
import json
import logging
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookMatcher,
    PermissionResultDeny,
    ResultMessage,
    TextBlock,
)

from .events import bus

log = logging.getLogger(__name__)

CONSENSUS_TOKEN = "[CONSENSUS]"


# ---- tool guards (a roundtable turn is pure conversation) --------------------
# Turns must never touch tools; deny at both layers so a stray tool attempt is
# refused fast instead of stalling the one-shot. Mirrors runner._pretooluse_guard
# (the Python SDK only fires can_use_tool when a PreToolUse hook is also present).

async def _deny_tool(tool_name: str, tool_input: dict, context: Any):
    return PermissionResultDeny(
        message="Roundtable turns are conversation only — do not use tools, just reply.",
        interrupt=False,
    )


async def _deny_pretool(hook_input: dict, tool_use_id: str | None, context: Any) -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "Roundtable is a conversation — no tools.",
        }
    }


# ---- config ------------------------------------------------------------------

def _parse_config(raw: Any) -> dict[str, Any]:
    """The stored roundtable JSON -> a normalized {participants, rounds}. Tolerant
    of a JSON string (the persisted column) or a dict; a malformed blob yields an
    empty participant list, which the orchestrator reports as a graceful failure."""
    data: Any = {}
    if isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            data = {}
    elif isinstance(raw, dict):
        data = raw
    if not isinstance(data, dict):
        data = {}

    participants: list[dict[str, Any]] = []
    for x in data.get("participants") or []:
        if not isinstance(x, dict):
            continue
        name = (x.get("name") or "").strip()
        participants.append({
            "profile_id": (x.get("profile_id") or None),
            "integration_key": (x.get("integration_key") or None),
            "name": name,
            "color": (x.get("color") or "").strip() or "#7fc8ff",
            "model": (x.get("model") or None),
        })

    rounds = data.get("rounds") or 3
    try:
        rounds = max(1, int(rounds))
    except (TypeError, ValueError):
        rounds = 3
    return {"participants": participants, "rounds": rounds}


async def _resolve_personas(participants: list[dict[str, Any]]) -> None:
    """Enrich each participant in place with its agent_key + (for local Claude
    personas) the profile's system-prompt persona and default model, so per-turn
    framing carries the agent's character. Integration seats need no lookup."""
    from .db import db

    for p in participants:
        if p.get("integration_key"):
            p["agent_key"] = f"integration:{p['integration_key']}"
            p["persona"] = ""
            continue
        pid = p.get("profile_id")
        p["agent_key"] = f"profile:{pid}" if pid else "profile:default"
        row = None
        if pid:
            row = await db.fetch_one("SELECT * FROM agent_profiles WHERE id = ?", (pid,))
        if row is None:  # unknown/absent profile_id -> the default persona
            row = await db.fetch_one("SELECT * FROM agent_profiles WHERE is_default = 1 LIMIT 1")
        persona = ""
        if row is not None:
            d = dict(row)
            persona = (d.get("system_prompt_append") or "").strip()
            if not p.get("model"):
                p["model"] = d.get("model") or None
            if not p.get("name"):
                p["name"] = d.get("name") or "Agent"
            if not p.get("color") or p["color"] == "#7fc8ff":
                p["color"] = d.get("color") or p.get("color") or "#7fc8ff"
            # A BRAINED profile keeps its persona/name/color but its turns are
            # driven over its integration with its own model — treating it as
            # local Claude hands the claude CLI a foreign model id (field bug:
            # ZAX's every roundtable turn errored with "issue with the selected
            # model (gpt-5.6-sol)"). The GPT crew debates like everyone else.
            brain = (d.get("integration_key") or "").strip()
            if brain:
                p["integration_key"] = brain
        p["persona"] = persona


# ---- prompt shaping ----------------------------------------------------------

def _join_names(names: list[str]) -> str:
    names = [n for n in names if n]
    if not names:
        return "no one else yet"
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def _system_for(p: dict[str, Any], participants: list[dict[str, Any]]) -> str:
    """The roundtable framing for one participant's turn — its persona (if any)
    followed by the shared discussion rules and the consensus protocol."""
    others = _join_names([q["name"] for q in participants if q is not p])
    n = len(participants)
    base = (
        f"You are {p['name']}, one of {n} participants in a live roundtable discussion.\n"
        f"The other participants are: {others}.\n\n"
        "This is a conversation, not a series of essays. Read the transcript, then reply to the\n"
        "most recent point — agree with it, push back on it, or build on it — and address the\n"
        "others by name. Keep your turn under about 250 words and speak naturally in the first\n"
        "person, as one voice in a discussion.\n\n"
        "When you and the other participants have genuinely converged on a shared conclusion,\n"
        f"end your turn with the token {CONSENSUS_TOKEN} on its own line, followed by a single\n"
        "sentence stating the agreed conclusion. Do not claim consensus prematurely or merely to\n"
        "end the discussion — only when real agreement has been reached.\n\n"
        "Respond with your spoken turn only — no narration about yourself, no tool use, no\n"
        "markdown headings."
    )
    if p.get("persona"):
        return p["persona"] + "\n\n" + base
    return base


def _user_for(p: dict[str, Any], transcript: list[dict[str, Any]]) -> str:
    """The full speaker-labeled transcript + a prompt to take the next turn. The
    labels live in the CONTENT so a flatten-to-one-prompt runtime (Codex) still
    sees who said what."""
    lines = [f"{e['speaker']}: {e['text']}" for e in transcript]
    body = "\n\n".join(lines) if lines else "(the discussion has not started yet)"
    return (
        "Here is the roundtable transcript so far:\n\n"
        "----------------------------------------\n"
        f"{body}\n"
        "----------------------------------------\n\n"
        f"You are {p['name']}. It is now your turn. Reply to the latest point in the discussion."
    )


# ---- driving the two agent kinds (both stateless over the transcript) --------

async def _drive_claude(system_text: str, user_text: str, model: str | None) -> str:
    """One-shot local Claude completion: a fresh SDK client, one query, collect the
    assistant text, close. Tools are denied — a turn is pure conversation."""
    from .config import resolve_claude_cli, settings

    settings.ensure_dirs()
    cli = resolve_claude_cli()
    options = ClaudeAgentOptions(
        cwd=str(settings.scratch_dir),
        cli_path=str(cli) if cli else None,
        permission_mode="default",
        allowed_tools=[],
        disallowed_tools=[],
        can_use_tool=_deny_tool,
        hooks={"PreToolUse": [HookMatcher(hooks=[_deny_pretool])]},
        system_prompt=system_text,
        model=model or None,
        max_turns=1,  # one-shot: a single conversational reply per turn
    )
    chunks: list[str] = []

    async def _collect() -> None:
        async with ClaudeSDKClient(options=options) as client:
            await client.query(user_text)
            async for msg in client.receive_messages():
                if isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        if isinstance(block, TextBlock):
                            chunks.append(block.text)
                elif isinstance(msg, ResultMessage):
                    break

    # Per-turn deadline: a one-shot turn has no session watchdog, so a hung SDK
    # transport would wedge the whole roundtable 'running' forever. Cap it on the
    # existing idle setting (0 disables) — a timeout raises up into _one_turn,
    # which surfaces it as one failed turn and lets the discussion continue.
    idle = settings.task_idle_timeout_seconds
    await asyncio.wait_for(_collect(), timeout=idle if idle > 0 else None)
    return "".join(chunks).strip()


async def _drive_integration(key: str, system_text: str, user_text: str, model: str | None) -> str:
    """One turn on an integration runtime (Codex/…). The framing is a system
    message and the labeled transcript a single user message; dispatch_messages
    (stateless) returns the reply. Speaker labels are baked into the user content,
    so the CLI-flatten path still attributes correctly."""
    from .integrations import dispatch_messages

    messages = [
        {"role": "system", "content": system_text},
        {"role": "user", "content": user_text},
    ]
    result = await dispatch_messages(key, messages, model=model or None)
    return (result.get("reply") or "").strip()


async def _one_turn(
    p: dict[str, Any], participants: list[dict[str, Any]], transcript: list[dict[str, Any]]
) -> tuple[str, bool]:
    """Run one participant's turn. Returns (text, ok). A failure is caught and
    turned into a surfaced error string (ok=False) so the discussion continues."""
    from .integrations import IntegrationError

    system_text = _system_for(p, participants)
    user_text = _user_for(p, transcript)
    try:
        if p.get("integration_key"):
            reply = await _drive_integration(p["integration_key"], system_text, user_text, p.get("model"))
        else:
            reply = await _drive_claude(system_text, user_text, p.get("model"))
        return (reply or "").strip() or "(no reply)", True
    except IntegrationError as exc:
        return f"⚠ {p['name']} could not respond: {exc}", False
    except Exception as exc:  # noqa: BLE001 — one bad turn must never crash the session
        log.warning("roundtable turn failed for %s", p.get("name"), exc_info=True)
        return f"⚠ {p['name']} failed: {type(exc).__name__}: {str(exc)[:200]}", False


# ---- the orchestrator --------------------------------------------------------

async def _run_batch(
    runner: Any, participants: list[dict[str, Any]], transcript: list[dict[str, Any]], rounds: int
) -> bool:
    """Run `rounds` full rounds. Each turn is appended to the shared transcript and
    emitted as an attributed assistant_text event. Returns True if a participant
    reached [CONSENSUS] (session should end); False after the last round or on stop."""
    task_id = runner.task_id
    for r in range(rounds):
        await bus.emit_task_event(task_id, "roundtable", {"event": "round_start", "round": r + 1, "of": rounds})
        for p in participants:
            if await runner._should_stop():
                return False
            text, ok = await _one_turn(p, participants, transcript)
            transcript.append({"speaker": p["name"], "text": text, "kind": "agent"})
            payload = {
                "text": text,
                "agent": p["agent_key"],
                "agent_name": p["name"],
                "agent_color": p["color"],
            }
            if not ok:
                payload["error"] = True
            await bus.emit_task_event(task_id, "assistant_text", payload)
            if ok and CONSENSUS_TOKEN in text:
                return True
    return False


def _summary(transcript: list[dict[str, Any]]) -> str:
    """A short result summary for the task row: the last agent turn's text."""
    for e in reversed(transcript):
        if e.get("kind") == "agent":
            return (e.get("text") or "")[:16000]
    return ""


def _public_participant(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "agent": p["agent_key"],
        "name": p["name"],
        "color": p["color"],
        "kind": "integration" if p.get("integration_key") else "claude",
    }


async def run_roundtable(runner: Any) -> None:
    """Entry point invoked from AgentRunner.run() for a kind='roundtable' task.

    Seeds the transcript with the topic (as the Moderator), runs a batch of rounds,
    then parks in waiting_input for the moderator to `continue`. Ends early — and
    transitions done — when a participant reaches [CONSENSUS]. A cancel (None on the
    chat queue) ends the session as cancelled. One agent's failed turn is surfaced
    but never crashes the loop."""
    from .task_manager import manager

    task = runner.task
    task_id = runner.task_id

    cfg = _parse_config(task.get("roundtable"))
    participants = cfg["participants"]
    rounds = cfg["rounds"]

    if len(participants) < 2:
        await manager._fail(task_id, "a roundtable needs at least 2 participants")
        return

    await _resolve_personas(participants)

    # The moderator ingress: follow-ups arrive here via send_user_message exactly
    # like a chat; request_interrupt() puts None to wake+cancel a parked session.
    runner._chat_queue = asyncio.Queue()

    topic = (task.get("prompt") or "").strip()
    transcript: list[dict[str, Any]] = [{"speaker": "Moderator", "text": topic, "kind": "moderator"}]
    # Seed the shared transcript with the opening topic (the moderator's turn).
    await bus.emit_task_event(
        task_id, "user_message",
        {"text": topic, "agent": "moderator", "agent_name": "Moderator"},
    )
    await bus.emit_task_event(
        task_id, "roundtable",
        {"event": "session_start", "rounds": rounds,
         "participants": [_public_participant(p) for p in participants]},
    )

    reached_consensus = False
    try:
        while True:
            reached_consensus = await _run_batch(runner, participants, transcript, rounds)
            if await runner._should_stop():
                break
            if reached_consensus:
                break
            # A full batch ran without consensus — park for the moderator. A message
            # (send_user_message) already emits the user_message event and flips the
            # task back to running, so here we only append it to the transcript.
            await manager._safe_transition(task_id, "waiting_input")
            await bus.emit_task_event(task_id, "roundtable", {"event": "awaiting_moderator"})
            # Poll-park (not a bare get()) so a cross-process cancel that only moves
            # the durable row — never puts on this local queue — still wakes the
            # parked session. None (local cancel sentinel) still unwinds at once.
            text = await runner._park_for_message()
            if text is None or await runner._should_stop():
                break
            transcript.append({"speaker": "Moderator", "text": text.strip(), "kind": "moderator"})
    finally:
        runner._chat_queue = None

    if reached_consensus:
        await bus.emit_task_event(task_id, "roundtable", {"event": "consensus"})
        await manager._safe_transition(task_id, "done", result_summary=_summary(transcript))
    else:
        # Ended by moderator cancel / interrupt (None sentinel or a remote cancel).
        await bus.emit_task_event(task_id, "roundtable", {"event": "session_end"})
        await manager._safe_transition(task_id, "cancelled")
