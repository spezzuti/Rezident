"""ApprovalBroker + rules engine.

Every non-read-only tool call lands in evaluate(): first matching enabled rule
(by priority, then creation order) decides allow/deny/ask; no match means ask.
Write/Edit inside the task's own working directory is allowed in code — an
agent editing its own workspace is the normal case, not a privilege.

Deadlock rule: every path out of awaiting_approval must resolve its Future
exactly once — cancel, shutdown, and resolve all funnel through here.
"""

import asyncio
import fnmatch
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .db import db
from .events import utcnow

log = logging.getLogger(__name__)

FILE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")


@dataclass
class Decision:
    action: str  # "approve" | "approve_edit" | "deny"
    input: dict[str, Any] | None = None
    reason: str | None = None
    interrupt: bool = False


@dataclass
class PendingApproval:
    approval_id: str
    task_id: str
    tool_name: str
    tool_input: dict[str, Any]
    future: asyncio.Future = field(repr=False, default=None)  # type: ignore[assignment]


class ApprovalBroker:
    def __init__(self) -> None:
        self.pending: dict[str, PendingApproval] = {}

    def register(self, approval_id: str, task_id: str, tool_name: str, tool_input: dict[str, Any]) -> asyncio.Future:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[approval_id] = PendingApproval(approval_id, task_id, tool_name, tool_input, fut)
        return fut

    def resolve(self, approval_id: str, decision: Decision) -> bool:
        pa = self.pending.pop(approval_id, None)
        if pa is None or pa.future.done():
            return False
        pa.future.set_result(decision)
        return True

    def deny_pending_for_task(self, task_id: str, reason: str, interrupt: bool = False) -> None:
        for approval_id, pa in list(self.pending.items()):
            if pa.task_id == task_id:
                self.resolve(approval_id, Decision(action="deny", reason=reason, interrupt=interrupt))

    def deny_all_pending(self, reason: str) -> None:
        for approval_id in list(self.pending):
            self.resolve(approval_id, Decision(action="deny", reason=reason, interrupt=True))


broker = ApprovalBroker()


def _match(rule: dict[str, Any], value: str) -> bool:
    pattern = rule["pattern"]
    mt = rule["match_type"]
    try:
        if mt == "regex":
            return re.search(pattern, value) is not None
        if mt == "prefix":
            return value.startswith(pattern)
        if mt == "glob":
            return fnmatch.fnmatch(value, pattern)
    except re.error:
        log.warning("Invalid regex in rule %s: %s", rule["id"], pattern)
    return False


def _extract_field(tool_name: str, tool_input: dict[str, Any], fld: str | None) -> str | None:
    if fld is None:
        return ""  # tool-name-only rule matches unconditionally
    return tool_input.get(fld) if isinstance(tool_input.get(fld), str) else None


def _path_within(child: str, parent: str) -> bool:
    try:
        c = Path(child).resolve()
        p = Path(parent).resolve()
        return c == p or p in c.parents
    except (OSError, ValueError):
        return False


def task_workdir(task: dict[str, Any]) -> str | None:
    return task.get("worktree_path") or task.get("cwd")


async def evaluate(
    tool_name: str, tool_input: dict[str, Any], task: dict[str, Any]
) -> tuple[str, str | None]:
    """Returns (verdict, matched_rule_id); verdict in 'allow'|'deny'|'ask'."""
    rules = await db.fetch_all(
        "SELECT * FROM auto_approve_rules WHERE enabled = 1"
        " AND tool_name IN (?, '*') ORDER BY priority, created_at",
        (tool_name,),
    )
    for rule in rules:
        value = _extract_field(tool_name, dict(tool_input), rule["field"])
        if value is None:
            continue
        if _match(dict(rule), value):
            await db.execute(
                "UPDATE auto_approve_rules SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?",
                (utcnow(), rule["id"]),
            )
            return rule["action"], rule["id"]

    # Built-in: file edits inside the task's own workspace are routine.
    if tool_name in FILE_TOOLS:
        workdir = task_workdir(task)
        file_path = tool_input.get("file_path") or tool_input.get("notebook_path")
        if workdir and isinstance(file_path, str) and _path_within(file_path, workdir):
            return "allow", None

    return "ask", None


async def record(
    approval_id: str,
    task_id: str,
    tool_name: str,
    tool_input_json: str,
    status: str,
    matched_rule_id: str | None = None,
) -> None:
    resolved_at = None if status == "pending" else utcnow()
    await db.execute(
        "INSERT INTO approvals (id, task_id, tool_name, tool_input, status, matched_rule_id, created_at, resolved_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (approval_id, task_id, tool_name, tool_input_json, status, matched_rule_id, utcnow(), resolved_at),
    )


async def mark_resolved(
    approval_id: str, status: str, resolved_input_json: str | None = None, deny_reason: str | None = None
) -> None:
    await db.execute(
        "UPDATE approvals SET status = ?, resolved_input = ?, deny_reason = ?, resolved_at = ? WHERE id = ?",
        (status, resolved_input_json, deny_reason, utcnow(), approval_id),
    )
