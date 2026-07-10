import os
import secrets
import shutil
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
__all__ = ["settings", "Settings", "resolve_claude_cli", "ensure_token", "BACKEND_DIR", "PROJECT_DIR"]


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
