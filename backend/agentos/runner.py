"""AgentRunner: one ClaudeSDKClient per task, streaming input mode.

Translates SDK messages into persisted task_events, accumulates cost (deduped
by assistant message id — parallel tool calls repeat the same id/usage), and
gates every non-read-only tool call through the approval broker.
"""

import asyncio
import logging
import time
import uuid
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from . import approvals
from . import notify
from .approvals import Decision, broker
from .config import resolve_claude_cli, settings
from .db import db
from .events import bus, utcnow
from .verify import run_verify

log = logging.getLogger(__name__)

READ_ONLY_TOOLS = ["Read", "Glob", "Grep"]


async def _noop_pretooluse(hook_input: dict, tool_use_id: str | None, context: Any) -> dict:
    """Load-bearing no-op: a PreToolUse hook must be registered for
    can_use_tool to fire in the Python SDK (documented quirk)."""
    return {"continue_": True}


class AgentRunner:
    def __init__(self, task: dict[str, Any]) -> None:
        self.task = task
        self.task_id: str = task["id"]
        self.client: ClaudeSDKClient | None = None
        self.running_task: Any = None  # RunningTask backref, set by TaskManager
        self._seen_message_ids: set[str] = set()
        self._interrupted = False
        # for interactive integration chats (no live SDK client): follow-up
        # messages are delivered onto this queue; None is the cancel sentinel.
        self._chat_queue: asyncio.Queue[str | None] | None = None
        self._last_activity = 0.0  # monotonic ts of the last stream event; drives the idle watchdog
        self._wedged = False
        # memory identity (docs/agent-memory.md): bridged runtimes key on the
        # integration; local Claude keys on the resolved profile (set once
        # _load_profile has run, since profile_id may fall back to the default).
        self.agent_key: str | None = (
            f"integration:{self.task['integration_key']}" if self.task.get("integration_key") else None
        )

    # -- public control ------------------------------------------------------

    async def request_interrupt(self) -> None:
        self._interrupted = True
        if self._chat_queue is not None:  # wake a parked integration chat so it can exit
            try:
                self._chat_queue.put_nowait(None)
            except Exception:  # noqa: BLE001
                pass
        if self.client is not None:
            try:
                await self.client.interrupt()
            except Exception:  # noqa: BLE001 — client may already be gone
                log.debug("interrupt() failed for %s", self.task_id, exc_info=True)

    def accepts_messages(self) -> bool:
        """True while this task can take a follow-up: a live SDK chat client or
        a parked integration chat loop."""
        return self.client is not None or self._chat_queue is not None

    async def send_user_message(self, text: str) -> None:
        from .task_manager import manager

        await bus.emit_task_event(self.task_id, "user_message", {"text": text})
        await manager.transition(self.task_id, "running")
        if self._chat_queue is not None:  # interactive integration chat — hand off to the loop
            await self._chat_queue.put(text)
            return
        assert self.client is not None
        await self.client.query(text)

    # -- lifecycle -----------------------------------------------------------

    def _effective_cwd(self) -> str:
        cwd = self.task.get("worktree_path") or self.task.get("cwd") or str(settings.scratch_dir)
        return cwd

    async def _prepare_workspace(self) -> None:
        """Repo tasks get an isolated worktree; retries resume the parent session."""
        if self.task["kind"] == "repo" and not self.task.get("worktree_path"):
            from . import worktree

            wt_path, branch = await worktree.create_worktree(self.task)
            base = self.task.get("base_branch")
            if not base:
                base = (await worktree._git("rev-parse", "--abbrev-ref", "HEAD", cwd=self.task["repo_path"])).strip()
            await db.execute(
                "UPDATE tasks SET worktree_path=?, branch=?, base_branch=? WHERE id=?",
                (wt_path, branch, base, self.task_id),
            )
            self.task.update(worktree_path=wt_path, branch=branch, base_branch=base)
            await bus.emit_task_event(
                self.task_id, "workspace_ready", {"worktree": wt_path, "branch": branch, "base": base}
            )

        if self.task.get("parent_task_id") and not self.task.get("resume_session_id"):
            row = await db.fetch_one(
                "SELECT session_id FROM tasks WHERE id = ?", (self.task["parent_task_id"],)
            )
            if row and row["session_id"]:
                self.task["resume_session_id"] = row["session_id"]

    async def _load_profile(self) -> dict[str, Any]:
        import json as _json

        row = None
        if self.task.get("profile_id"):
            row = await db.fetch_one("SELECT * FROM agent_profiles WHERE id = ?", (self.task["profile_id"],))
        if row is None:
            row = await db.fetch_one("SELECT * FROM agent_profiles WHERE is_default = 1 LIMIT 1")
        profile = dict(row) if row else {}
        for key in ("allowed_tools", "disallowed_tools"):
            try:
                profile[key] = _json.loads(profile.get(key) or "[]")
            except (TypeError, ValueError):
                profile[key] = []
        return profile

    async def _build_options(self) -> ClaudeAgentOptions:
        from .memory import render_block

        profile = await self._load_profile()
        if profile.get("id"):
            self.agent_key = f"profile:{profile['id']}"

        append_parts = []
        if profile.get("system_prompt_append"):
            append_parts.append(profile["system_prompt_append"])
        if profile.get("inject_memory", 1):
            memory_block = await render_block(self.agent_key)
            if memory_block:
                append_parts.append(memory_block)
        system_prompt = None
        if append_parts:
            system_prompt = {"type": "preset", "preset": "claude_code", "append": "\n".join(append_parts)}

        # Profile allowed_tools SKIP the approval gate — the UI warns about this.
        allowed = list(dict.fromkeys(READ_ONLY_TOOLS + profile.get("allowed_tools", [])))
        # Hand the SDK a real path or None: the SDK uses cli_path verbatim and only
        # runs its own PATH search when it's None, so a dead path would fail fatally.
        claude_cli = resolve_claude_cli()
        return ClaudeAgentOptions(
            cwd=self._effective_cwd(),
            cli_path=str(claude_cli) if claude_cli else None,
            permission_mode=profile.get("permission_mode") or "default",
            allowed_tools=allowed,
            disallowed_tools=profile.get("disallowed_tools", []),
            can_use_tool=self._gate,
            hooks={"PreToolUse": [HookMatcher(hooks=[_noop_pretooluse])]},
            model=self.task.get("model") or profile.get("model") or None,
            max_turns=self.task.get("max_turns") or profile.get("max_turns") or None,
            resume=self.task.get("resume_session_id") or None,
            system_prompt=system_prompt,
        )

    async def _run_integration(self) -> None:
        """Execute the task on an external runtime (Hermes/OpenClaw/…) via its
        OpenAI-compatible API instead of the local Claude SDK. The reply streams
        to the UI as assistant_text and becomes the task result. External agents
        don't touch the local workspace, so there's no worktree/approval/verify."""
        from .integrations import IntegrationError, dispatch_messages
        from .memory import handle_reply, render_block
        from .task_manager import manager

        key = self.task["integration_key"]
        messages: list[dict] = []
        block = await render_block(self.agent_key)
        if block:
            messages.append({"role": "system", "content": block})
        messages.append({"role": "user", "content": self.task["prompt"]})
        try:
            result = await dispatch_messages(key, messages)
        except IntegrationError as exc:
            await manager._fail(self.task_id, str(exc))
            return
        except Exception as exc:  # network/parse — never leave the task hanging
            await manager._fail(self.task_id, f"{type(exc).__name__}: {str(exc)[:300]}")
            return
        reply = (result.get("reply") or "").strip() or "(empty reply)"
        reply = (await handle_reply(self.task_id, self.agent_key, reply)).strip() or "(empty reply)"
        await bus.emit_task_event(self.task_id, "assistant_text", {"text": reply})
        await manager.transition(self.task_id, "done", result_summary=reply[:16000])

    async def _run_integration_chat(self) -> None:
        """Interactive Comms chat against an external runtime. Mirrors _run_chat's
        stay-alive model, but there's no live SDK client: the full message history
        is kept in-loop and re-sent on each turn (stateless /v1/chat/completions),
        and follow-ups arrive over self._chat_queue. Parks in waiting_input between
        turns; only cancel ends it."""
        from .integrations import IntegrationError, dispatch_messages
        from .memory import handle_reply, render_block
        from .task_manager import manager

        key = self.task["integration_key"]
        self._chat_queue = asyncio.Queue()
        history: list[dict] = []
        block = await render_block(self.agent_key)
        if block:  # history is re-sent per turn, so the system message persists
            history.append({"role": "system", "content": block})
        history.append({"role": "user", "content": self.task["prompt"]})
        await bus.emit_task_event(self.task_id, "user_message", {"text": self.task["prompt"]})
        try:
            while True:
                try:
                    result = await dispatch_messages(key, history)
                    reply = (result.get("reply") or "").strip() or "(empty reply)"
                    reply = (await handle_reply(self.task_id, self.agent_key, reply)).strip() or "(empty reply)"
                except IntegrationError as exc:
                    reply = f"⚠ {exc}"
                except Exception as exc:  # noqa: BLE001 — never kill the channel on one bad turn
                    reply = f"⚠ {type(exc).__name__}: {str(exc)[:200]}"
                await bus.emit_task_event(self.task_id, "assistant_text", {"text": reply})
                history.append({"role": "assistant", "content": reply})
                if self._interrupted or (self.running_task and self.running_task.cancel_requested):
                    break
                await manager._safe_transition(self.task_id, "waiting_input")
                text = await self._chat_queue.get()  # park until the next user message
                if text is None or self._interrupted or (self.running_task and self.running_task.cancel_requested):
                    break
                history.append({"role": "user", "content": text})
        finally:
            self._chat_queue = None
        await manager._safe_transition(self.task_id, "cancelled")

    async def _run_acp_chat(self, cfg: dict[str, Any]) -> None:
        """Interactive ACP chat: ONE persistent `hermes acp` session over SSH, kept
        alive across turns for native server-side context. Streams token deltas as
        transient assistant_delta events (not persisted) and tool calls as tool_use,
        then persists the full reply as assistant_text. Parks in waiting_input between
        turns; cancel ends it. Reuses _chat_queue for follow-ups + the cancel sentinel."""
        from .acp import AcpClient, AcpError
        from .integrations import _parse_ssh
        from .memory import handle_reply, render_block
        from .task_manager import manager

        ssh = (cfg.get("ssh") or "").strip()
        if not ssh:
            await manager._fail(self.task_id, "ACP chat needs an ssh destination (user@host)")
            return
        dest, sshport = _parse_ssh(ssh)
        self._chat_queue = asyncio.Queue()
        client = AcpClient(dest, sshport)
        session_id = ""
        try:
            await client.start()
            session_id = await client.new_session()
        except Exception as exc:  # noqa: BLE001
            await client.close()
            self._chat_queue = None
            await manager._fail(self.task_id, f"ACP start failed: {str(exc)[:200]}")
            return

        text = self.task["prompt"]
        await bus.emit_task_event(self.task_id, "user_message", {"text": text})
        block = await render_block(self.agent_key)
        if block:  # persistent session carries context natively — sent once, on turn 1
            text = f"[Context from your operator's Rezident]\n{block}\n---\n\n{text}"
        try:
            while True:
                chunks: list[str] = []

                async def on_update(u: dict) -> None:
                    kind = u.get("sessionUpdate")
                    content = u.get("content") or {}
                    if kind == "agent_message_chunk" and content.get("type") == "text" and content.get("text"):
                        chunks.append(content["text"])
                        bus.publish_task(self.task_id, "assistant_delta", {"text": content["text"]})
                    elif kind == "agent_thought_chunk" and content.get("type") == "text" and content.get("text"):
                        bus.publish_task(self.task_id, "thinking_delta", {"text": content["text"]})
                    elif kind == "tool_call":
                        await bus.emit_task_event(self.task_id, "tool_use", {
                            "tool_use_id": u.get("toolCallId", ""),
                            "tool": u.get("title") or u.get("kind") or "tool",
                            "input": {},
                        })

                try:
                    await client.prompt(session_id, text, on_update, timeout=600)
                    reply = "".join(chunks).strip() or "(no reply)"
                except AcpError as exc:
                    partial = "".join(chunks).strip()
                    reply = f"{partial}\n\n⚠ {exc}" if partial else f"⚠ {exc}"
                reply = (await handle_reply(self.task_id, self.agent_key, reply)).strip() or "(no reply)"
                bus.publish_task(self.task_id, "stream_end", {})  # tell the UI to seal the live bubble
                await bus.emit_task_event(self.task_id, "assistant_text", {"text": reply})
                if self._interrupted or (self.running_task and self.running_task.cancel_requested):
                    break
                await manager._safe_transition(self.task_id, "waiting_input")
                text = await self._chat_queue.get()
                if text is None or self._interrupted or (self.running_task and self.running_task.cancel_requested):
                    break
        finally:
            self._chat_queue = None
            if session_id:
                await client.cancel(session_id)
            await client.close()
        await manager._safe_transition(self.task_id, "cancelled")

    async def run(self) -> None:
        from .task_manager import manager

        # Task is already 'running' — TaskManager._launch transitions before spawn.
        if self.task.get("integration_key"):
            if self.task["kind"] == "chat":
                from .integrations import get_config
                cfg = await get_config(self.task["integration_key"])
                if (cfg.get("transport") or "openai").strip() == "acp":
                    await self._run_acp_chat(cfg)  # streaming, native ACP session
                else:
                    await self._run_integration_chat()
            else:
                await self._run_integration()
            return
        await self._prepare_workspace()
        options = await self._build_options()
        if self.task["kind"] == "chat":
            await self._run_chat(options)
            return
        watchdog = asyncio.create_task(self._watchdog())
        try:
            async with ClaudeSDKClient(options=options) as client:
                self.client = client
                await client.query(self.task["prompt"])
                result = await self._consume_messages(client)
            self.client = None
        finally:
            watchdog.cancel()

        if self._wedged:
            return  # the idle watchdog already failed this task
        if self._interrupted or (self.running_task and self.running_task.cancel_requested):
            await manager._safe_transition(self.task_id, "cancelled")
            return
        if result is None:
            await manager._fail(self.task_id, "Agent stream ended without a result message")
            return
        if result.is_error:
            await manager._fail(self.task_id, result.result or result.subtype or "agent error")
            return

        # _on_assistant already applied any write-back from the final message;
        # the result text repeats it, so strip-only here (apply would just dedupe).
        from .memory import extract_writeback

        summary, _, _ = extract_writeback(result.result or "")
        summary = summary[:16000]
        if self.task.get("verify_command"):
            await manager.transition(self.task_id, "verifying", result_summary=summary)
            ok, output = await run_verify(self.task_id, self.task["verify_command"], self._effective_cwd())
            if ok:
                await manager.transition(self.task_id, "done")
            else:
                await manager.transition(
                    self.task_id, "failed",
                    error=f"verification failed:\n{output[-2000:]}",
                )
        else:
            await manager.transition(self.task_id, "done", result_summary=summary)

    async def _run_chat(self, options: ClaudeAgentOptions) -> None:
        """Chat sessions stay alive: after each response the task parks in
        waiting_input with the SDK client still connected; send_user_message
        wakes it. Only cancel ends the conversation."""
        from .task_manager import manager

        async with ClaudeSDKClient(options=options) as client:
            self.client = client
            await bus.emit_task_event(self.task_id, "user_message", {"text": self.task["prompt"]})
            await client.query(self.task["prompt"])
            while True:
                result = await self._consume_messages(client)
                if self._interrupted or (self.running_task and self.running_task.cancel_requested):
                    break
                if result is None:
                    break
                await manager._safe_transition(self.task_id, "waiting_input")
                # Park until send_user_message() issues the next query; the
                # stream stays open, so just keep consuming.
        self.client = None
        await manager._safe_transition(self.task_id, "cancelled")

    async def _watchdog(self) -> None:
        """Fail a wedged task: if it stays 'running' (NOT approval-parked, NOT
        verifying — those are legitimate waits with their own handling) and emits
        no stream activity for task_idle_timeout_seconds, the SDK transport is
        almost certainly hung. Interrupt it, mark the task failed, and hard-cancel
        the runner coroutine if it doesn't unwind — otherwise a wedged task keeps
        occupying a concurrency slot forever even though the board shows it failed.
        Cancelled by run() when the task completes normally."""
        from .task_manager import manager

        idle = settings.task_idle_timeout_seconds
        if idle <= 0:
            return
        self._last_activity = time.monotonic()
        try:
            while True:
                await asyncio.sleep(min(60, max(5, idle // 4)))
                task = await manager.get_task(self.task_id)
                if task is None:
                    return
                if task["status"] != "running":
                    self._last_activity = time.monotonic()  # don't accrue idle while parked/verifying
                    continue
                if time.monotonic() - self._last_activity <= idle:
                    continue
                self._wedged = True
                log.warning("Task %s idle for %ss — auto-failing as wedged", self.task_id, idle)
                if self.client is not None:
                    try:
                        # interrupt() rides the same (hung) transport — cap the wait
                        await asyncio.wait_for(self.client.interrupt(), timeout=10)
                    except Exception:  # noqa: BLE001
                        pass
                await manager._fail(
                    self.task_id, f"no agent activity for {idle}s — auto-failed by the idle watchdog"
                )
                # Grace period for the stream to unwind from the interrupt; a truly
                # hung transport won't, so hard-cancel the runner coroutine to free
                # its concurrency slot (same pattern as manager.cancel()).
                rt = self.running_task
                if rt is not None:
                    try:
                        await asyncio.wait_for(asyncio.shield(rt.aio_task), timeout=15)
                    except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                        rt.aio_task.cancel()
                return
        except asyncio.CancelledError:
            return

    async def _consume_messages(self, client: ClaudeSDKClient) -> ResultMessage | None:
        async for msg in client.receive_messages():
            self._last_activity = time.monotonic()  # heartbeat for the idle watchdog
            if isinstance(msg, SystemMessage):
                await self._on_system(msg)
            elif isinstance(msg, AssistantMessage):
                await self._on_assistant(msg)
            elif isinstance(msg, UserMessage):
                await self._on_tool_results(msg)
            elif isinstance(msg, ResultMessage):
                await self._on_result(msg)
                return msg
        return None

    # -- message translation -------------------------------------------------

    async def _on_system(self, msg: SystemMessage) -> None:
        if msg.subtype == "init":
            session_id = msg.data.get("session_id")
            if session_id:
                await db.execute(
                    "UPDATE tasks SET session_id=? WHERE id=?", (session_id, self.task_id)
                )
            await bus.emit_task_event(
                self.task_id, "session_init",
                {"session_id": session_id, "model": msg.data.get("model")},
            )

    async def _on_assistant(self, msg: AssistantMessage) -> None:
        from .memory import handle_reply

        for block in msg.content:
            if isinstance(block, TextBlock):
                # strip + persist any agentos-memory write-back before display
                text = await handle_reply(self.task_id, self.agent_key, block.text)
                if text.strip():
                    await bus.emit_task_event(self.task_id, "assistant_text", {"text": text})
            elif isinstance(block, ThinkingBlock):
                await bus.emit_task_event(
                    self.task_id, "thinking", {"text": block.thinking[:1000]}
                )
            elif isinstance(block, ToolUseBlock):
                await bus.emit_task_event(
                    self.task_id, "tool_use",
                    {"tool_use_id": block.id, "tool": block.name, "input": _truncate_input(block.input)},
                )
        await self._accumulate_usage(msg)

    async def _on_tool_results(self, msg: UserMessage) -> None:
        content = msg.content if isinstance(msg.content, list) else []
        for block in content:
            if isinstance(block, ToolResultBlock):
                await bus.emit_task_event(
                    self.task_id, "tool_result",
                    {
                        "tool_use_id": block.tool_use_id,
                        "is_error": bool(block.is_error),
                        "content": _render_tool_result(block.content),
                    },
                )

    async def _accumulate_usage(self, msg: AssistantMessage) -> None:
        usage = getattr(msg, "usage", None)
        message_id = getattr(msg, "message_id", None)
        if not usage or not message_id or message_id in self._seen_message_ids:
            return
        self._seen_message_ids.add(message_id)
        await db.execute(
            "UPDATE tasks SET input_tokens = input_tokens + ?,"
            " output_tokens = output_tokens + ?,"
            " cache_read_tokens = cache_read_tokens + ?,"
            " cache_creation_tokens = cache_creation_tokens + ? WHERE id = ?",
            (
                usage.get("input_tokens", 0) or 0,
                usage.get("output_tokens", 0) or 0,
                usage.get("cache_read_input_tokens", 0) or 0,
                usage.get("cache_creation_input_tokens", 0) or 0,
                self.task_id,
            ),
        )
        row = await db.fetch_one(
            "SELECT input_tokens, output_tokens, cache_read_tokens, total_cost_usd FROM tasks WHERE id=?",
            (self.task_id,),
        )
        if row:
            await bus.emit_task_event(self.task_id, "cost_update", dict(row))

    async def _on_result(self, msg: ResultMessage) -> None:
        # Accumulate: ResultMessage cost covers one query() call, and chat
        # sessions produce one result per exchange.
        await db.execute(
            "UPDATE tasks SET total_cost_usd = total_cost_usd + ?, num_turns=?,"
            " session_id=COALESCE(?, session_id) WHERE id=?",
            (msg.total_cost_usd or 0, msg.num_turns, msg.session_id, self.task_id),
        )
        await bus.emit_task_event(
            self.task_id, "result",
            {
                "subtype": msg.subtype,
                "is_error": msg.is_error,
                "total_cost_usd": msg.total_cost_usd,
                "num_turns": msg.num_turns,
                "duration_ms": msg.duration_ms,
                "text": (msg.result or "")[:4000],
            },
        )

    # -- the approval gate ---------------------------------------------------

    async def _gate(self, tool_name: str, tool_input: dict[str, Any], context: Any):
        import json as _json

        verdict, rule_id = await approvals.evaluate(tool_name, tool_input, self.task)
        input_json = _json.dumps(_truncate_input(tool_input))

        if verdict == "allow":
            await approvals.record(str(uuid.uuid4()), self.task_id, tool_name, input_json, "auto_approved", rule_id)
            await bus.emit_task_event(
                self.task_id, "approval_resolved",
                {"tool": tool_name, "input": _truncate_input(tool_input), "resolution": "auto_approved", "rule_id": rule_id},
            )
            return PermissionResultAllow()
        if verdict == "deny":
            await approvals.record(str(uuid.uuid4()), self.task_id, tool_name, input_json, "auto_denied", rule_id)
            await bus.emit_task_event(
                self.task_id, "approval_resolved",
                {"tool": tool_name, "input": _truncate_input(tool_input), "resolution": "auto_denied", "rule_id": rule_id},
            )
            return PermissionResultDeny(message=f"Blocked by Rezident rule ({rule_id}). Do not retry this action.")

        # verdict == "ask": queue for a human, pause here until resolved.
        from .task_manager import manager

        approval_id = str(uuid.uuid4())
        fut = broker.register(approval_id, self.task_id, tool_name, tool_input)
        await approvals.record(approval_id, self.task_id, tool_name, input_json, "pending")
        await manager._safe_transition(self.task_id, "awaiting_approval")
        await bus.emit_task_event(
            self.task_id, "approval_requested",
            {"approval_id": approval_id, "tool": tool_name, "input": _truncate_input(tool_input)},
        )
        bus.publish_global(
            "approval_pending",
            {"approval_id": approval_id, "task_id": self.task_id, "task_title": self.task["title"],
             "tool": tool_name, "input": _truncate_input(tool_input), "created_at": utcnow()},
        )
        notify.fire("approval", self.task["title"], tool_name)  # push to the operator's phone if away
        try:
            decision: Decision = await fut
        finally:
            broker.pending.pop(approval_id, None)

        status = {"approve": "approved", "approve_edit": "approved_edited", "deny": "denied"}[decision.action]
        await approvals.mark_resolved(
            approval_id, status,
            _json.dumps(decision.input) if decision.input else None,
            decision.reason,
        )
        # Only leave awaiting_approval when no other approval is pending for
        # this task (parallel tool calls can gate concurrently).
        still_pending = any(pa.task_id == self.task_id for pa in broker.pending.values())
        task_now = await manager.get_task(self.task_id)
        if not still_pending and task_now and task_now["status"] == "awaiting_approval":
            await manager.transition(self.task_id, "running")
        await bus.emit_task_event(
            self.task_id, "approval_resolved",
            {"approval_id": approval_id, "tool": tool_name, "resolution": decision.action, "reason": decision.reason},
        )
        bus.publish_global("approval_resolved", {"approval_id": approval_id, "task_id": self.task_id})

        if decision.action in ("approve", "approve_edit"):
            return PermissionResultAllow(updated_input=decision.input or tool_input)
        return PermissionResultDeny(
            message=decision.reason or "Denied by operator", interrupt=decision.interrupt
        )


def _truncate_input(tool_input: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in tool_input.items():
        if isinstance(value, str) and len(value) > 2000:
            out[key] = value[:2000] + f"… [{len(value)} chars]"
        else:
            out[key] = value
    return out


def _render_tool_result(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content[:4000]
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n".join(parts)[:4000]
    return str(content)[:4000]
