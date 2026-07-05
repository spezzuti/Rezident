from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="AGENTOS_",
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    token: str = ""
    host: str = "0.0.0.0"
    port: int = 8734
    data_dir: Path = PROJECT_DIR / "data"
    max_concurrent: int = 2
    git_bash_path: Path = Path(r"C:\Program Files\Git\bin\bash.exe")
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

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.worktrees_dir, self.scratch_dir):
            d.mkdir(parents=True, exist_ok=True)


settings = Settings()
