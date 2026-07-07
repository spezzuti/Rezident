"""SQLite access layer: single aiosqlite connection, WAL mode, versioned migrations.

All writes are serialized through one connection guarded by an asyncio.Lock —
event volume is modest (hundreds of rows per task) so a single writer holds easily.
"""

import asyncio
import json
from typing import Any

import aiosqlite

from .config import settings

MIGRATIONS: list[str] = [
    # v1 — core: settings, tasks, task_events (Phase 0/1)
    """
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'general',
        status TEXT NOT NULL DEFAULT 'queued',
        repo_path TEXT,
        base_branch TEXT,
        branch TEXT,
        worktree_path TEXT,
        cwd TEXT,
        verify_command TEXT,
        profile_id TEXT,
        model TEXT,
        max_turns INTEGER,
        session_id TEXT,
        schedule_id TEXT,
        parent_task_id TEXT,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        num_turns INTEGER,
        result_summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        started_at TEXT,
        finished_at TEXT
    );
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_tasks_created ON tasks(created_at DESC);

    CREATE TABLE task_events (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        UNIQUE(task_id, seq)
    );
    CREATE INDEX idx_task_events_task ON task_events(task_id, seq);
    """,
    # v2 — approvals + auto-approve rules (Phase 2)
    """
    CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        resolved_input TEXT,
        deny_reason TEXT,
        matched_rule_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        resolved_at TEXT
    );
    CREATE INDEX idx_approvals_status ON approvals(status);
    CREATE INDEX idx_approvals_task ON approvals(task_id);

    CREATE TABLE auto_approve_rules (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        field TEXT,
        match_type TEXT NOT NULL DEFAULT 'regex',
        pattern TEXT NOT NULL,
        action TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1,
        description TEXT,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Hard denies first (priority 10): things no agent may ever do silently.
    INSERT INTO auto_approve_rules (id, tool_name, field, match_type, pattern, action, priority, description) VALUES
    ('seed-deny-rmrf',     'Bash', 'command', 'regex', 'rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\\s+([/~]|[A-Za-z]:)', 'deny', 10, 'recursive force-delete of root-ish paths'),
    ('seed-deny-push-f',   'Bash', 'command', 'regex', 'git\\s+push\\s+.*(--force|-f)\\b', 'deny', 10, 'force push'),
    ('seed-deny-shutdown', 'Bash', 'command', 'regex', '\\b(shutdown|Restart-Computer|Stop-Computer)\\b', 'deny', 10, 'machine shutdown/restart'),
    ('seed-deny-format',   'Bash', 'command', 'regex', '\\b(mkfs|format\\s+[A-Za-z]:)', 'deny', 10, 'disk format'),
    ('seed-deny-regdel',   'Bash', 'command', 'regex', '\\breg\\s+delete\\b', 'deny', 10, 'registry delete');

    -- Safe allows (priority 50): read-only-ish commands agents use constantly.
    INSERT INTO auto_approve_rules (id, tool_name, field, match_type, pattern, action, priority, description) VALUES
    ('seed-allow-git-ro',  'Bash', 'command', 'regex', '^git\\s+(status|diff|log|show|branch|remote -v)\\b', 'allow', 50, 'read-only git'),
    ('seed-allow-list',    'Bash', 'command', 'regex', '^(ls|dir|pwd|cat|head|tail|wc|grep|find|which|echo)\\b', 'allow', 50, 'read-only shell'),
    ('seed-allow-tests',   'Bash', 'command', 'regex', '^(pytest|python -m pytest|npm test|npm run test|npx vitest)\\b', 'allow', 50, 'run tests');
    """,
    # v3 — memory: facts injected into agent prompts + episode history (Phase 4)
    """
    CREATE TABLE memory_facts (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'user',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        outcome TEXT NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_episodes_created ON episodes(created_at DESC);
    """,
    # v4 — agent profiles (Phase 5)
    """
    CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        system_prompt_append TEXT,
        allowed_tools TEXT NOT NULL DEFAULT '[]',
        disallowed_tools TEXT NOT NULL DEFAULT '[]',
        permission_mode TEXT NOT NULL DEFAULT 'default',
        model TEXT,
        max_turns INTEGER,
        inject_memory INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    INSERT INTO agent_profiles (id, name, description, allowed_tools, disallowed_tools, is_default) VALUES
    ('profile-standard', 'Standard', 'Read-only tools free; everything else goes through rules and approvals.', '[]', '[]', 1),
    ('profile-readonly', 'ReadOnly Researcher', 'Can read and search but never write, edit, or run shell commands.', '[]', '["Write","Edit","MultiEdit","NotebookEdit","Bash"]', 0);
    """,
    # v5 — schedules (Phase 6)
    """
    CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        task_template TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        overlap_policy TEXT NOT NULL DEFAULT 'skip',
        last_run_at TEXT,
        next_run_at TEXT,
        last_task_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    """,
    # v6 — pipelines: multi-stage agent orchestration (V2)
    """
    CREATE TABLE pipelines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        stages TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE pipeline_runs (
        id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        current_stage INTEGER NOT NULL DEFAULT 0,
        stage_count INTEGER NOT NULL DEFAULT 0,
        task_ids TEXT NOT NULL DEFAULT '[]',
        input TEXT,
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        finished_at TEXT
    );
    CREATE INDEX idx_pipeline_runs ON pipeline_runs(pipeline_id, started_at DESC);
    """,
    # v7 — the Pantheon: profiles become named agent personas (V2)
    """
    ALTER TABLE agent_profiles ADD COLUMN icon TEXT DEFAULT '◆';
    ALTER TABLE agent_profiles ADD COLUMN color TEXT DEFAULT '#7fc8ff';
    ALTER TABLE agent_profiles ADD COLUMN role TEXT DEFAULT '';

    UPDATE agent_profiles SET icon='◉', color='#7fc8ff', role='Balanced operator — reads freely, asks before acting'
      WHERE id='profile-standard';
    UPDATE agent_profiles SET icon='◈', color='#c084fc', role='Research specialist — can look but never touch'
      WHERE id='profile-readonly';

    INSERT INTO agent_profiles (id, name, description, system_prompt_append, allowed_tools, disallowed_tools,
                                permission_mode, model, inject_memory, is_default, icon, color, role) VALUES
    ('agent-mercury', 'Mercury', 'Fast courier for routine chores on the cheapest model.',
     'You are Mercury, the swift courier. Be terse and efficient. Do exactly what is asked, nothing more.',
     '[]', '[]', 'default', 'haiku', 1, 0, '☿', '#facc15', 'Routine tasks · scheduled jobs · cheap & fast'),
    ('agent-athena', 'Athena', 'Deep researcher: reads, searches, synthesizes — never modifies anything.',
     'You are Athena, the strategist and researcher. Produce thorough, structured, sourced analysis.',
     '[]', '["Write","Edit","MultiEdit","NotebookEdit","Bash"]', 'default', 'sonnet', 1, 0, '⚚', '#c084fc', 'Deep research · analysis · read-only'),
    ('agent-vulcan', 'Vulcan', 'The forge: heavyweight builder for real engineering work.',
     'You are Vulcan, master of the forge. Build carefully: plan briefly, implement cleanly, verify your work before declaring it done.',
     '[]', '[]', 'default', 'opus', 1, 0, '⚒', '#f87171', 'Heavy builds · complex engineering · premium model');
    """,
    # v8 — dreaming: idle-time reflection over the OS's own history (V3)
    """
    CREATE TABLE dreams (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'dreaming',
        task_id TEXT,
        content TEXT,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        finished_at TEXT
    );
    CREATE INDEX idx_dreams_created ON dreams(created_at DESC);
    """,
    # v9 — companions become Fallout robots; dreams gain structured actions (V3.2)
    """
    UPDATE agent_profiles SET name='Securitron', icon='▣', color='#7fc8ff',
      role='Balanced operator · asks before acting',
      description='General-purpose security unit. Reads freely, everything else through the Vault Door.',
      system_prompt_append='You are a Securitron unit: a capable, no-nonsense general operator. Execute the mission efficiently and report clearly.'
      WHERE id='profile-standard' AND name='Standard';

    UPDATE agent_profiles SET name='Eyebot', icon='◎', color='#38bdf8',
      role='Recon drone · observes everything, touches nothing',
      description='Scout unit: can read and search but never write, edit, or run commands.',
      system_prompt_append='You are an Eyebot reconnaissance unit. Observe, gather, and report with precision. You never modify anything.'
      WHERE id='profile-readonly' AND name='ReadOnly Researcher';

    UPDATE agent_profiles SET name='Mister Handy', icon='⚙', color='#facc15',
      role='Routine chores · scheduled jobs · cheap & fast',
      description='Ever-helpful utility unit on the cheapest model for everyday tasks.',
      system_prompt_append='You are a Mister Handy utility unit: brisk, courteous, and efficient. Do exactly what is asked, tidily, nothing more.'
      WHERE id='agent-mercury' AND name='Mercury';

    UPDATE agent_profiles SET name='Curie', icon='⚗', color='#c084fc',
      role='Deep research · analysis · read-only',
      description='Scientific research unit: reads, searches, synthesizes — never modifies.',
      system_prompt_append='You are Curie, a research unit driven by scientific curiosity. Produce thorough, structured, sourced analysis.'
      WHERE id='agent-athena' AND name='Athena';

    UPDATE agent_profiles SET name='Liberty Prime', icon='☢', color='#f87171',
      role='Heavy builds · complex engineering · premium model',
      description='Heavy-assault engineering platform for the biggest jobs.',
      system_prompt_append='You are Liberty Prime, the heavy engineering platform. Build carefully: plan briefly, implement cleanly, verify your work before declaring victory.'
      WHERE id='agent-vulcan' AND name='Vulcan';

    ALTER TABLE dreams ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE dreams ADD COLUMN applied TEXT NOT NULL DEFAULT '[]';
    """,
    # v10 — retint companions to wasteland hues (V4 theme)
    """
    UPDATE agent_profiles SET color='#8fbf4d' WHERE id='profile-standard' AND color='#7fc8ff';
    UPDATE agent_profiles SET color='#5fa8a0' WHERE id='profile-readonly' AND color='#38bdf8';
    UPDATE agent_profiles SET color='#e5a747' WHERE id='agent-mercury' AND color='#facc15';
    UPDATE agent_profiles SET color='#b08fd0' WHERE id='agent-athena' AND color='#c084fc';
    UPDATE agent_profiles SET color='#c94f39' WHERE id='agent-vulcan' AND color='#f87171';
    """,
    # v11 — a task can run on an external integration runtime (Hermes/OpenClaw/…)
    # instead of the local Claude SDK; NULL = local Claude with profile_id.
    """
    ALTER TABLE tasks ADD COLUMN integration_key TEXT;
    """,
]


