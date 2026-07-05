import type { TaskStatus } from '../lib/types'

const STYLES: Record<TaskStatus, { label: string; cls: string; dot: string }> = {
  queued: { label: 'QUEUED', cls: 'bg-slate-700/40 text-slate-300', dot: 'bg-slate-400' },
  running: { label: 'RUNNING', cls: 'bg-sky-500/15 text-sky-300', dot: 'bg-sky-400 dot-running' },
  awaiting_approval: { label: 'NEEDS APPROVAL', cls: 'bg-amber-500/15 text-amber-300', dot: 'bg-amber-400 dot-running' },
  waiting_input: { label: 'WAITING INPUT', cls: 'bg-amber-500/15 text-amber-200', dot: 'bg-amber-300 dot-running' },
  verifying: { label: 'VERIFYING', cls: 'bg-violet-500/15 text-violet-300', dot: 'bg-violet-400 dot-running' },
  done: { label: 'DONE', cls: 'bg-emerald-500/15 text-emerald-300', dot: 'bg-emerald-400' },
  failed: { label: 'FAILED', cls: 'bg-red-500/15 text-red-300', dot: 'bg-red-400' },
  cancelled: { label: 'CANCELLED', cls: 'bg-slate-700/40 text-slate-400', dot: 'bg-slate-500' },
}

export default function StatusPill({ status }: { status: TaskStatus }) {
  const s = STYLES[status] ?? STYLES.queued
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wider ${s.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  )
}
