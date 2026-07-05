import type { TaskStatus } from '../lib/types'

// Semantic theme vars so pills recolor with the active theme.
const STYLES: Record<TaskStatus, { label: string; color: string; pulse?: boolean }> = {
  queued: { label: 'QUEUED', color: 'var(--color-ink-dim)' },
  running: { label: 'RUNNING', color: 'var(--color-accent)', pulse: true },
  awaiting_approval: { label: 'NEEDS CLEARANCE', color: 'var(--color-warn)', pulse: true },
  waiting_input: { label: 'AWAITING INPUT', color: 'var(--color-warn)', pulse: true },
  verifying: { label: 'VERIFYING', color: 'var(--color-violet)', pulse: true },
  done: { label: 'DONE', color: 'var(--color-ok)' },
  failed: { label: 'FAILED', color: 'var(--color-err)' },
  cancelled: { label: 'CANCELLED', color: 'var(--color-ink-dimmer)' },
}

export default function StatusPill({ status }: { status: TaskStatus }) {
  const s = STYLES[status] ?? STYLES.queued
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider"
      style={{ color: s.color, background: `color-mix(in srgb, ${s.color} 13%, transparent)` }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${s.pulse ? 'dot-running' : ''}`}
        style={{ background: s.color, boxShadow: `0 0 8px ${s.color}` }}
      />
      {s.label}
    </span>
  )
}
