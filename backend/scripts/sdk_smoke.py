"""Smoke test for the claude-agent-sdk integration.

Run manually whenever claude-agent-sdk or the claude CLI updates:
    backend\\.venv\\Scripts\\python.exe backend\\scripts\\sdk_smoke.py

Verifies the three load-bearing behaviors AgentOS depends on:
  1. ClaudeSDKClient connects and completes a trivial query
  2. can_use_tool fires (with the dummy PreToolUse hook registered)
  3. ResultMessage carries total_cost_usd / usage
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookMatcher,
    PermissionResultAllow,
    ResultMessage,
)

from agentos.config import settings

gate_fired = {"count": 0}


async def noop_pretooluse(hook_input, tool_use_id, context):
    return {"continue_": True}


async def gate(tool_name, tool_input, context):
    gate_fired["count"] += 1
    print(f"  [gate] can_use_tool fired: {tool_name} {str(tool_input)[:120]}")
    return PermissionResultAllow()


async def main() -> int:
    settings.ensure_dirs()
    options = ClaudeAgentOptions(
        cwd=str(settings.scratch_dir),
        cli_path=str(settings.claude_cli_path),
        permission_mode="default",
        allowed_tools=["Read", "Glob", "Grep"],
        can_use_tool=gate,
        hooks={"PreToolUse": [HookMatcher(hooks=[noop_pretooluse])]},
        max_turns=5,
    )
    print("connecting…")
    async with ClaudeSDKClient(options=options) as client:
        # Must be a MUTATING operation: Claude Code auto-approves read-only
        # Bash (echo, ls, git status…) before it ever reaches can_use_tool.
        await client.query(
            "Use the Write tool to create smoke.txt containing 'smoke-ok'."
            " Then reply with just the word DONE."
        )
        async for msg in client.receive_response():
            if isinstance(msg, AssistantMessage):
                print(f"  [assistant] {[type(b).__name__ for b in msg.content]}")
            if isinstance(msg, ResultMessage):
                print(f"  [result] subtype={msg.subtype} cost=${msg.total_cost_usd} turns={msg.num_turns}")
                print(f"  [result] usage keys: {sorted((msg.usage or {}).keys())}")
                ok = not msg.is_error and gate_fired["count"] >= 1 and msg.total_cost_usd is not None
                print(f"\nSMOKE {'PASS' if ok else 'FAIL'} (gate fired {gate_fired['count']}x)")
                return 0 if ok else 1
    print("\nSMOKE FAIL: no result message")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
