import { TaskCard } from 'agentos-frontend'

const base = {
  id: 'demo', prompt: '', kind: 'general' as const, repo_path: null, base_branch: null,
  branch: null, worktree_path: null, cwd: null, verify_command: null, model: null,
  session_id: null, cache_read_tokens: 0, num_turns: null, result_summary: null,
  error: null, created_at: '2026-07-05T14:00:00Z', started_at: '2026-07-05T14:01:00Z',
  finished_at: null,
}

const wrap: React.CSSProperties = { maxWidth: 380, padding: 8 }

export const RunningTask = () => (
  <div style={wrap}>
    <TaskCard task={{
      ...base, id: 'run1', title: 'Refactor auth middleware', status: 'running',
      total_cost_usd: 0.418, input_tokens: 24100, output_tokens: 5900,
      agent_icon: '☢', agent_color: '#c94f39', agent_name: 'Liberty Prime',
      verify_command: 'pytest -q',
    }} />
  </div>
)

export const NeedsClearance = () => (
  <div style={wrap}>
    <TaskCard task={{
      ...base, id: 'app1', title: 'Deploy to staging server', status: 'awaiting_approval',
      total_cost_usd: 0.112, input_tokens: 8400, output_tokens: 1200,
      agent_icon: '▣', agent_color: '#8fbf4d', agent_name: 'Securitron',
    }} />
  </div>
)

export const Completed = () => (
  <div style={wrap}>
    <TaskCard task={{
      ...base, id: 'done1', title: 'Nightly repo digest', status: 'done',
      total_cost_usd: 0.067, input_tokens: 5200, output_tokens: 900,
      finished_at: '2026-07-05T14:06:30Z',
      agent_icon: '⚙', agent_color: '#e5a747', agent_name: 'Mister Handy',
      verify_command: 'grep -q done report.md',
    }} />
  </div>
)

export const Failed = () => (
  <div style={wrap}>
    <TaskCard task={{
      ...base, id: 'fail1', title: 'Migrate database schema', status: 'failed',
      total_cost_usd: 0.234, input_tokens: 15600, output_tokens: 3100,
      finished_at: '2026-07-05T14:12:00Z',
      error: 'verification failed: 2 tests failing',
      agent_icon: '⚗', agent_color: '#b08fd0', agent_name: 'Curie',
    }} />
  </div>
)
