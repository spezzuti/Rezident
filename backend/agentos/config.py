import json
import os
import secrets
import shutil
import sqlite3
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .paths import (
    BACKEND_DIR,
    PROJECT_DIR,
    default_data_dir,
    default_host,
    env_file,
)

# Re-exported for callers that historically imported these from config.
__all__ = [
    "settings", "Settings", "resolve_claude_cli", "ensure_token", "BACKEND_DIR", "PROJECT_DIR",
    "insecure_lan_allowed", "resolve_bind_host", "record_bind", "bind_state",
    "SECURITY_LAN_KEY", "LOOPBACK_FALLBACK",
]


def _default_git_bash() -> Path:
    """Probe for Git Bash (verify.py runs `bash.exe -lc`). Never `which('bash')`
    — that can resolve WSL/MSYS bash that isn't Git-for-Windows. Prefer the
    bash.exe that sits next to a discovered git.exe, then the usual install dirs.
    Overridable via AGENTOS_GIT_BASH_PATH."""
    candidates: list[Path] = []
    git = shutil.which("git")
    if git:
        # .../Git/cmd/git.exe -> .../Git/bin/bash.exe
        candidates.append(Path(git).resolve().parent.parent / "bin" / "bash.exe")
    candidates += [
        Path(r"C:\Program Files\Git\bin\bash.exe"),
        Path(r"C:\Program Files (x86)\Git\bin\bash.exe"),
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Git" / "bin" / "bash.exe",
    ]
    for c in candidates:
        try:
            if c.exists():
                return c
        except OSError:
            continue
    return Path(r"C:\Program Files\Git\bin\bash.exe")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="AGENTOS_",
        env_file=env_file(),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    token: str = ""
    host: str = Field(default_factory=default_host)
    port: int = 8734
    # LAN-exposure override (security). When false (the default) a non-loopback
    # bind request (0.0.0.0/::/a LAN IP) is downgraded to 127.0.0.1 so the bearer
    # token never crosses a plain-http LAN. Set AGENTOS_ALLOW_INSECURE_LAN=1 (env
    # or backend/.env) OR flip the security:allow_insecure_lan settings key from the
    # UI to opt in. Prefer Tailscale over this. See insecure_lan_allowed().
    allow_insecure_lan: bool = False
    data_dir: Path = Field(default_factory=default_data_dir)
    max_concurrent: int = 2
    git_bash_path: Path = Field(default_factory=_default_git_bash)
    claude_cli_path: Path = Path.home() / ".local" / "bin" / "claude.exe"
    verify_timeout_seconds: int = 600
    # A running (not approval-parked) local task that emits no stream activity for
    # this long is considered wedged and auto-failed. 0 disables. Overridable via
    # AGENTOS_TASK_IDLE_TIMEOUT_SECONDS.
    task_idle_timeout_seconds: int = 900
    # Soft per-agent home-directory budget (docs/agent-homes.md): homes over this
    # size get flagged in both UIs and in the dreams digest. Advisory only —
    # nothing is deleted. 0 disables. AGENTOS_HOME_SIZE_BUDGET_MB overrides.
    home_size_budget_mb: int = 200
    # Dispatcher lease: exactly one live instance drains the queue and fires
    # schedules against the shared DB; a standby seizes the lease only after the
    # holder's heartbeat has been stale for this long (the TTL). The holder renews
    # every ttl//3 seconds, so a real holder never loses the lease to its own
    # latency. Overridable via AGENTOS_DISPATCH_LEASE_TTL_SECONDS.
    dispatch_lease_ttl_seconds: int = 30

    @property
    def db_path(self) -> Path:
        return self.data_dir / "agentos.db"

    @property
    def worktrees_dir(self) -> Path:
        return self.data_dir / "worktrees"

    @property
    def scratch_dir(self) -> Path:
        return self.data_dir / "scratch"

    @property
    def token_path(self) -> Path:
        return self.data_dir / "token"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.worktrees_dir, self.scratch_dir):
            d.mkdir(parents=True, exist_ok=True)


