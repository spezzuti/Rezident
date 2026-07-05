import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import settings
from .db import db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("agentos")

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.token:
        raise RuntimeError(
            "AGENTOS_TOKEN is not set. Generate one:\n"
            '  python -c "import secrets; print(secrets.token_urlsafe(32))"\n'
            "and put AGENTOS_TOKEN=<value> in backend/.env"
        )
    # The SDK spawns claude.exe; make sure it's findable even when the backend
    # runs as a service where PATH differs from an interactive shell.
    cli_dir = str(settings.claude_cli_path.parent)
    if cli_dir not in os.environ.get("PATH", ""):
        os.environ["PATH"] = cli_dir + os.pathsep + os.environ.get("PATH", "")

    settings.ensure_dirs()
    _fence_scratch_dir()
    await db.connect()

    from .scheduler import scheduler
    from .task_manager import manager

    await manager.start()
    await scheduler.start()
    log.info("AgentOS up on %s:%s (db: %s)", settings.host, settings.port, settings.db_path)
    try:
        yield
    finally:
        from .orchestrator import orchestrator

        await orchestrator.shutdown()
        await scheduler.stop()
        await manager.shutdown()
        await db.close()


def _fence_scratch_dir() -> None:
    """Make the scratch dir its own git repo. Claude Code resolves its project
    root by walking up to the nearest .git — without this fence, general tasks
    running in data/scratch would see the AgentOS repo itself as their project
    and write files there."""
    import subprocess

    scratch_git = settings.scratch_dir / ".git"
    if not scratch_git.exists():
        subprocess.run(
            ["git", "init", "-q"], cwd=settings.scratch_dir, check=False, capture_output=True
        )


def create_app() -> FastAPI:
    app = FastAPI(title="AgentOS", lifespan=lifespan)

    from .api import approvals, memory, pipelines, profiles, schedules, system, tasks, ws

    app.include_router(system.router)
    app.include_router(tasks.router)
    app.include_router(approvals.router)
    app.include_router(memory.router)
    app.include_router(pipelines.router)
    app.include_router(profiles.router)
    app.include_router(schedules.router)
    app.include_router(ws.router)

    if FRONTEND_DIST.exists():
        app.mount("/", SPAStaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
    return app


class SPAStaticFiles(StaticFiles):
    """Serve the built frontend with SPA fallback to index.html."""

    async def get_response(self, path: str, scope):
        from starlette.exceptions import HTTPException as StarletteHTTPException

        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404:
                return await super().get_response("index.html", scope)
            raise


app = create_app()
