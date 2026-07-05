import { useCallback, useEffect, useState } from 'react'
import { get, post } from '../lib/api'

const INDIGO = '#818cf8'

interface Dream {
  id: string
  status: 'dreaming' | 'complete' | 'failed'
  task_id: string | null
  content: string | null
  cost_usd: number
  created_at: string
  finished_at: string | null
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

function Moon({ dreaming }: { dreaming: boolean }) {
  return (
    <div className="relative mx-auto h-24 w-24">
      <div
        className={`absolute inset-0 rounded-full ${dreaming ? 'reactor-core' : ''}`}
        style={{
          background: `radial-gradient(circle at 38% 35%, ${INDIGO}ee, ${INDIGO}33 55%, rgba(3,7,16,0.9))`,
          boxShadow: dreaming ? undefined : `0 0 40px ${INDIGO}44, inset 0 0 20px ${INDIGO}33`,
        }}
      />
      <span className="absolute inset-0 flex items-center justify-center text-3xl" style={{ textShadow: `0 0 20px ${INDIGO}` }}>
        ☾
      </span>
      {dreaming && (
        <>
          <span className="absolute -right-2 top-1 font-mono text-xs" style={{ color: INDIGO }}>z</span>
          <span className="absolute -right-5 -top-3 font-mono text-sm" style={{ color: `${INDIGO}bb` }}>z</span>
          <span className="absolute -right-9 -top-7 font-mono text-base" style={{ color: `${INDIGO}77` }}>z</span>
        </>
      )}
    </div>
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
    <div className="min-h-full p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="hud-label !text-xs" style={{ color: INDIGO }}>Dreaming</h1>
          <div className="mt-0.5 font-mono text-[10px] text-ink-dimmer">
            while you're away, the OS reflects on its own history and suggests what to build next
          </div>
        </div>
      </div>

      <div className="glass hud-corner mt-4 p-6 text-center" style={{ boxShadow: `0 0 30px ${INDIGO}22` }}>
        <Moon dreaming={dreaming} />
        <div className="mt-3 font-mono text-xs" style={{ color: dreaming ? INDIGO : undefined }}>
          {dreaming ? 'REM cycle in progress — Athena is reflecting…' : 'the core is awake'}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <button
            className="rounded-md px-6 py-2.5 font-mono text-sm font-bold uppercase tracking-[0.15em] text-bg transition-all disabled:opacity-40"
            style={{ background: INDIGO, boxShadow: `0 0 24px ${INDIGO}55` }}
            disabled={busy || dreaming}
            onClick={dreamNow}
          >
            ☾ dream now
          </button>
          {scheduled === false && (
            <button
              className="rounded-md border px-4 py-2.5 font-mono text-xs uppercase tracking-widest transition-colors hover:bg-panel-2"
              style={{ borderColor: `${INDIGO}66`, color: INDIGO }}
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

      <div className="mt-6 flex items-center gap-3">
        <h2 className="hud-label">Dream journal</h2>
        <hr className="neon-divider flex-1" />
      </div>
      <div className="mx-auto mt-3 max-w-3xl space-y-4">
        {dreams.map((d) => (
          <div key={d.id} className="glass p-5" style={d.status === 'dreaming' ? { boxShadow: `0 0 24px ${INDIGO}33` } : undefined}>
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
                <span className="text-sm text-ink-dim">(empty dream)</span>
              )}
            </div>
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
