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


def ensure_token() -> str:
    """Return the API token, provisioning one on first run when none is configured.

    Dev supplies AGENTOS_TOKEN via backend/.env; the desktop app generates one
    once and persists it to <data_dir>/token, reusing it on every later launch.
    """
    if settings.token:
        return settings.token
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    tf = settings.token_path
    # Treat a blank/truncated existing file (killed mid-write, disk-full, AV) the
    # same as a missing one, so a corrupt token self-heals instead of 401ing forever.
    tok = tf.read_text(encoding="utf-8").strip() if tf.exists() else ""
    if not tok:
        tok = secrets.token_urlsafe(32)
        tf.write_text(tok, encoding="utf-8")
    settings.token = tok
    return tok
