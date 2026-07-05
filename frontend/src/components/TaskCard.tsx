import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Task } from '../lib/types'
import StatusPill from './StatusPill'

function elapsed(task: Task): string {
  if (!task.started_at) return '—'
  const end = task.finished_at ? Date.parse(task.finished_at) : Date.now()
  const secs = Math.max(0, Math.floor((end - Date.parse(task.started_at)) / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export default function TaskCard({ task, activity }: { task: Task; activity?: string }) {
  const [, forceTick] = useState(0)
  const prevStatus = useRef(task.status)
  const [flash, setFlash] = useState('')

  const isLive = ['running', 'awaiting_approval', 'waiting_input', 'verifying'].includes(task.status)

  useEffect(() => {
    if (!isLive) return
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [isLive])

  useEffect(() => {
    if (prevStatus.current !== task.status) {
      if (task.status === 'done') setFlash('card-done-flash')
      if (task.status === 'failed') setFlash('card-failed-shake')
      prevStatus.current = task.status
    }
  }, [task.status])

  const glow =
    task.status === 'running'
      ? 'card-running'
      : task.status === 'verifying'
        ? 'card-verifying'
        : task.status === 'awaiting_approval' || task.status === 'waiting_input'
          ? 'card-awaiting'
          : ''

  return (
    <Link
      to={task.kind === 'chat' ? `/chat/${task.id}` : `/tasks/${task.id}`}
      className={`glass block p-3 transition-all hover:-translate-y-0.5 ${glow} ${flash}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="truncate text-sm font-semibold text-ink">{task.title}</div>
        <StatusPill status={task.status} />
      </div>
      {activity && (
        <div className="event-in mt-1.5 truncate font-mono text-xs text-ink-dim">{activity}</div>
      )}
      {task.error && !activity && (
        <div className="mt-1.5 truncate font-mono text-xs text-err">{task.error}</div>
      )}
      <div className="mt-2 flex items-center gap-3 font-mono text-[11px] text-ink-dim">
        <span>⏱ {elapsed(task)}</span>
        <span>~${(task.total_cost_usd ?? 0).toFixed(3)}</span>
        <span>{((task.input_tokens + task.output_tokens) / 1000).toFixed(1)}k tok</span>
        {task.verify_command && <span title="has verification">✓ verify</span>}
      </div>
    </Link>
  )
}
