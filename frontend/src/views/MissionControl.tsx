import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { get } from '../lib/api'
import { ACTIVE_STATUSES, type Stats, type Task } from '../lib/types'
import { useStore } from '../store'
import { CountUp, StatTile } from '../components/CostMeter'
import TaskCard from '../components/TaskCard'
import NewTaskModal from '../components/NewTaskModal'

const STATUS_NODE: Record<string, string> = {
  running: 'bg-accent shadow-[0_0_16px_rgba(127,200,255,0.8)]',
  awaiting_approval: 'bg-warn shadow-[0_0_16px_rgba(250,204,21,0.8)]',
  waiting_input: 'bg-warn shadow-[0_0_16px_rgba(250,204,21,0.6)]',
  verifying: 'bg-violet shadow-[0_0_16px_rgba(192,132,252,0.8)]',
  queued: 'bg-ink-dim',
}

function Reactor({ active }: { active: Task[] }) {
  const nodes = active.slice(0, 10)
  return (
    <div className="radar relative mx-auto h-72 w-72 md:h-80 md:w-80">
      <div className="radar-ring inset-[14%]" />
      <div className="radar-ring inset-[30%]" />
      <div className="radar-sweep" />
      {/* core */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="reactor-core flex h-20 w-20 items-center justify-center">
          <div className="text-center">
            <div className="metric text-2xl leading-none text-bg" style={{ textShadow: 'none' }}>{active.length}</div>
          </div>
        </div>
        <div className="hud-label mt-2 text-center !text-[8px]">core</div>
      </div>
      {/* orbiting agent nodes */}
      {nodes.map((t, i) => {
        const ring = i % 3
        const radius = [128, 100, 72][ring]
        const period = [26, 19, 13][ring]
        const angle = (360 / Math.max(1, Math.min(nodes.length, 10))) * i
        return (
          <Link
            key={t.id}
            to={`/tasks/${t.id}`}
            className="orbit-node group z-10"
            style={{
              ['--orbit-r' as any]: `${radius}px`,
              ['--orbit-t' as any]: `${period}s`,
              ['--orbit-a' as any]: `${angle}deg`,
            }}
            title={t.title}
          >
            <span className={`block h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${STATUS_NODE[t.status] ?? 'bg-ink-dim'} ${t.status === 'running' ? 'dot-running' : ''}`} />
            <span className="pointer-events-none absolute left-3 top-0 hidden whitespace-nowrap rounded border border-edge bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink group-hover:block">
              {t.title.slice(0, 28)}
            </span>
          </Link>
        )
      })}
      {active.length === 0 && (
        <div className="absolute inset-x-0 bottom-6 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-ink-dimmer">
          all agents idle
        </div>
      )}
    </div>
  )
}

function AgentRoster({ active }: { active: Task[] }) {
  return (
    <div className="glass hud-corner p-3">
      <div className="hud-label mb-2">Active Agents</div>
      <div className="space-y-1.5">
        {active.length === 0 && (
          <div className="px-1 py-3 text-center font-mono text-[11px] text-ink-dimmer">— no live agents —</div>
        )}
        {active.map((t) => (
          <Link
            key={t.id}
            to={t.kind === 'chat' ? `/chat/${t.id}` : `/tasks/${t.id}`}
            className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-edge hover:bg-panel-2/60"
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_NODE[t.status] ?? 'bg-ink-dim'} ${['running', 'verifying'].includes(t.status) ? 'dot-running' : ''}`} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-ink-2">{t.kind === 'chat' ? '⌁ ' : ''}{t.title}</div>
              <div className="truncate font-mono text-[10px] text-ink-dim">
                {t.status.replace('_', ' ')} · ~${(t.total_cost_usd ?? 0).toFixed(3)}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}

function Ticker() {
  const ticker = useStore((s) => s.ticker)
  if (ticker.length === 0) return null
  const items = [...ticker, ...ticker] // duplicate for seamless marquee
  return (
    <div className="glass mt-4 overflow-hidden !rounded-md px-0 py-1.5">
      <div className="ticker-track gap-10 px-4">
        {items.map((e, i) => (
          <span key={i} className="inline-flex items-center gap-2 font-mono text-[11px]">
            <span className="text-ink-dimmer">[{new Date(e.ts.endsWith('Z') ? e.ts : e.ts + 'Z').toLocaleTimeString()}]</span>
            <span className={
              e.tone === 'ok' ? 'text-ok' : e.tone === 'err' ? 'text-err' : e.tone === 'warn' ? 'text-warn' : 'text-ink-2'
            }>{e.text}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export default function MissionControl() {
  const tasks = useStore((s) => s.tasks)
  const stats = useStore((s) => s.stats)
  const setTasks = useStore((s) => s.setTasks)
  const setStats = useStore((s) => s.setStats)
  const [showNew, setShowNew] = useState(false)

  useEffect(() => {
    get<Task[]>('/api/tasks').then(setTasks)
    get<Stats>('/api/stats').then(setStats)
    const t = setInterval(() => get<Stats>('/api/stats').then(setStats).catch(() => {}), 30000)
    return () => clearInterval(t)
  }, [setTasks, setStats])

  const all = Object.values(tasks)
  const active = all
    .filter((t) => ACTIVE_STATUSES.includes(t.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const recent = all
    .filter((t) => !ACTIVE_STATUSES.includes(t.status))
    .sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at))
    .slice(0, 9)
  const liveCost = active.reduce((sum, t) => sum + (t.total_cost_usd ?? 0), 0)

  return (
    <div className="min-h-full p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="hud-label !text-xs">Mission Control</h1>
          <div className="mt-0.5 font-mono text-[10px] text-ink-dimmer">
            {new Date().toUTCString().slice(0, 22)} UTC · sector: local
          </div>
        </div>
        <button
          className="hud-corner glass-bright px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest text-accent transition-all hover:shadow-[0_0_24px_rgba(127,200,255,0.25)]"
          onClick={() => setShowNew(true)}
        >
          + Deploy Agent
        </button>
      </div>

      {/* cockpit: roster / reactor / telemetry */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(220px,1fr)_minmax(320px,1.4fr)_minmax(220px,1fr)]">
        <AgentRoster active={active} />

        <div className="glass hud-corner scanlines relative flex items-center justify-center p-4">
          <Reactor active={active} />
        </div>

        <div className="flex flex-col gap-3">
          <StatTile label="Cost today (~est)" color="#facc15">
            <CountUp value={stats?.cost_today_usd ?? 0} prefix="$" decimals={3} />
          </StatTile>
          <StatTile label="Tokens today" color="#34d399">
            <CountUp value={((stats?.tokens_today.input ?? 0) + (stats?.tokens_today.output ?? 0)) / 1000} decimals={1} />
            <span className="text-sm text-ink-dim">k</span>
          </StatTile>
          <StatTile label="Live burn" active={liveCost > 0} color="#f472b6">
            <CountUp value={liveCost} prefix="$" decimals={3} />
          </StatTile>
          <StatTile label="Week total" color="#c084fc">
            <CountUp value={stats?.cost_week_usd ?? 0} prefix="$" decimals={2} />
          </StatTile>
        </div>
      </div>

      <Ticker />

      <div className="mt-5 flex items-center gap-3">
        <h2 className="hud-label">Recent Operations</h2>
        <hr className="neon-divider flex-1" />
      </div>
      <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {recent.map((t) => <TaskCard key={t.id} task={t} />)}
      </div>

      {showNew && <NewTaskModal onClose={() => setShowNew(false)} />}
    </div>
  )
}