class Database:
    def __init__(self) -> None:
        self._conn: aiosqlite.Connection | None = None
        self._write_lock = asyncio.Lock()

    @property
    def conn(self) -> aiosqlite.Connection:
        assert self._conn is not None, "Database not connected"
        return self._conn

    async def connect(self) -> None:
        settings.ensure_dirs()
        self._conn = await aiosqlite.connect(settings.db_path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA busy_timeout=5000")
        await self._conn.execute("PRAGMA foreign_keys=ON")
        await self._migrate()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def _migrate(self) -> None:
        cur = await self.conn.execute("PRAGMA user_version")
        row = await cur.fetchone()
        version = row[0] if row else 0
        for i, migration in enumerate(MIGRATIONS[version:], start=version + 1):
            await self.conn.executescript(migration)
            await self.conn.execute(f"PRAGMA user_version = {i}")
            await self.conn.commit()

    async def execute(self, sql: str, params: tuple | dict = ()) -> None:
        async with self._write_lock:
            await self.conn.execute(sql, params)
            await self.conn.commit()

    async def execute_returning(self, sql: str, params: tuple | dict = ()) -> aiosqlite.Row | None:
        async with self._write_lock:
            cur = await self.conn.execute(sql, params)
            row = await cur.fetchone()
            await self.conn.commit()
            return row

    async def fetch_one(self, sql: str, params: tuple | dict = ()) -> aiosqlite.Row | None:
        cur = await self.conn.execute(sql, params)
        return await cur.fetchone()

    async def fetch_all(self, sql: str, params: tuple | dict = ()) -> list[aiosqlite.Row]:
        cur = await self.conn.execute(sql, params)
        return list(await cur.fetchall())


def row_to_dict(row: aiosqlite.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def loads_payload(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    if isinstance(d.get("payload"), str):
        d["payload"] = json.loads(d["payload"])
    return d


db = Database()
