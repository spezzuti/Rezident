"""Machine environment scan: which agent CLIs and tools live on this box.

Powers the System/Setup page — the OS recognizes what's installed the way
Hermes' onboarding does, and surfaces integration slots for external agent
systems (Hermes, OpenClaw, and the user's own "redacted" later).
"""

import asyncio
import shutil
import time
from pathlib import Path

from . import __version__
from .config import settings

# (key, display name, binary candidates, version args, blurb)
KNOWN_AGENTS: list[tuple[str, str, list[str], list[str], str]] = [
    ("claude", "Claude Code", ["claude"], ["--version"], "Anthropic's agentic CLI — AgentOS's engine"),
    ("codex", "OpenAI Codex CLI", ["codex"], ["--version"], "OpenAI's coding agent"),
    ("gemini", "Gemini CLI", ["gemini"], ["--version"], "Google's coding agent"),
    ("openclaw", "OpenClaw", ["openclaw", "claw"], ["--version"], "Browser-operating agent"),
    ("hermes", "Hermes", ["hermes"], ["--version"], "Hermes agent runtime"),
    ("aider", "Aider", ["aider"], ["--version"], "Open-source pair programmer"),
    ("ollama", "Ollama", ["ollama"], ["--version"], "Local model runtime"),
    ("gh", "GitHub CLI", ["gh"], ["--version"], "GitHub operations"),
    ("docker", "Docker", ["docker"], ["--version"], "Container runtime"),
    ("node", "Node.js", ["node"], ["--version"], "JS runtime"),
    ("python", "Python", ["python"], ["--version"], "Python runtime"),
    ("git", "Git", ["git"], ["--version"], "Version control"),
]

_cache: dict = {"ts": 0.0, "data": None}
CACHE_SECONDS = 120


async def _probe(binary: str, version_args: list[str]) -> str | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, *version_args,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=8)
        first = out.decode(errors="replace").strip().splitlines()
        return first[0][:80] if first else ""
    except (asyncio.TimeoutError, OSError):
        return None


async def scan(force: bool = False) -> dict:
    now = time.monotonic()
    if not force and _cache["data"] is not None and now - _cache["ts"] < CACHE_SECONDS:
        return _cache["data"]

    async def probe_agent(key: str, name: str, bins: list[str], vargs: list[str], blurb: str) -> dict:
        for candidate in bins:
            path = shutil.which(candidate)
            if path:
                version = await _probe(path, vargs)
                return {
                    "key": key, "name": name, "installed": True, "path": path,
                    "version": version or "installed (version unknown)", "blurb": blurb,
                }
        return {"key": key, "name": name, "installed": False, "path": None, "version": None, "blurb": blurb}

    agents = await asyncio.gather(*(probe_agent(*spec) for spec in KNOWN_AGENTS))

    claude_home = Path.home() / ".claude"
    checklist = [
        {
            "key": "claude_cli", "label": "Claude Code CLI",
            "ok": settings.claude_cli_path.exists() or shutil.which("claude") is not None,
            "detail": str(settings.claude_cli_path),
        },
        {
            "key": "claude_auth", "label": "Claude authenticated",
            "ok": claude_home.exists(),
            "detail": str(claude_home),
        },
        {
            "key": "git_bash", "label": "Git Bash (verify commands)",
            "ok": settings.git_bash_path.exists(),
            "detail": str(settings.git_bash_path),
        },
        {
            "key": "db", "label": "State database",
            "ok": settings.db_path.exists(),
            "detail": f"{settings.db_path} ({settings.db_path.stat().st_size // 1024} KB)" if settings.db_path.exists() else str(settings.db_path),
        },
        {
            "key": "tailscale", "label": "Tailscale (remote access)",
            "ok": shutil.which("tailscale") is not None,
            "detail": "optional — for phone access away from home",
        },
    ]

    try:
        import claude_agent_sdk
        sdk_version = getattr(claude_agent_sdk, "__version__", "unknown")
    except ImportError:
        sdk_version = "not installed"

    data = {
        "agentos_version": __version__,
        "sdk_version": sdk_version,
        "agents": agents,
        "checklist": checklist,
        "scanned_at": time.time(),
    }
    _cache.update(ts=now, data=data)
    return data
