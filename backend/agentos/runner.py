"""AgentRunner: one ClaudeSDKClient per task, streaming input mode.

Translates SDK messages into persisted task_events, accumulates cost (deduped
by assistant message id — parallel tool calls repeat the same id/usage), and
gates every non-read-only tool call through the approval broker.
"""

import asyncio
import logging
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
from .approvals import Decision, broker
from .config import settings
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

    # -- public control ------------------------------------------------------

    async def request_interrupt(self) -> None:
        self._interrupted = True
        if self.client is not None:
            try:
                await self.client.interrupt()
            except Exception:  # noqa: BLE001 — client may already be gone
                log.debug("interrupt() failed for %s", self.task_id, exc_info=True)

    async def send_user_message(self, text: str) -> None:
        assert self.client is not None
        await bus.emit_task_event(self.task_id, "user_message", {"text": text})
        from .task_manager import manager

        await manager.transition(self.task_id, "running")
        await self.client.query(text)

    # -- lifecycle -----------------------------------------------------------

    def _effective_cwd(self) -> str:
        cwd = self.task.get("worktree_path") or self.task.get("cwd") or str(settings.scratch_dir)
        return cwd

    def _build_options(self) -> ClaudeAgentOptions:
        return ClaudeAgentOptions(
            cwd=self._effective_cwd(),
            cli_path=str(settings.claude_cli_path),
            permission_mode="default",
            allowed_tools=list(READ_ONLY_TOOLS),
            can_use_tool=self._gate,
            hooks={"PreToolUse": [HookMatcher(hooks=[_noop_pretooluse])]},
            model=self.task.get("model") or None,
            max_turns=self.task.get("max_turns") or None,
            resume=self.task.get("resume_session_id") or None,
        )

    async def run(self) -> None:
        from .task_manager import manager

        # Task is already 'running' — TaskManager._launch transitions before spawn.
        options = self._build_options()
        async with ClaudeSDKClient(options=options) as client:
            self.client = client
            await client.query(self.task["prompt"])
            result = await self._consume_messages(client)
        self.client = None

        if self._interrupted or (self.running_task and self.running_task.cancel_requested):
            await manager._safe_transition(self.task_id, "cancelled")
            return
        if result is None:
            await manager._fail(self.task_id, "Agent stream ended without a result message")
            return
        if result.is_error:
            await manager._fail(self.task_id, result.result or result.subtype or "agent error")
            return

        summary = (result.result or "")[:2000]
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

    async def _consume_messages(self, client: ClaudeSDKClient) -> ResultMessage | None:
        async for msg in client.receive_messages():
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
        for block in msg.content:
            if isinstance(block, TextBlock):
                await bus.emit_task_event(self.task_id, "assistant_text", {"text": block.text})
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
        await db.execute(
            "UPDATE tasks SET total_cost_usd=?, num_turns=?, session_id=COALESCE(?, session_id) WHERE id=?",
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
            return PermissionResultDeny(message=f"Blocked by AgentOS rule ({rule_id}). Do not retry this action.")

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
