from typing import Any, Literal

from pydantic import BaseModel, Field

TaskStatus = Literal[
    "queued", "running", "awaiting_approval", "waiting_input",
    "verifying", "done", "failed", "cancelled",
]

ACTIVE_STATUSES: tuple[str, ...] = ("queued", "running", "awaiting_approval", "waiting_input", "verifying")
TERMINAL_STATUSES: tuple[str, ...] = ("done", "failed", "cancelled")


class RoundtableParticipant(BaseModel):
    """One seat at a Roundtable, drawn from the /api/agents roster. Exactly one of
    profile_id (a local Claude persona) or integration_key (an integration slot,
    e.g. Codex) identifies the runtime; name/color are the display attribution the
    UI keys off per line. model overrides the persona/slot default for this seat."""
    profile_id: str | None = None
    integration_key: str | None = None
    name: str = Field(min_length=1, max_length=120)
    color: str = "#7fc8ff"
    model: str | None = None


class RoundtableConfig(BaseModel):
    """Carried on a kind='roundtable' task: the ordered LIST of participants (2+,
    extensible) and how many full turn-rounds to run before parking for the
    moderator. mode='decision' (default) runs the consensus protocol and adjourns
    on [CONSENSUS]; mode='dialogue' is a standing group channel — no consensus
    goal, never self-terminates. Persisted as JSON in tasks.roundtable."""
    participants: list[RoundtableParticipant] = Field(default_factory=list)
    rounds: int = Field(default=3, ge=1, le=20)
    mode: Literal["decision", "dialogue"] = "decision"


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1)
    kind: Literal["general", "repo", "chat", "roundtable"] = "general"
    cwd: str | None = None
    repo_path: str | None = None
    base_branch: str | None = None
    verify_command: str | None = None
    profile_id: str | None = None
    integration_key: str | None = None  # run on an external runtime instead of local Claude
    model: str | None = None
    max_turns: int | None = None
    parent_task_id: str | None = None  # resume the parent's agent session (chat re-open, retry)
    roundtable: RoundtableConfig | None = None  # participants + rounds for a kind='roundtable' session


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
    roundtable: str | None = None  # JSON blob for a kind='roundtable' task (participants + rounds)
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
