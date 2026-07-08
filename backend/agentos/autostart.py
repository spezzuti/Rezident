"""Boot-level autostart: a Windows Scheduled Task that starts the Rezident server
at machine boot, before anyone logs in.

Why a boot-trigger task and not a real Windows service: the server must run AS
THE USER — the Claude CLI login (~/.claude), git identity, and tool discovery
all live in the user's profile, which SYSTEM/service accounts don't have. An
S4U-logon task gives exactly that: runs the user's account with no password
stored and no login required. (S4U tokens have no network credentials; local
agents + token-gated HTTP don't need any.)

Registering an S4U/boot task requires elevation, so install/uninstall spawn ONE
elevated PowerShell via UAC (`Start-Process -Verb RunAs`) — the consent prompt
IS the user's approval. Status queries need no elevation.

The task runs `Rezident.exe --service --host <bind>` when frozen (headless, no
window) or `python -m agentos` in dev. Both entry points probe runtime.json
first and exit cleanly if a server is already up, so the service and a manually
launched instance can never double-serve the shared database.
"""

import asyncio
import logging
import os
import subprocess
import sys

from .config import settings
from .paths import BACKEND_DIR, is_frozen

log = logging.getLogger(__name__)

TASK_NAME = "Rezident Service"
_UAC_DECLINED = 125  # our wrapper's marker exit code for a dismissed consent prompt

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _ps_quote(s: str) -> str:
    """Single-quote for PowerShell (embedded quotes doubled)."""
    return "'" + s.replace("'", "''") + "'"


def _service_action(host: str) -> tuple[str, str, str]:
    """(execute, arguments, working_dir) the task should run."""
    if is_frozen():
        exe = sys.executable
        return exe, f"--service --host {host}", str(os.path.dirname(exe))
    # dev: this venv's python, headless module entry; host comes from backend/.env
    return sys.executable, "-m agentos", str(BACKEND_DIR)


async def _run_ps(command: str, timeout: float = 30.0) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=CREATE_NO_WINDOW,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return -1, "timed out"
    return proc.returncode or 0, out.decode("utf-8", "replace").strip()


async def status() -> dict:
    """Installed/state/action of the boot task. Never needs elevation."""
    if os.name != "nt":
        return {"supported": False, "installed": False}
    code, out = await _run_ps(
        f"$t = Get-ScheduledTask -TaskName {_ps_quote(TASK_NAME)} -ErrorAction SilentlyContinue; "
        "if ($t) { $a = $t.Actions | Select-Object -First 1; "
        "@{installed=$true; state=[string]$t.State; execute=$a.Execute; arguments=[string]$a.Arguments} "
        "| ConvertTo-Json -Compress } else { '{\"installed\":false}' }"
    )
    result: dict = {"supported": True, "installed": False, "task_name": TASK_NAME}
    if code == 0 and out:
        import json

        try:
            result.update(json.loads(out.splitlines()[-1]))
        except ValueError:
            log.warning("autostart status parse failed: %r", out[:200])
    return result


async def _run_elevated(script: str, timeout: float = 180.0) -> dict:
    """Write `script` next to the data dir and run it elevated via one UAC prompt.
    The generous timeout is the human deciding on the consent dialog."""
    settings.ensure_dirs()
    path = settings.data_dir / "autostart_action.ps1"
    path.write_text(script, encoding="utf-8-sig")  # BOM so PS 5.1 reads UTF-8
    wrapper = (
        "try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru "
        "-WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"
        f"{_ps_quote(str(path))}); exit $p.ExitCode }} catch {{ exit {_UAC_DECLINED} }}"
    )
    code, out = await _run_ps(wrapper, timeout=timeout)
    if code == 0:
        return {"ok": True, "detail": "done"}
    if code == _UAC_DECLINED:
        return {"ok": False, "detail": "the Windows admin prompt was declined"}
    if code == -1:
        return {"ok": False, "detail": "timed out waiting for the Windows admin prompt"}
    return {"ok": False, "detail": f"the elevated step failed (exit {code}): {out[:200]}"}


async def install(host: str) -> dict:
    """Register (or replace) the boot task and start it now. One UAC prompt."""
    if os.name != "nt":
        return {"ok": False, "detail": "Windows only"}
    execute, arguments, workdir = _service_action(host)
    # Bake the CURRENT user into the principal here: if UAC elevates to a
    # different admin account, $env:USERNAME in the script would be wrong.
    user = f"{os.environ.get('USERDOMAIN', '')}\\{os.environ.get('USERNAME', '')}".strip("\\")
    script = f"""$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute {_ps_quote(execute)} -Argument {_ps_quote(arguments)} -WorkingDirectory {_ps_quote(workdir)}
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId {_ps_quote(user)} -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName {_ps_quote(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Rezident boot-level service (installed from the System page). Starts the agent server at machine boot, before login. Remove from the Rezident System page or Task Scheduler.' -Force | Out-Null
Start-ScheduledTask -TaskName {_ps_quote(TASK_NAME)}
"""
    res = await _run_elevated(script)
    if res["ok"]:
        res["detail"] = f"boot service installed — runs at every startup ({host})"
    return res


async def uninstall() -> dict:
    """Stop the running service instance and remove the task. One UAC prompt."""
    if os.name != "nt":
        return {"ok": False, "detail": "Windows only"}
    script = f"""$ErrorActionPreference = 'Stop'
Stop-ScheduledTask -TaskName {_ps_quote(TASK_NAME)} -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName {_ps_quote(TASK_NAME)} -Confirm:$false
"""
    res = await _run_elevated(script)
    if res["ok"]:
        res["detail"] = "boot service removed"
    return res
