import { useEffect, useState } from 'react'
import { get } from '../lib/api'
import { ACTIVE_STATUSES, type Stats, type Task } from '../lib/types'
import { useStore } from '../store'
import { CountUp, StatTile } from '../components/CostMeter'
import TaskCard from '../components/TaskCard'
import NewTaskModal from '../components/NewTaskModal'

export default function MissionControl() {
  const tasks = useStore((s) => s.tasks)
  const stats = useStore((s) => s.stats)
  const setTasks = useStore((s) => s.setTasks)
  const setStats = useStore((s) => s.setStats)
  const [showNew, setShowNew] = useState(false)

  useEffect(() => {
    get<Task[]>('/api/tasks').then(setTasks)
    get<Stats>('/api/stats').then(setStats)
    const t = setInterval(() => get<Stats>('/api/stats').then(setStats), 30000)
    return () => clearInterval(t)
  }, [setTasks, setStats])

  const all = Object.values(tasks)
  const active = all
    .filter((t) => ACTIVE_STATUSES.includes(t.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const recent = all
    .filter((t) => !ACTIVE_STATUSES.includes(t.status))
    .sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at))
    .slice(0, 12)

  const liveCost = all
    .filter((t) => ACTIVE_STATUSES.includes(t.status))
    .reduce((sum, t) => sum + (t.total_cost_usd ?? 0), 0)

  return (
    <div className="scanlines min-h-full p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xs font-bold uppercase tracking-[0.2em] text-ink-dim">Mission Control</h1>
        <button
          className="rounded-md bg-accent/90 px-4 py-1.5 text-sm font-semibold text-black hover:bg-accent"
          onClick={() => setShowNew(true)}
        >
          + New Task
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Active agents" active={active.length > 0}>
          <CountUp value={active.length} />
        </StatTile>
        <StatTile label="Cost today (~est)">
          <CountUp value={stats?.cost_today_usd ?? 0} prefix="$" decimals={3} />
        </StatTile>
        <StatTile label="Tokens today">
          <CountUp value={((stats?.tokens_today.input ?? 0) + (stats?.tokens_today.output ?? 0)) / 1000} decimals={1} />
          <span className="text-sm text-ink-dim">k</span>
        </StatTile>
        <StatTile label="Live run cost" active={liveCost > 0}>
          <CountUp value={liveCost} prefix="$" decimals={3} />
        </StatTile>
      </div>

      <h2 className="mt-6 text-xs font-bold uppercase tracking-[0.2em] text-ink-dim">
        Active <span className="text-accent">({active.length})</span>
      </h2>
      {active.length === 0 ? (
        <div className="mt-2 rounded-lg border border-dashed border-edge p-6 text-center text-sm text-ink-dim">
          No active agents. Launch a task to begin.
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {active.map((t) => <TaskCard key={t.id} task={t} />)}
        </div>
      )}

      <h2 className="mt-6 text-xs font-bold uppercase tracking-[0.2em] text-ink-dim">Recent</h2>
      <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {recent.map((t) => <TaskCard key={t.id} task={t} />)}
      </div>

      {showNew && <NewTaskModal onClose={() => setShowNew(false)} />}
    </div>
  )
}
