import { useCallback, useEffect, useState } from 'react'
import { useIsMobile } from '../lib/mobile'
import type { CSSProperties } from 'react'
import { get, post } from '../lib/api'
import { lockLabel, useMasterGuard } from '../lib/master'

interface DreamAction {
  type: 'schedule' | 'rule' | 'agent' | 'fact' | 'pipeline'
  name?: string
  cron?: string
  prompt?: string
  tool?: string
  pattern?: string
  action?: string
  model?: string
  role?: string
  content?: string
  stages?: { name: string; prompt: string }[]
}

interface Dream {
  id: string
  status: 'dreaming' | 'complete' | 'failed'
  task_id: string | null
  content: string | null
  actions: DreamAction[]
  applied: number[]
  cost_usd: number
  created_at: string
  finished_at: string | null
}

const ACTION_META: Record<DreamAction['type'], { icon: string; label: string }> = {
  schedule: { icon: '↻', label: 'schedule' },
  rule: { icon: '⚿', label: 'vault rule' },
  agent: { icon: 'Ω', label: 'companion' },
  fact: { icon: '◈', label: 'holotape' },
  pipeline: { icon: '⧉', label: 'pipeline' },
}

const PANEL_LABEL: CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: 2, color: '#dfd8c6',
}

const toDate = (s: string) => new Date(s.endsWith('Z') ? s : s + 'Z')

function actionSummary(a: DreamAction): string {
  switch (a.type) {
    case 'schedule': return `${a.name} · ${a.cron}`
    case 'rule': return `${a.action} ${a.tool} “${a.pattern}”`
    case 'agent': return `${a.name} (${a.model ?? 'default'})`
    case 'fact': return a.content?.slice(0, 70) ?? ''
    case 'pipeline': return `${a.name} · ${a.stages?.length ?? 0} stages`
    default: return ''
  }
}

/** One-tap action chips: each proposed action as an instrument-well row with
 * a steel APPLY key. Preserves the existing apply + applied-dedupe logic. */
