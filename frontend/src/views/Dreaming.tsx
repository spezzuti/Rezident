import { useCallback, useEffect, useState } from 'react'
import { get, post } from '../lib/api'
import Ambient from '../components/Ambient'

const INDIGO = 'var(--sec-dreams)'
const dmix = (pct: number) => `color-mix(in srgb, ${INDIGO} ${pct}%, transparent)`

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

function ActionChips({ dream, onApplied }: { dream: Dream; onApplied: () => void }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [msg, setMsg] = useState('')
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
    <div className="mt-4 border-t border-edge pt-3">
      <div className="hud-label !text-[9px]" style={{ color: INDIGO }}>one-tap actions</div>
      <div className="mt-2 space-y-1.5">
        {dream.actions.map((a, i) => {
          const meta = ACTION_META[a.type] ?? { icon: '◆', label: a.type }
          const applied = dream.applied?.includes(i)
          return (
            <div key={i} className="flex items-center gap-2 rounded-md border border-edge bg-panel/60 px-2.5 py-1.5">
              <span className="font-mono text-sm" style={{ color: INDIGO }}>{meta.icon}</span>
              <span className="hud-label !text-[8px] w-16 shrink-0">{meta.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2" title={actionSummary(a)}>
                {actionSummary(a)}
              </span>
              {applied ? (
                <span className="font-mono text-[10px] font-bold uppercase text-ok">applied ✓</span>
              ) : (
                <button
                  className="rounded px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase text-bg transition-all disabled:opacity-40"
                  style={{ background: INDIGO }}
                  disabled={busy !== null}
                  onClick={() => apply(i)}
                >
                  {busy === i ? '…' : 'apply'}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {msg && <div className={`mt-2 font-mono text-[11px] ${msg.startsWith('✓') ? 'text-ok' : 'text-err'}`}>{msg}</div>}
    </div>
  )
}

/** Minimal markdown: ##headers, numbered/bulleted lines, **bold**. */
function DreamContent({ text }: { text: string }) {
  return (
    <div className="space-y-1 text-sm leading-relaxed text-ink-2">
      {text.split('\n').map((line, i) => {
        const bolded = line.split(/\*\*(.+?)\*\*/g).map((part, j) =>
          j % 2 === 1 ? <strong key={j} className="text-ink">{part}</strong> : part,
        )
        if (line.startsWith('## ')) {
          return (
            <div key={i} className="hud-label !mt-3 !text-[10px]" style={{ color: INDIGO }}>
              {line.slice(3)}
            </div>
          )
        }
        if (/^\s*[-•]\s/.test(line)) {
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span style={{ color: INDIGO }}>◦</span>
              <span>{bolded}</span>
            </div>
          )
        }
        if (/^\s*\d+\.\s/.test(line)) {
          const rest = line.replace(/^\s*\d+\.\s*/, '')
          const restBolded = rest.split(/\*\*(.+?)\*\*/g).map((part, j) =>
            j % 2 === 1 ? <strong key={j} className="text-ink">{part}</strong> : part,
          )
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="font-mono text-xs font-bold" style={{ color: INDIGO }}>
                {line.match(/^\s*(\d+)\./)?.[1]}▸
              </span>
              <span>{restBolded}</span>
            </div>
          )
        }
        if (!line.trim()) return <div key={i} className="h-1" />
        return <div key={i}>{bolded}</div>
      })}
    </div>
  )
}

/** A painted nightscape: crescent moon over ridgelines, drifting nebula,
 * twinkling stars, a shooting star while dreaming. Pure SVG, no assets. */
function DreamScene({ dreaming }: { dreaming: boolean }) {
  const stars = [
    [40, 28, 1.2, 0], [95, 62, 0.8, 1.2], [150, 20, 1.0, 2.1], [215, 48, 0.7, 0.6],
    [280, 30, 1.3, 1.7], [340, 70, 0.8, 0.3], [420, 24, 1.0, 2.6], [470, 55, 0.7, 1.0],
    [540, 36, 1.2, 0.4], [600, 64, 0.8, 1.9], [660, 22, 1.0, 0.8], [710, 46, 0.7, 2.3],
    [120, 90, 0.6, 1.5], [380, 95, 0.6, 0.2], [575, 92, 0.6, 2.8], [255, 82, 0.5, 1.1],
  ] as const
  return (
    <svg viewBox="0 0 760 190" className="mx-auto w-full max-w-2xl" role="img" aria-label="dreaming nightscape">
      <defs>
        <radialGradient id="d-nebula1" cx="30%" cy="25%" r="55%">
          <stop offset="0%" stopColor="#818cf8" stopOpacity="0.22" />
          <stop offset="60%" stopColor="#c084fc" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#c084fc" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="d-nebula2" cx="75%" cy="45%" r="50%">
          <stop offset="0%" stopColor="#f472b6" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#f472b6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="d-moonglow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#e2e8f0" stopOpacity="0.9" />
          <stop offset="35%" stopColor="#c7d4f5" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#818cf8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="d-ridge1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#141b31" />
          <stop offset="100%" stopColor="#0a0f1e" />
        </linearGradient>
        <linearGradient id="d-ridge2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1d2742" />
          <stop offset="100%" stopColor="#0e1428" />
        </linearGradient>
        <mask id="d-crescent">
          <circle cx="560" cy="58" r="30" fill="white" />
          <circle cx="573" cy="48" r="26" fill="black" />
        </mask>
      </defs>

      {/* sky washes */}
      <rect width="760" height="190" fill="url(#d-nebula1)" />
      <rect width="760" height="190" fill="url(#d-nebula2)">
        {dreaming && <animate attributeName="opacity" values="1;0.5;1" dur="7s" repeatCount="indefinite" />}
      </rect>

      {/* stars */}
      {stars.map(([x, y, r, delay], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill="#dbe4f0">
          <animate attributeName="opacity" values="0.9;0.15;0.9" dur={`${2.6 + (i % 5) * 0.7}s`} begin={`${delay}s`} repeatCount="indefinite" />
        </circle>
      ))}

      {/* shooting star while dreaming */}
      {dreaming && (
        <g>
          <line x1="0" y1="0" x2="34" y2="10" stroke="#dbe4f0" strokeWidth="1.2" strokeLinecap="round" opacity="0">
            <animateTransform attributeName="transform" type="translate" values="120,18; 330,78" dur="2.8s" begin="1s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0;0.9;0" dur="2.8s" begin="1s" repeatCount="indefinite" />
          </line>
        </g>
      )}

      {/* moon halo + crescent */}
      <circle cx="560" cy="58" r="52" fill="url(#d-moonglow)">
        {dreaming && <animate attributeName="r" values="52;60;52" dur="4s" repeatCount="indefinite" />}
      </circle>
      <circle cx="560" cy="58" r="30" fill="#e8edf7" mask="url(#d-crescent)" />
      <circle cx="552" cy="66" r="2.4" fill="#b9c4de" opacity="0.55" mask="url(#d-crescent)" />
      <circle cx="546" cy="52" r="1.6" fill="#b9c4de" opacity="0.4" mask="url(#d-crescent)" />

      {/* drifting mist */}
      <ellipse cx="200" cy="120" rx="150" ry="14" fill="#818cf8" opacity="0.06">
        <animateTransform attributeName="transform" type="translate" values="0,0; 60,0; 0,0" dur="18s" repeatCount="indefinite" />
      </ellipse>
      <ellipse cx="520" cy="132" rx="180" ry="12" fill="#c084fc" opacity="0.05">
        <animateTransform attributeName="transform" type="translate" values="0,0; -50,0; 0,0" dur="22s" repeatCount="indefinite" />
      </ellipse>

      {/* ridgelines */}
      <path d="M0,150 L70,112 L130,142 L210,98 L290,146 L350,120 L430,152 L760,150 L760,190 L0,190 Z" fill="url(#d-ridge2)" />
      <path d="M0,168 L90,140 L170,164 L260,132 L360,168 L470,138 L560,166 L650,146 L760,170 L760,190 L0,190 Z" fill="url(#d-ridge1)" />

      {/* zzz while dreaming */}
      {dreaming && (
        <g fill="#818cf8" fontFamily="Consolas, monospace" fontWeight="bold">
          <text x="600" y="36" fontSize="11" opacity="0">
            z<animate attributeName="opacity" values="0;1;0" dur="3s" begin="0s" repeatCount="indefinite" />
            <animateTransform attributeName="transform" type="translate" values="0,0; 6,-10" dur="3s" begin="0s" repeatCount="indefinite" />
          </text>
          <text x="612" y="30" fontSize="14" opacity="0">
            z<animate attributeName="opacity" values="0;1;0" dur="3s" begin="1s" repeatCount="indefinite" />
            <animateTransform attributeName="transform" type="translate" values="0,0; 7,-12" dur="3s" begin="1s" repeatCount="indefinite" />
          </text>
          <text x="626" y="24" fontSize="17" opacity="0">
            z<animate attributeName="opacity" values="0;1;0" dur="3s" begin="2s" repeatCount="indefinite" />
            <animateTransform attributeName="transform" type="translate" values="0,0; 8,-14" dur="3s" begin="2s" repeatCount="indefinite" />
          </text>
        </g>
      )}
    </svg>
  )
}

export default function Dreaming() {
  const [dreams, setDreams] = useState<Dream[]>([])
  const [busy, setBusy] = useState(false)
  const [scheduled, setScheduled] = useState<boolean | null>(null)

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
    <div className="relative min-h-full p-4 md:p-6">
      <Ambient color="var(--sec-dreams)" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="hud-label !text-xs" style={{ color: INDIGO }}>Simulations</h1>
          <div className="mt-0.5 font-mono text-[10px] text-ink-dimmer">
            Vault-Tec approved: while you're away, the OS reflects on its history and suggests what to build next
          </div>
        </div>
      </div>

      <div className="glass hud-corner mt-4 overflow-hidden p-0 text-center" style={{ boxShadow: `0 0 30px ${dmix(13)}` }}>
        <DreamScene dreaming={dreaming} />
        <div className="px-6 pb-6">
        <div className="font-mono text-xs" style={{ color: dreaming ? INDIGO : undefined }}>
          {dreaming ? 'REM cycle in progress — Athena is reflecting…' : 'the core is awake'}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <button
            className="rounded-md px-6 py-2.5 font-mono text-sm font-bold uppercase tracking-[0.15em] text-bg transition-all disabled:opacity-40"
            style={{ background: INDIGO, boxShadow: `0 0 24px ${dmix(33)}`, color: 'var(--color-bg)' }}
            disabled={busy || dreaming}
            onClick={dreamNow}
          >
            ☾ enter simulation
          </button>
          {scheduled === false && (
            <button
              className="rounded-md border px-4 py-2.5 font-mono text-xs uppercase tracking-widest transition-colors hover:bg-panel-2"
              style={{ borderColor: dmix(40), color: INDIGO }}
              onClick={scheduleNightly}
            >
              schedule nightly (03:00)
            </button>
          )}
          {scheduled && (
            <span className="font-mono text-[11px] text-ink-dim">nightly dreaming scheduled ✓</span>
          )}
        </div>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <h2 className="hud-label">Simulation log</h2>
        <hr className="neon-divider flex-1" />
      </div>
      <div className="mx-auto mt-3 max-w-3xl space-y-4">
        {dreams.map((d) => (
          <div key={d.id} className="glass p-5" style={d.status === 'dreaming' ? { boxShadow: `0 0 24px ${dmix(20)}` } : undefined}>
            <div className="flex items-center gap-3">
              <span style={{ color: INDIGO, textShadow: `0 0 12px ${INDIGO}` }}>☾</span>
              <span className="font-mono text-xs text-ink-dim">
                {new Date(d.created_at.endsWith('Z') ? d.created_at : d.created_at + 'Z').toLocaleString()}
              </span>
              <span className={`font-mono text-[10px] font-bold uppercase tracking-widest ${
                d.status === 'complete' ? 'text-ok' : d.status === 'failed' ? 'text-err' : ''
              }`} style={d.status === 'dreaming' ? { color: INDIGO } : undefined}>
                {d.status === 'dreaming' ? '● dreaming' : d.status}
              </span>
              <span className="ml-auto font-mono text-[10px] text-ink-dimmer">~${d.cost_usd.toFixed(3)}</span>
            </div>
            <div className="mt-3">
              {d.status === 'dreaming' ? (
                <div className="shimmer-bar h-1 rounded" />
              ) : d.content ? (
                <DreamContent text={d.content} />
              ) : (
                <span className="text-sm text-ink-dim">(empty simulation)</span>
              )}
            </div>
            <ActionChips dream={d} onApplied={refresh} />
          </div>
        ))}
        {dreams.length === 0 && (
          <div className="glass border-dashed p-10 text-center text-sm text-ink-dim">
            No dreams yet. Run one — the OS will study its episode history, costs, and rules,
            then suggest schedules, agents, and automations worth building.
          </div>
        )}
      </div>
    </div>
  )
}
