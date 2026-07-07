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
from .config import resolve_claude_cli, settings

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


def _safe_exists(p: Path) -> bool:
    try:
        return p.exists()
    except OSError:
        return False


def _webview2_present() -> bool:
    """Detect the Edge WebView2 Evergreen runtime (the desktop window's renderer)
    via its EdgeUpdate registration. Best-effort; absence just means the app
    opens in the default browser instead of a native window."""
    try:
        import winreg
    except ImportError:
        return False
    guid = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    locations = [
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{guid}"),
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{guid}"),
        (winreg.HKEY_CURRENT_USER, rf"Software\Microsoft\EdgeUpdate\Clients\{guid}"),
    ]
    for root, path in locations:
        try:
            with winreg.OpenKey(root, path) as key:
                pv, _ = winreg.QueryValueEx(key, "pv")
                if pv and pv != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


def readiness() -> dict:
    """First-run dependency gate: are the things a task needs actually present?

    Cheap and side-effect-free (no binary probing beyond PATH lookups and a
    registry read) so it can back an UNauthenticated endpoint the desktop shell
    calls before a token exists. The Claude sign-in check only tests for the
    presence of ~/.claude — it never reads credential contents.
    """
    claude = resolve_claude_cli()
    claude_home = Path.home() / ".claude"
    git = shutil.which("git")
    checks = [
        {
            "key": "claude_cli", "label": "Claude Code CLI", "severity": "required",
            "ok": claude is not None,
            "detail": str(claude) if claude else "not found on PATH",
            "fix_hint": "Install Claude Code so the `claude` command is on PATH.",
            "fix_url": "https://docs.claude.com/en/docs/claude-code/setup",
        },
        {
            "key": "claude_auth", "label": "Claude signed in", "severity": "required",
            "ok": _safe_exists(claude_home),
            "detail": str(claude_home),
            "fix_hint": "Run `claude` once and complete /login with your subscription.",
            "fix_url": "",
        },
        {
            "key": "git_bash", "label": "Git Bash (verify commands)", "severity": "recommended",
            "ok": _safe_exists(settings.git_bash_path),
            "detail": str(settings.git_bash_path),
            "fix_hint": "Install Git for Windows — bash.exe runs verify commands.",
            "fix_url": "https://git-scm.com/download/win",
        },
        {
            "key": "git", "label": "Git", "severity": "recommended",
            "ok": git is not None,
            "detail": git or "not found on PATH",
            "fix_hint": "Install Git for Windows for repo tasks and scratch fencing.",
            "fix_url": "https://git-scm.com/download/win",
        },
        {
            "key": "webview2", "label": "Edge WebView2 runtime", "severity": "optional",
            "ok": _webview2_present(),
            "detail": "native window renderer (preinstalled on Windows 11)",
            "fix_hint": "Optional — without it AgentOS opens in your default browser.",
            "fix_url": "https://developer.microsoft.com/microsoft-edge/webview2/",
        },
    ]
    required_ok = all(c["ok"] for c in checks if c["severity"] == "required")
    return {"ok": required_ok, "checks": checks, "agentos_version": __version__}


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

    # Reuse the readiness gate's checks (single source of truth — no false green),
    # then append the state/remote rows the full Setup page also shows.
    db_exists = _safe_exists(settings.db_path)
    checklist = readiness()["checks"] + [
        {
            "key": "db", "label": "State database", "severity": "optional",
            "ok": db_exists,
            "detail": f"{settings.db_path} ({settings.db_path.stat().st_size // 1024} KB)" if db_exists else str(settings.db_path),
        },
        {
            "key": "tailscale", "label": "Tailscale (remote access)", "severity": "optional",
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
