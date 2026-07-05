export type TaskStatus =
  | 'queued' | 'running' | 'awaiting_approval' | 'waiting_input'
  | 'verifying' | 'done' | 'failed' | 'cancelled'

export const ACTIVE_STATUSES: TaskStatus[] = [
  'queued', 'running', 'awaiting_approval', 'waiting_input', 'verifying',
]

export interface Task {
  id: string
  title: string
  prompt: string
  kind: 'general' | 'repo' | 'chat'
  status: TaskStatus
  repo_path: string | null
  base_branch: string | null
  branch: string | null
  worktree_path: string | null
  cwd: string | null
  verify_command: string | null
  model: string | null
  session_id: string | null
  total_cost_usd: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  num_turns: number | null
  result_summary: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  agent_color?: string | null
  agent_icon?: string | null
  agent_name?: string | null
}

export interface TaskEvent {
  task_id: string
  seq: number
  ts: string
  type: string
  payload: Record<string, any>
  channel?: string
}

export interface Stats {
  tasks_by_status: Record<string, number>
  cost_today_usd: number
  tokens_today: { input: number; output: number }
  cost_week_usd: number
}
