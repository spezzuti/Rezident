import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, del, get, post } from '../lib/api'

interface Schedule {
  id: string
  name: string
  cron_expr: string
  task_template: { prompt?: string; verify_command?: string; kind?: string; repo_path?: string }
  enabled: number
  overlap_policy: string
  last_run_at: string | null
  next_run_at: string | null
  last_task_id: string | null
}

const put = (path: string, body: unknown) => api(path, { method: 'PUT', body: JSON.stringify(body) })

const CRON_PRESETS = [
  { label: 'every hour', expr: '0 * * * *' },
  { label: 'daily 9am', expr: '0 9 * * *' },
  { label: 'weekdays 9am', expr: '0 9 * * 1-5' },
  { label: 'sunday 8pm', expr: '0 20 * * 0' },
]

function fmt(ts: string | null): string {
  if (!ts) return '—'
  return new Date(ts.endsWith('Z') ? ts : ts + 'Z').toLocaleString()
}

export default function Scheduler() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [name, setName] = useState('')
  const [cron, setCron] = useState('0 9 * * *')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const refresh = useCallback(() => {
    get<Schedule[]>('/api/schedules').then(setSchedules)
  }, [])

  useEffect(refresh, [refresh])

  async function add() {
    if (!name.trim() || !prompt.trim()) return
    setError('')
    try {
      await post('/api/schedules', { name: name.trim(), cron_expr: cron.trim(), prompt: prompt.trim() })
      setName(''); setPrompt('')
      refresh()
    } catch (e: any) {
      setError(e.message ?? 'failed')
    }
  }

  return (
    <div className="min-h-full p-4 md:p-6">
      <h1 className="text-xs font-bold uppercase tracking-[0.2em] text-ink-dim">Scheduler</h1>

      <div className="mt-4 max-w-3xl space-y-2 rounded-lg border border-edge bg-panel p-4">
        <div className="flex flex-wrap gap-2">
          <input
            className="min-w-40 flex-1 rounded-md border border-edge bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            placeholder="Name — e.g. Nightly repo digest"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="w-36 rounded-md border border-edge bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            placeholder="cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CRON_PRESETS.map((p) => (
            <button
              key={p.expr}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                cron === p.expr ? 'border-accent bg-accent/15 text-accent' : 'border-edge text-ink-dim hover:text-ink'
              }`}
              onClick={() => setCron(p.expr)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <textarea
          className="h-20 w-full rounded-md border border-edge bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          placeholder="Prompt the agent will run on schedule…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        {error && <div className="text-xs text-err">{error}</div>}
        <div className="flex justify-end">
          <button
            className="rounded-md bg-accent/90 px-4 py-1.5 text-sm font-semibold text-black hover:bg-accent disabled:opacity-50"
            disabled={!name.trim() || !prompt.trim()}
            onClick={add}
          >
            Create schedule
          </button>
        </div>
      </div>

      <div className="mt-5 max-w-3xl space-y-3">
        {schedules.map((s) => (
          <div key={s.id} className={`rounded-lg border border-edge bg-panel p-4 ${!s.enabled ? 'opacity-50' : ''}`}>
            <div className="flex flex-wrap items-center gap-3">
              <button
                className={`h-4 w-7 shrink-0 rounded-full ${s.enabled ? 'bg-ok/70' : 'bg-edge'}`}
                title={s.enabled ? 'disable' : 'enable'}
                onClick={async () => {
                  await put(`/api/schedules/${s.id}`, {
                    name: s.name, cron_expr: s.cron_expr, prompt: s.task_template.prompt ?? s.name,
                    kind: s.task_template.kind ?? 'general', repo_path: s.task_template.repo_path,
                    verify_command: s.task_template.verify_command,
                    enabled: !s.enabled, overlap_policy: s.overlap_policy,
                  })
                  refresh()
                }}
              >
                <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
              </button>
              <span className="text-sm font-bold text-ink">{s.name}</span>
              <span className="rounded bg-panel-2 px-2 py-0.5 font-mono text-xs text-violet">{s.cron_expr}</span>
              <div className="ml-auto flex gap-2">
                <button
                  className="rounded-md border border-accent/50 px-3 py-1 text-xs font-semibold text-accent hover:bg-accent/10"
                  onClick={async () => {
                    const res = await post<{ task_id: string | null }>(`/api/schedules/${s.id}/run_now`)
                    if (res.task_id) navigate(`/tasks/${res.task_id}`)
                  }}
                >
                  ▶ Run now
                </button>
                <button
                  className="text-xs text-ink-dim hover:text-err"
                  onClick={async () => {
                    if (window.confirm(`Delete schedule "${s.name}"?`)) { await del(`/api/schedules/${s.id}`); refresh() }
                  }}
                >
                  delete
                </button>
              </div>
            </div>
            <div className="mt-1.5 truncate font-mono text-xs text-ink-dim">{s.task_template.prompt}</div>
            <div className="mt-2 flex gap-4 font-mono text-[11px] text-ink-dim">
              <span>last: {fmt(s.last_run_at)}</span>
              <span>next: {fmt(s.next_run_at)}</span>
              <span>on overlap: {s.overlap_policy}</span>
            </div>
          </div>
        ))}
        {schedules.length === 0 && (
          <div className="rounded-lg border border-dashed border-edge p-6 text-center text-sm text-ink-dim">
            No schedules yet. Recurring agents land here.
          </div>
        )}
      </div>
    </div>
  )
}