function ActionChips({ dream, onApplied }: { dream: Dream; onApplied: () => void }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [msg, setMsg] = useState('')
  const { locked, guard } = useMasterGuard() // dream apply is master-only
  if (!dream.actions?.length) return null

  async function apply(index: number) {
    setBusy(index)
    setMsg('')
    try {
      const res = await post<{ created: string }>(`/api/dreams/${dream.id}/apply`, { action_index: index })
      setMsg(`✓ created ${res.created}`)
      onApplied()
    } catch (e: any) {
      setMsg(`✗ ${e.message ?? 'apply failed'}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {dream.actions.map((a, i) => {
        const meta = ACTION_META[a.type] ?? { icon: '◆', label: a.type }
        const applied = dream.applied?.includes(i)
        return (
          <div key={i} className="wl-tile wl-mono" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', minWidth: 0 }}>
            <span style={{ color: 'var(--wl-phos-g)', textShadow: '0 0 5px var(--wl-phos-g-glow)', fontSize: 13, flexShrink: 0 }}>{meta.icon}</span>
            <span className="wl-microlabel" style={{ width: 56, flexShrink: 0 }}>{meta.label}</span>
            <span
              style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, color: '#aebccb' }}
              title={actionSummary(a)}
            >
              {actionSummary(a)}
            </span>
            {applied ? (
              <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, letterSpacing: 1, color: 'var(--wl-green)' }}>APPLIED ✓</span>
            ) : (
              <button
                className="wl-btn wl-btn--steel"
                style={{ flexShrink: 0, fontSize: 9, padding: '4px 10px', letterSpacing: 1.5, ...(busy !== null ? { opacity: 0.5, cursor: 'default' } : { opacity: locked ? 0.55 : 1 }) }}
                disabled={busy !== null}
                onClick={guard(() => apply(i))}
              >
                {busy === i ? '…' : lockLabel(locked, 'APPLY')}
              </button>
            )}
          </div>
        )
      })}
      {msg && (
        <div className="wl-mono" style={{ fontSize: 10, color: msg.startsWith('✓') ? 'var(--wl-green)' : 'var(--wl-red-hi)' }}>{msg}</div>
      )}
    </div>
  )
}

/** Minimal markdown as phosphor text: ## headers become ':: SECTION' lines,
 * bullets '◦', numbered 'N▸', **bold** brightens to full phosphor. */
function DreamContent({ text }: { text: string }) {
  const bold = (s: string) =>
    s.split(/\*\*(.+?)\*\*/g).map((part, j) =>
      j % 2 === 1 ? <strong key={j} className="wl-crt-text" style={{ fontWeight: 600 }}>{part}</strong> : part,
    )
  return (
    <div className="wl-mono" style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11.5, lineHeight: 1.8, color: 'var(--wl-phos-g-dim)' }}>
      {text.split('\n').map((line, i) => {
        if (line.startsWith('## ')) {
          return (
            <div key={i} className="wl-crt-text" style={{ marginTop: 8, fontWeight: 600, letterSpacing: 1.5, textTransform: 'uppercase' }}>
              :: {line.slice(3)}
            </div>
          )
        }
        if (/^\s*[-•]\s/.test(line)) {
          return (
            <div key={i} style={{ display: 'flex', gap: 8, paddingLeft: 4 }}>
              <span className="wl-crt-text">◦</span>
              <span>{bold(line.replace(/^\s*[-•]\s*/, ''))}</span>
            </div>
          )
        }
        if (/^\s*\d+\.\s/.test(line)) {
          return (
            <div key={i} style={{ display: 'flex', gap: 8, paddingLeft: 4 }}>
              <span className="wl-crt-text" style={{ fontWeight: 600, flexShrink: 0 }}>
                {line.match(/^\s*(\d+)\./)?.[1]}▸
              </span>
              <span>{bold(line.replace(/^\s*\d+\.\s*/, ''))}</span>
            </div>
          )
        }
        if (!line.trim()) return <div key={i} style={{ height: 4 }} />
        return <div key={i}>{bold(line)}</div>
      })}
    </div>
  )
}

export default function Dreaming() {
  const mobile = useIsMobile()
  const [dreams, setDreams] = useState<Dream[]>([])
  const [busy, setBusy] = useState(false)
  const [scheduled, setScheduled] = useState<boolean | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const { locked, guard } = useMasterGuard() // dream run + schedule create are master-only

  const refresh = useCallback(() => {
    get<Dream[]>('/api/dreams').then(setDreams)
    get<any[]>('/api/schedules').then((list) =>
      setScheduled(list.some((s) => s.task_template?.dream && s.enabled)),
    )
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  const dreaming = dreams.some((d) => d.status === 'dreaming')
  const latest = dreams[0] ?? null
  const latestDate = (latest ? toDate(latest.created_at) : new Date()).toISOString().slice(0, 10)
  const latestWithActions = dreams.find((d) => d.actions?.length) ?? null

  async function dreamNow() {
    setBusy(true)
    try {
      await post('/api/dreams/run')
      refresh()
    } finally {
      setBusy(false)
    }
  }

  async function scheduleNightly() {
    await post('/api/schedules', {
      name: 'Nightly dreaming',
      cron_expr: '0 3 * * *',
      prompt: 'dream',
      dream: true,
    })
    refresh()
  }

  return (
    <div style={{ padding: mobile ? 4 : 16, display: 'grid', gridTemplateColumns: mobile ? 'minmax(0,1fr)' : 'minmax(0,1.4fr) minmax(0,1fr)', gap: 12, alignItems: 'start' }}>

      {/* ===== DREAM ENGINE · LAST RUN ===== */}
      <div className="wl-equip wl-rust-tr" style={{ padding: '12px 12px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span className="wl-screw wl-screw--tl" /><span className="wl-screw wl-screw--tr" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px' }}>
          <span style={PANEL_LABEL}>DREAM ENGINE · LAST RUN</span>
          <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 8, color: '#8fa0b0' }}>REM-CYCLE {String(dreams.length).padStart(3, '0')}</span>
        </div>
        <div className="wl-monitor-bezel">
          <div className="wl-crt" style={{ minHeight: 250, padding: '16px 18px', fontSize: 11.5, lineHeight: 1.8 }}>
            <div className="wl-scanlines" /><div className="wl-glare" /><div className="wl-scanbar" />
            <div style={{ fontSize: 10, color: '#3f8f5e' }}>&gt; sim.dream --date {latestDate}</div>
            {latest?.status === 'dreaming' ? (
              <>
                <div className="wl-crt-text">recalling episode history, costs, rules…</div>
                <div className="wl-crt-text">weaving memory shards into REM cycle<span className="wl-cursor" /></div>
              </>
            ) : latest?.content ? (
              <>
                <div style={{ marginTop: 6, maxHeight: 380, overflowY: 'auto' }}>
                  <DreamContent text={latest.content} />
                </div>
                <div style={{ marginTop: 8, fontSize: 10, color: '#3f8f5e' }}>
                  &gt; consolidated → holotape ◈ dream-{latestDate} · ~${latest.cost_usd.toFixed(3)}<span className="wl-cursor" />
                </div>
              </>
            ) : latest ? (
              <div className="wl-crt-text">(empty simulation)<span className="wl-cursor" /></div>
            ) : (
              <>
                <div className="wl-crt-text">no simulations on record.</div>
                <div className="wl-crt-text">the engine will study episode history, costs, and rules,</div>
                <div className="wl-crt-text">then propose schedules, companions, and automations.<span className="wl-cursor" /></div>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 4px 2px', flexWrap: 'wrap' }}>
          <span className={`wl-led wl-led--green ${dreaming ? 'wl-led--blink' : ''}`} />
          <span className="wl-microlabel">{dreaming ? 'REM CYCLE IN PROGRESS' : 'ENGINE READY'}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            {scheduled === false && (
              <button className="wl-btn wl-btn--steel" style={{ fontSize: 10, padding: '6px 12px', opacity: locked ? 0.55 : 1 }} onClick={guard(scheduleNightly)}>
                {lockLabel(locked, 'SCHEDULE NIGHTLY (03:00)')}
              </button>
            )}
            {scheduled === true && (
              <span className="wl-microlabel" style={{ color: 'var(--wl-green)' }}>NIGHTLY ARMED ✓</span>
            )}
            <div className="wl-btn-housing">
              <button
                className="wl-btn"
                disabled={busy || dreaming}
                style={busy || dreaming ? { opacity: 0.5, cursor: 'default' } : { opacity: locked ? 0.55 : 1 }}
                onClick={guard(dreamNow)}
              >
                {lockLabel(locked, '▶ RUN SIMULATION')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ===== proposed actions + dream log ===== */}
      <div className="wl-equip" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="wl-screw wl-screw--tl" /><span className="wl-screw wl-screw--rusty wl-screw--br" />

        {latestWithActions && (
          <>
            <div style={{ ...PANEL_LABEL, padding: '2px 6px' }}>ONE-TAP ACTIONS</div>
            <ActionChips dream={latestWithActions} onApplied={refresh} />
          </>
        )}

        <div style={{ ...PANEL_LABEL, padding: '2px 6px', marginTop: latestWithActions ? 8 : 0 }}>DREAM LOG</div>
        {dreams.map((d) => {
          const open = expanded === d.id
          return (
            <div
              key={d.id}
              className="wl-tile wl-mono"
              style={{ padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 4, cursor: 'pointer' }}
              onClick={() => setExpanded(open ? null : d.id)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#dfe6ec', minWidth: 0 }}>
                <span style={{ flexShrink: 0 }}>☾ {toDate(d.created_at).toLocaleString()}</span>
                <span className={`wl-badge ${
                  d.status === 'complete' ? 'wl-badge--done' : d.status === 'failed' ? 'wl-badge--failed' : 'wl-badge--running'
                }`}>
                  {d.status === 'dreaming' ? '● dreaming' : d.status}
                </span>
                <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 9, color: '#8fa0b0' }}>~${d.cost_usd.toFixed(3)}</span>
              </div>
              {open && (
                <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 4, cursor: 'default', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {d.status === 'dreaming' ? (
                    <span className="wl-crt-text" style={{ fontFamily: 'var(--wl-font-mono)', fontSize: 10.5 }}>
                      REM cycle in progress<span className="wl-cursor" />
                    </span>
                  ) : d.content ? (
                    <DreamContent text={d.content} />
                  ) : (
                    <span style={{ fontSize: 10, color: '#5d6e7e' }}>(empty simulation)</span>
                  )}
                  <ActionChips dream={d} onApplied={refresh} />
                </div>
              )}
            </div>
          )
        })}
        {dreams.length === 0 && (
          <div className="wl-tile--inset wl-mono" style={{ borderRadius: 4, padding: '16px 12px', fontSize: 10.5, color: '#5d6e7e', textAlign: 'center' }}>
            no dreams logged. run a simulation — the engine studies its episode history,
            costs, and rules, then suggests what to build next.
          </div>
        )}
      </div>
    </div>
  )
}
