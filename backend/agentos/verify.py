"""Verify-command runner.

Commands run through Git Bash (`bash.exe -lc <cmd>`) with cwd set to the task
directory, so verify commands are always POSIX-flavored regardless of Windows —
and no Windows path ever needs to be embedded inside the command itself.
"""

import asyncio
import logging

from .config import settings
from .events import bus

log = logging.getLogger(__name__)


async def run_verify(task_id: str, command: str, cwd: str) -> tuple[bool, str]:
    await bus.emit_task_event(task_id, "verify_output", {"line": f"$ {command}", "stream": "cmd"})
    try:
        proc = await asyncio.create_subprocess_exec(
            str(settings.git_bash_path), "-lc", command,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError:
        msg = f"Git Bash not found at {settings.git_bash_path}"
        await bus.emit_task_event(task_id, "verify_output", {"line": msg, "stream": "stderr"})
        return False, msg

    lines: list[str] = []

    async def read_output() -> None:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            lines.append(line)
            await bus.emit_task_event(task_id, "verify_output", {"line": line, "stream": "stdout"})

    try:
        await asyncio.wait_for(read_output(), timeout=settings.verify_timeout_seconds)
        returncode = await proc.wait()
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        timeout_msg = f"verify command timed out after {settings.verify_timeout_seconds}s"
        lines.append(timeout_msg)
        await bus.emit_task_event(task_id, "verify_output", {"line": timeout_msg, "stream": "stderr"})
        return False, "\n".join(lines)

    ok = returncode == 0
    await bus.emit_task_event(
        task_id, "verify_output",
        {"line": f"exit code {returncode} — {'PASS' if ok else 'FAIL'}", "stream": "status", "exit_code": returncode},
    )
    return ok, "\n".join(lines)
