"""ApprovalBroker: pending {approval_id: asyncio.Future} resolved from the UI.

Phase 1: the gate auto-approves everything (and logs it as task events) so the
risky can_use_tool wiring is exercised end-to-end from day one. Phase 2 adds
the auto_approve_rules engine and real pending approvals.

Deadlock rule: every path out of awaiting_approval must resolve its Future
exactly once — cancel, shutdown, and resolve all funnel through here.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)


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


async def evaluate(tool_name: str, tool_input: dict[str, Any], task: dict[str, Any]) -> str:
    """Phase 1 stub: allow everything. Phase 2 replaces this with the
    auto_approve_rules engine returning 'allow' | 'deny' | 'ask'."""
    return "allow"
