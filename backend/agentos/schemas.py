from typing import Any, Literal

from pydantic import BaseModel, Field

TaskStatus = Literal[
    "queued", "running", "awaiting_approval", "waiting_input",
    "verifying", "done", "failed", "cancelled",
]

ACTIVE_STATUSES: tuple[str, ...] = ("queued", "running", "awaiting_approval", "waiting_input", "verifying")
TERMINAL_STATUSES: tuple[str, ...] = ("done", "failed", "cancelled")


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1)
    kind: Literal["general", "repo"] = "general"
    cwd: str | None = None
    repo_path: str | None = None
    base_branch: str | None = None
    verify_command: str | None = None
    profile_id: str | None = None
    model: str | None = None
    max_turns: int | None = None


class Task(BaseModel):
    id: str
    title: str
    prompt: str
    kind: str
    status: str
    repo_path: str | None = None
    base_branch: str | None = None
    branch: str | None = None
    worktree_path: str | None = None
    cwd: str | None = None
    verify_command: str | None = None
    profile_id: str | None = None
    model: str | None = None
    max_turns: int | None = None
    session_id: str | None = None
    schedule_id: str | None = None
    parent_task_id: str | None = None
    total_cost_usd: float = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    num_turns: int | None = None
    result_summary: str | None = None
    error: str | None = None
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None


class TaskEvent(BaseModel):
    task_id: str
    seq: int
    ts: str
    type: str
    payload: dict[str, Any]


class MessageIn(BaseModel):
    text: str = Field(min_length=1)
