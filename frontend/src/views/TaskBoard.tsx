import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { get, post } from '../lib/api'
import type { Task, TaskStatus } from '../lib/types'
import { useStore } from '../store'
import TaskCard from '../components/TaskCard'
import NewTaskModal from '../components/NewTaskModal'

const COLUMNS: { key: string; title: string; statuses: TaskStatus[]; accent: string }[] = [
  { key: 'queued', title: 'Queued', statuses: ['queued'], accent: 'text-ink-dim' },
  { key: 'running', title: 'Running', statuses: ['running', 'awaiting_approval', 'waiting_input'], accent: 'text-accent' },
  { key: 'verifying', title: 'Verifying', statuses: ['verifying'], accent: 'text-violet' },
  { key: 'done', title: 'Done', statuses: ['done'], accent: 'text-ok' },
  { key: 'failed', title: 'Failed / Cancelled', statuses: ['failed', 'cancelled'], accent: 'text-err' },
]

/** Drops that mean something:
 *  - active card → Failed column  = cancel the task
 *  - terminal card → Queued column = retry (spawns a fresh run)
 */
function dropAction(task: Task, columnKey: string): 'cancel' | 'retry' | null {
  const active = ['queued', 'running', 'awaiting_approval', 'waiting_input', 'verifying'].includes(task.status)
  if (active && columnKey === 'failed') return 'cancel'
  if (!active && columnKey === 'queued') return 'retry'
  return null
}

export default function TaskBoard() {
  const tasks = useStore((s) => s.tasks)
  const setTasks = useStore((s) => s.setTasks)
  const upsertTask = useStore((s) => s.upsertTask)
  const [dragTask, setDragTask] = useState<Task | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    get<Task[]>('/api/tasks').then(setTasks)
  }, [setTasks])

  const all = Object.values(tasks)
    .filter((t) => t.kind !== 'chat')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))

  async function handleDrop(columnKey: string) {
    if (!dragTask) return
    const action = dropAction(dragTask, columnKey)
    setOverCol(null)
    setDragTask(null)
    if (action === 'cancel') {
      await post(`/api/tasks/${dragTask.id}/cancel`).catch(() => {})
    } else if (action === 'retry') {
      const child = await post<Task>(`/api/tasks/${dragTask.id}/retry`).catch(() => null)
      if (child) {
        upsertTask(child)
        navigate(`/tasks/${child.id}`)
      }
    }
  }

  return (
    <div className="min-h-full p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="hud-label !text-xs" style={{ color: '#38bdf8' }}>Task Board</h1>
          <div className="mt-0.5 font-mono text-[10px] text-ink-dimmer">
            drag an active card to <span className="text-err">Failed</span> to abort · drag a finished card to{' '}
            <span className="text-ink-2">Queued</span> to re-run
          </div>
        </div>
        <button
          className="hud-corner glass-bright px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest hover:shadow-[0_0_24px_rgba(56,189,248,0.3)]"
          style={{ color: '#38bdf8' }}
          onClick={() => setShowNew(true)}
        >
          + Deploy
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {COLUMNS.map((col) => {
          const items = all.filter((t) => col.statuses.includes(t.status))
          const legal = dragTask ? dropAction(dragTask, col.key) : null
          return (
            <div
              key={col.key}
              onDragOver={(e) => {
                if (legal) {
                  e.preventDefault()
                  setOverCol(col.key)
                }
              }}
              onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
              onDrop={() => handleDrop(col.key)}
              className={`glass !rounded-lg p-2 transition-all ${
                overCol === col.key && legal ? 'drag-over shadow-[0_0_24px_rgba(127,200,255,0.2)]' : ''
              } ${dragTask && legal ? 'border-accent/30' : ''}`}
            >
              <div className="flex items-center justify-between px-1 pb-2 pt-1">
                <span className={`hud-label ${col.accent}`}>{col.title}</span>
                <span className="rounded-full bg-panel-2 px-2 font-mono text-[11px] text-ink-dim">{items.length}</span>
              </div>
              {dragTask && legal && overCol === col.key && (
                <div className="mb-2 rounded-md border border-dashed border-accent/50 px-2 py-1.5 text-center font-mono text-[10px] uppercase tracking-widest text-accent">
                  {legal === 'cancel' ? 'release to abort' : 'release to re-run'}
                </div>
              )}
              <div className="space-y-2">
                {items.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={() => setDragTask(t)}
                    onDragEnd={() => { setDragTask(null); setOverCol(null) }}
                    className={dragTask?.id === t.id ? 'dragging' : ''}
                  >
                    <TaskCard task={t} />
                  </div>
                ))}
                {items.length === 0 && (
                  <div className="rounded-md border border-dashed border-edge/60 p-4 text-center font-mono text-[10px] uppercase tracking-widest text-ink-dimmer">
                    empty
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {showNew && <NewTaskModal onClose={() => setShowNew(false)} />}
    </div>
  )
}
