"""Per-agent home directories (docs/agent-homes.md): a durable workspace per
LOCAL persona under data\\homes\\<profile_id>. Memory holds what an agent
learned; the home holds what it made. Each home is git-fenced individually so
Claude Code resolves it as the project root — personas can't walk up into the
Rezident repo or sideways into each other's homes.
"""

import logging
import shutil
import subprocess
from pathlib import Path

from .config import settings

log = logging.getLogger(__name__)

LIST_CAP = 200  # newest-first entries returned by list_home


def home_dir(profile_id: str) -> Path:
    return settings.data_dir / "homes" / profile_id


def ensure_home(profile_id: str) -> Path:
    """Create (and git-fence) the home on first use. A git-less machine
    degrades to an unfenced dir — same graceful fallback as the scratch fence."""
    home = home_dir(profile_id)
    home.mkdir(parents=True, exist_ok=True)
    if not (home / ".git").exists():
        if shutil.which("git"):
            subprocess.run(["git", "init", "-q"], cwd=home, check=False, capture_output=True)
        else:
            log.warning("git not found — home %s is not fenced", profile_id)
    return home


def _walk(profile_id: str) -> list[tuple[Path, int, float]]:
    """(path, size, mtime) for every regular file in the home, .git excluded.
    Unreadable entries are skipped — stats must never take a request down."""
    home = home_dir(profile_id)
    out: list[tuple[Path, int, float]] = []
    if not home.is_dir():
        return out
    for p in home.rglob("*"):
        if ".git" in p.parts:
            continue
        try:
            if p.is_file():
                st = p.stat()
                out.append((p.relative_to(home), st.st_size, st.st_mtime))
        except OSError:
            continue
    return out


def home_stats(profile_id: str) -> dict:
    """Cheap summary for roster payloads: {exists, files, bytes, over_budget}."""
    files = _walk(profile_id)
    total = sum(size for _, size, _ in files)
    budget = settings.home_size_budget_mb * 1024 * 1024
    return {
        "exists": home_dir(profile_id).is_dir(),
        "files": len(files),
        "bytes": total,
        "over_budget": bool(budget and total > budget),
    }


def list_home(profile_id: str) -> dict:
    """Full newest-first listing for the UI drawer, capped at LIST_CAP."""
    files = sorted(_walk(profile_id), key=lambda f: f[2], reverse=True)
    return {
        "path": str(home_dir(profile_id)),
        "exists": home_dir(profile_id).is_dir(),
        "count": len(files),
        "bytes": sum(size for _, size, _ in files),
        "truncated": len(files) > LIST_CAP,
        "files": [
            {"path": str(rel).replace("\\", "/"), "size": size, "mtime": mtime}
            for rel, size, mtime in files[:LIST_CAP]
        ],
    }


PREVIEW_CAP = 200_000  # bytes of text shown inline; download serves the full file


def resolve_file(profile_id: str, rel: str) -> Path:
    """Resolve a listing path INSIDE the home or refuse: ValueError on any
    escape attempt (.., absolute paths, symlink hops, .git), FileNotFoundError
    when it simply isn't there. Every file endpoint goes through here."""
    home = home_dir(profile_id).resolve()
    p = (home / rel).resolve()
    if p == home or not p.is_relative_to(home):
        raise ValueError("path escapes the home")
    if ".git" in p.relative_to(home).parts:
        raise ValueError("path escapes the home")  # .git is hidden from listings too
    if not p.is_file():
        raise FileNotFoundError(rel)
    return p


def read_preview(profile_id: str, rel: str) -> dict:
    """Inline preview: UTF-8 text capped at PREVIEW_CAP; binaries are flagged
    (download still works for them)."""
    p = resolve_file(profile_id, rel)
    st = p.stat()
    raw = p.read_bytes()[: PREVIEW_CAP + 1]
    truncated = len(raw) > PREVIEW_CAP
    raw = raw[:PREVIEW_CAP]
    try:
        content: str | None = raw.decode("utf-8")
        binary = False
    except UnicodeDecodeError:
        content = None
        binary = True
    return {
        "path": rel, "size": st.st_size, "mtime": st.st_mtime,
        "binary": binary, "truncated": truncated, "content": content,
    }


def delete_home(profile_id: str) -> bool:
    """Remove the home tree (companion deleted). Best-effort: a locked file
    leaves remnants behind rather than failing the profile delete."""
    home = home_dir(profile_id)
    if not home.exists():
        return False
    shutil.rmtree(home, ignore_errors=True)
    return not home.exists()
