"""Phase 3 E2E: repo task in an isolated worktree, diff, merge.

Creates a throwaway git repo with a tiny python CLI, asks the agent to add a
--version flag (verify: the flag works), then checks worktree isolation,
diff contents, and merge back to the base branch.
"""

import asyncio
import json
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
TOKEN = (BACKEND / ".env").read_text().strip().split("=", 1)[1]
BASE = "http://127.0.0.1:8734"


def rest(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())


def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


async def main() -> int:
    repo = Path(tempfile.mkdtemp(prefix="agentos_repo_"))
    try:
        git("init", "-b", "main", cwd=repo)
        git("config", "user.email", "test@agentos.local", cwd=repo)
        git("config", "user.name", "AgentOS Test", cwd=repo)
        (repo / "cli.py").write_text(
            'import sys\n\ndef main():\n    print("hello from mycli")\n\nif __name__ == "__main__":\n    main()\n'
        )
        git("add", "-A", cwd=repo)
        git("commit", "-m", "initial", cwd=repo)
        head_before = git("rev-parse", "HEAD", cwd=repo).strip()

        t = rest("POST", "/api/tasks", {
            "title": "add version flag",
            "prompt": "In this repo, edit cli.py so that running `python cli.py --version` prints exactly: mycli 1.0.0"
                      " (and plain `python cli.py` still prints the hello message).",
            "kind": "repo",
            "repo_path": str(repo),
            "base_branch": "main",
            "verify_command": 'python cli.py --version | grep -qx "mycli 1.0.0"',
        })
        tid = t["id"]
        print(f"created repo task {tid}")

        for _ in range(80):
            await asyncio.sleep(3)
            task = rest("GET", f"/api/tasks/{tid}")
            if task["status"] == "awaiting_approval":
                for a in rest("GET", "/api/approvals?status=pending"):
                    if a["task_id"] == tid:
                        print(f"  approving: {a['tool_name']} {str(a['tool_input'])[:100]}")
                        rest("POST", f"/api/approvals/{a['id']}/resolve", {"action": "approve"})
            if task["status"] in ("done", "failed", "cancelled"):
                break
        print(f"final: {task['status']}  error: {task.get('error')}")
        if task["status"] != "done":
            return 1

        wt = task["worktree_path"]
        print(f"worktree: {wt}  branch: {task['branch']}")
        wt_listed = git("worktree", "list", cwd=repo)
        assert task["id"] in wt_listed, "worktree not listed"

        main_untouched = git("rev-parse", "HEAD", cwd=repo).strip() == head_before
        main_clean = git("status", "--porcelain", cwd=repo).strip() == ""
        print(f"main checkout untouched: {main_untouched and main_clean}")

        diff = rest("GET", f"/api/tasks/{tid}/diff")["diff"]
        diff_ok = "--version" in diff and "cli.py" in diff
        print(f"diff contains change: {diff_ok} ({len(diff)} chars)")

        merged = rest("POST", f"/api/tasks/{tid}/worktree/merge")
        print(f"merge: {merged['message']}")
        out = subprocess.run(["python", "cli.py", "--version"], cwd=repo, capture_output=True, text=True)
        merged_works = out.stdout.strip() == "mycli 1.0.0"
        print(f"merged code works on main: {merged_works} (got {out.stdout.strip()!r})")
        wt_gone = not Path(wt).exists()
        print(f"worktree cleaned up: {wt_gone}")

        ok = all([main_untouched, main_clean, diff_ok, merged_works, wt_gone])
        print(f"\nE2E REPO {'PASS' if ok else 'FAIL'}")
        return 0 if ok else 1
    finally:
        shutil.rmtree(repo, ignore_errors=True)


raise SystemExit(asyncio.run(main()))