settings = Settings()


# ---- LAN-exposure policy (single source of truth) -----------------------------
# The server must never bind a non-loopback interface (0.0.0.0/::/a LAN IP) by
# default: the page is served over plain http on a LAN, so the long-lived bearer
# token would cross the wire in the Authorization header AND the ws:// URL, where
# anyone doing ARP/DNS/LAN interception can lift it. Non-loopback binding is
# therefore OPT-IN behind an explicit operator override; without it a LAN request
# downgrades to loopback (a running local server beats a dead one) and records a
# warning the UIs surface. Tailscale is the recommended remote-access path.

SECURITY_LAN_KEY = "security:allow_insecure_lan"  # settings-table key mirrored by the UI toggle
LOOPBACK_FALLBACK = "127.0.0.1"
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

# Filled in by the launcher (serve()/desktop main()) at bind time so the API and
# the readiness checklist can report what actually happened — requested vs the
# effective host, and whether a LAN request was downgraded.
_bind_state: dict = {"requested": None, "effective": None, "downgraded": False, "warning": None}


def _env_truthy(name: str) -> bool:
    v = os.environ.get(name)
    return v is not None and v.strip().lower() in ("1", "true", "yes", "on")


def _read_security_lan_setting() -> bool:
    """Read the security:allow_insecure_lan key straight from the SQLite settings
    table with a short-lived sync connection. Done synchronously (not via the async
    db layer) because the bind host is resolved at process startup — BEFORE the
    async DB connects — and this same function also serves request handlers. Missing
    file / missing table / any error → False (the safe, loopback default)."""
    try:
        db_path = settings.db_path
        if not db_path.exists():  # never let a probe create an empty db file
            return False
        con = sqlite3.connect(str(db_path), timeout=1.0)
        try:
            cur = con.execute("SELECT value FROM settings WHERE key = ?", (SECURITY_LAN_KEY,))
            row = cur.fetchone()
        finally:
            con.close()
    except (sqlite3.Error, OSError):
        return False
    if not row or row[0] is None:
        return False
    try:  # stored as JSON true/false (mirrors the integrations JSON-in-settings pattern)
        return bool(json.loads(row[0]))
    except (TypeError, ValueError):
        return str(row[0]).strip().lower() in ("1", "true", "yes", "on")


def insecure_lan_allowed() -> bool:
    """True iff the operator has explicitly opted into non-loopback (LAN) binding,
    via EITHER the AGENTOS_ALLOW_INSECURE_LAN env/.env override OR the
    security:allow_insecure_lan settings-table key."""
    # real env var first (dynamic; also how tests toggle it), then the pydantic
    # field (covers backend/.env), then the persisted settings-table key.
    if _env_truthy("AGENTOS_ALLOW_INSECURE_LAN"):
        return True
    if getattr(settings, "allow_insecure_lan", False):
        return True
    return _read_security_lan_setting()


def is_loopback_host(host: str) -> bool:
    return (host or "").strip().lower() in _LOOPBACK_HOSTS


def resolve_bind_host(requested: str) -> tuple[str, str | None]:
    """Map a requested bind host to the effective one under the LAN policy.

    Returns (effective_host, warning). Loopback passes through untouched. A
    non-loopback host binds as-requested only when insecure_lan_allowed(); otherwise
    it downgrades to 127.0.0.1 and returns a warning explaining how to opt in."""
    req = (requested or "").strip() or LOOPBACK_FALLBACK
    if is_loopback_host(req):
        return req, None
    if insecure_lan_allowed():
        return req, None
    warning = (
        f"LAN binding refused: '{req}' would expose Rezident on the local network in "
        "plaintext (the bearer token rides an unencrypted LAN). Bound to 127.0.0.1 "
        "instead. Set AGENTOS_ALLOW_INSECURE_LAN=1 or enable 'Allow LAN access' in "
        "Settings to override (prefer Tailscale)."
    )
    return LOOPBACK_FALLBACK, warning


