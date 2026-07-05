"""Git worktree manager for repo tasks.

Each repo task gets `data/worktrees/<task_id>` on branch `agentos/<date>-<slug>`
cut from the task's base branch. The user's main checkout is never touched
while the agent works. Worktrees are removed only by explicit merge/discard.
"""

import asyncio
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from .config import settings

log = logging.getLogger(__name__)


class GitError(RuntimeError):
    pass


async def _git(*args: str, cwd: str | Path) -> str:
    proc = await asyncio.create_subprocess_exec(
        "git", *args, cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise GitError(f"git {' '.join(args)} failed: {err.decode(errors='replace').strip()}")
    return out.decode(errors="replace")


def _slug(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s[:40] or "task"


async def create_worktree(task: dict) -> tuple[str, str]:
    """Returns (worktree_path, branch)."""
    repo = task["repo_path"]
    if not repo or not Path(repo, ".git").exists():
        raise GitError(f"not a git repository: {repo}")
    base = task.get("base_branch") or (await _git("rev-parse", "--abbrev-ref", "HEAD", cwd=repo)).strip()
    date = datetime.now(timezone.utc).strftime("%Y%m%d")
    branch = f"agentos/{date}-{_slug(task['title'])}-{task['id'][:8]}"
    wt_path = settings.worktrees_dir / task["id"]
    await _git("worktree", "add", str(wt_path), "-b", branch, base, cwd=repo)
    log.info("worktree created for task %s: %s (branch %s)", task["id"], wt_path, branch)
    return str(wt_path), branch


async def get_diff(task: dict) -> str:
    wt = task.get("worktree_path")
    if not wt or not Path(wt).exists():
        return ""
    base = task.get("base_branch") or "HEAD"
    # Track untracked files so they show in the diff, without staging content.
    await _git("add", "-N", ".", cwd=wt)
    try:
        return await _git("diff", base, cwd=wt)
    except GitError:
        return await _git("diff", "HEAD", cwd=wt)


async def merge(task: dict) -> str:
    """Commit any uncommitted work in the worktree, then merge the branch into
    the base branch in the main repo. Requires the main checkout to be on the
    base branch and clean enough to merge."""
    repo, wt, branch = task["repo_path"], task["worktree_path"], task["branch"]
    base = task.get("base_branch")
    if not (repo and wt and branch):
        raise GitError("task has no worktree to merge")

    status = (await _git("status", "--porcelain", cwd=wt)).strip()
    if status:
        await _git("add", "-A", cwd=wt)
        await _git("commit", "-m", f"AgentOS: {task['title']}", cwd=wt)

    current = (await _git("rev-parse", "--abbrev-ref", "HEAD", cwd=repo)).strip()
    if base and current != base:
        raise GitError(
            f"main checkout is on '{current}' but the task branched from '{base}' — "
            f"switch branches (or merge manually) first"
        )
    await _git("merge", "--no-ff", branch, "-m", f"Merge AgentOS task: {task['title']}", cwd=repo)
    await remove_worktree(task, delete_branch=True)
    return f"merged {branch} into {current}"


async def discard(task: dict) -> str:
    await remove_worktree(task, delete_branch=True)
    return "worktree and branch discarded"


async def remove_worktree(task: dict, delete_branch: bool = False) -> None:
    repo, wt, branch = task["repo_path"], task.get("worktree_path"), task.get("branch")
    if wt and Path(wt).exists():
        try:
            await _git("worktree", "remove", "--force", wt, cwd=repo)
        except GitError as exc:
            # Windows: locked files (node_modules, running processes) block
            # removal — prune metadata and surface the leftover directory.
            log.warning("worktree remove failed (%s); pruning", exc)
            await _git("worktree", "prune", cwd=repo)
            raise GitError(
                f"worktree metadata pruned but files remain at {wt} (locked?) — delete manually"
            ) from exc
    if delete_branch and branch:
        try:
            await _git("branch", "-D", branch, cwd=repo)
        except GitError:
            pass  # already gone


async def prune_all(repo: str) -> None:
    try:
        await _git("worktree", "prune", cwd=repo)
    except GitError:
        pass
