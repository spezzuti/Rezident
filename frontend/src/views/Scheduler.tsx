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

  const armed = schedules.filter((s) => s.enabled).length

  return (
    <div style={{ minHeight: '100%', padding: '16px 20px 24px' }}>
      {/* Standing Orders — one steel equipment panel */}
      <div className="wl-equip wl-rust-bl" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 980 }}>
        <span className="wl-screw wl-screw--tl" />
        <span className="wl-screw wl-screw--tr" />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="wl-sectionlabel">Standing Orders</span>
          <div className="wl-divider" style={{ flex: 1 }} />
          <span className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0' }}>{armed} ARMED</span>
        </div>

        {/* draft a new standing order */}
        <div className="wl-tile wl-tile--inset" style={{ padding: '12px 12px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <input
              className="wl-input"
              style={{ minWidth: 180, flex: 1 }}
              placeholder="order name — e.g. nightly repo digest"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="wl-input"
              style={{ width: 150 }}
              placeholder="cron"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CRON_PRESETS.map((p) => (
              <button
                key={p.expr}
                className="wl-tile wl-mono"
                style={{
                  padding: '3px 9px',
                  fontSize: 10,
                  cursor: 'pointer',
                  color: cron === p.expr ? 'var(--wl-yellow)' : '#8fa0b0',
                  border: cron === p.expr ? '1px solid var(--wl-yellow)' : '1px solid var(--wl-line)',
                }}
                onClick={() => setCron(p.expr)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            className="wl-input"
            style={{ height: 72, width: '100%', resize: 'vertical' }}
            placeholder="orders the agent will carry out on schedule…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          {error && (
            <div className="wl-mono" style={{ fontSize: 10, color: '#dd8471' }}>{error}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div className="wl-btn-housing">
              <button
                className="wl-btn"
                style={!name.trim() || !prompt.trim() ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                disabled={!name.trim() || !prompt.trim()}
                onClick={add}
              >
                ARM ORDER
              </button>
            </div>
          </div>
        </div>

        {/* the orders ledger */}
        <table className="wl-table">
          <thead>
            <tr>
              <th style={{ width: 44 }}>Armed</th>
              <th>Order</th>
              <th>Schedule</th>
              <th>Last Run</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id} style={!s.enabled ? { opacity: 0.55 } : undefined}>
                <td>
                  <div
                    className={`wl-toggle${s.enabled ? ' on' : ''}`}
                    title={s.enabled ? 'disarm' : 'arm'}
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
                    <div className="wl-toggle-lever" />
                  </div>
                </td>
                <td style={{ color: '#dfe6ec' }}>
                  <div style={{ fontWeight: 600 }}>{s.name}</div>
                  <div
                    style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: '#5d6e7e' }}
                  >
                    {s.task_template.prompt}
                  </div>
                </td>
                <td>
                  <div>{s.cron_expr}</div>
                  <div style={{ fontSize: 9, color: '#5d6e7e' }}>
                    next: {fmt(s.next_run_at)} · overlap: {s.overlap_policy}
                  </div>
                </td>
                <td style={{ color: '#8fa0b0' }}>{fmt(s.last_run_at)}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="wl-btn-housing" style={{ padding: 3 }}>
                      <button
                        className="wl-btn wl-btn--steel"
                        style={{ fontSize: 9, padding: '4px 9px', letterSpacing: 1.5 }}
                        onClick={async () => {
                          const res = await post<{ task_id: string | null }>(`/api/schedules/${s.id}/run_now`)
                          if (res.task_id) navigate(`/tasks/${res.task_id}`)
                        }}
                      >
                        RUN NOW ▸
                      </button>
                    </div>
                    <button
                      className="wl-mono"
                      style={{ fontSize: 10, color: '#8fa0b0', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = '#dd8471' }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = '#8fa0b0' }}
                      onClick={async () => {
                        if (window.confirm(`Delete standing order "${s.name}"?`)) { await del(`/api/schedules/${s.id}`); refresh() }
                      }}
                    >
                      delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {schedules.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: '#5d6e7e', padding: '22px 12px' }}>
                  No standing orders on file. Recurring agents land here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