def record_bind(requested: str, effective: str, warning: str | None) -> None:
    """Record the launcher's bind decision so the API/checklist can report it."""
    _bind_state.update(
        requested=requested, effective=effective,
        downgraded=warning is not None, warning=warning,
    )


def bind_state() -> dict:
    """The current bind decision. When the launcher hasn't recorded one (e.g. a raw
    `uvicorn agentos.main:app` invocation), fall back to computing it from
    settings.host so the reported state still reflects the active policy."""
    if _bind_state["effective"] is not None:
        return dict(_bind_state)
    requested = settings.host
    effective, warning = resolve_bind_host(requested)
    return {"requested": requested, "effective": effective,
            "downgraded": warning is not None, "warning": warning}


def resolve_claude_cli() -> Path | None:
    """The single source of truth for where the `claude` CLI lives, used by BOTH
    the agent runner and the readiness check so they never disagree.

    The SDK uses ClaudeAgentOptions.cli_path verbatim and only falls back to its
    own PATH search when it is None — so a wrong-but-set path fails fatally. This
    returns a real path or None (let the SDK resolve), never a dead guess.
    Order: env override -> configured path -> PATH -> known Windows locations.
    """
    env = os.environ.get("AGENTOS_CLAUDE_CLI_PATH")
    if env and Path(env).exists():
        return Path(env)
    try:
        if settings.claude_cli_path.exists():
            return settings.claude_cli_path
    except OSError:
        pass
    found = shutil.which("claude")
    if found:
        return Path(found)
    for c in (
        Path.home() / ".local" / "bin" / "claude.exe",
        Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "claude" / "claude.exe",
    ):
        try:
            if str(c) and c.exists():
                return c
        except OSError:
            continue
    return None


def _read_token_file(tf: Path) -> str:
    """Trimmed token file contents, or "" when absent/unreadable/blank. A blank or
    truncated file (killed mid-write, disk-full, AV) reads as "" so a corrupt token
    self-heals instead of 401ing forever."""
    try:
        return tf.read_text(encoding="utf-8").strip() if tf.exists() else ""
    except OSError:
        return ""


def ensure_token() -> str:
    """Return the API token, provisioning one on first run when none is configured.

    Dev supplies AGENTOS_TOKEN via backend/.env; the desktop app generates one
    once and persists it to <data_dir>/token, reusing it on every later launch.

    Provisioning is race-safe: two simultaneous first launches must not each write
    a DIFFERENT token and clobber the file, leaving settings.token disagreeing with
    the file the GUI attaches to. We create the file with O_EXCL (only one writer
    can win the create) and ALWAYS re-read the on-disk value afterwards, so a loser
    adopts the winner's token. Single-launch behavior is unchanged. (Pairs with the
    desktop single-instance mutex, but is correct on its own.)
    """
    if settings.token:
        return settings.token
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    tf = settings.token_path
    tok = _read_token_file(tf)
    if not tok:
        candidate = secrets.token_urlsafe(32)
        try:
            # Exclusive create: the winner writes; a concurrent launcher hits
            # FileExistsError and falls through to re-read the winner's token.
            fd = os.open(tf, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                os.write(fd, candidate.encode("utf-8"))
            finally:
                os.close(fd)
        except FileExistsError:
            pass
        tok = _read_token_file(tf)
        if not tok:
            # The file exists but is blank/truncated (corrupt) — O_EXCL can't heal
            # that, so replace it atomically and re-read so all racers converge on
            # one value. A temp-then-rename keeps a reader from ever seeing a partial
            # write.
            tmp = tf.with_name(tf.name + f".{os.getpid()}.tmp")
            try:
                tmp.write_text(candidate, encoding="utf-8")
                os.replace(tmp, tf)
            except OSError:
                # A rival racer may still hold the freshly-created file open (no
                # FILE_SHARE_DELETE on Windows) — the replace loses. That's fine:
                # re-read below adopts whatever the winner wrote; never let this
                # bubble out of boot-critical provisioning.
                pass
            finally:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
            tok = _read_token_file(tf) or candidate
    settings.token = tok
    return tok
