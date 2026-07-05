import { useEffect } from 'react'
import { get } from '../lib/api'
import type { Task, TaskStatus } from '../lib/types'
import { useStore } from '../store'
import TaskCard from '../components/TaskCard'

const COLUMNS: { title: string; statuses: TaskStatus[] }[] = [
  { title: 'Queued', statuses: ['queued'] },
  { title: 'Running', statuses: ['running', 'awaiting_approval', 'waiting_input'] },
  { title: 'Verifying', statuses: ['verifying'] },
  { title: 'Done', statuses: ['done'] },
  { title: 'Failed', statuses: ['failed', 'cancelled'] },
]

export default function TaskBoard() {
  const tasks = useStore((s) => s.tasks)
  const setTasks = useStore((s) => s.setTasks)

  useEffect(() => {
    get<Task[]>('/api/tasks').then(setTasks)
  }, [setTasks])

  const all = Object.values(tasks).sort((a, b) => b.created_at.localeCompare(a.created_at))

  return (
    <div className="min-h-full p-4 md:p-6">
      <h1 className="text-xs font-bold uppercase tracking-[0.2em] text-ink-dim">Task Board</h1>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {COLUMNS.map((col) => {
          const items = all.filter((t) => col.statuses.includes(t.status))
          return (
            <div key={col.title} className="rounded-lg border border-edge bg-panel/50 p-2">
              <div className="flex items-center justify-between px-1 pb-2 pt-1">
                <span className="text-[11px] font-bold uppercase tracking-widest text-ink-dim">{col.title}</span>
                <span className="rounded-full bg-panel-2 px-2 text-[11px] font-mono text-ink-dim">{items.length}</span>
              </div>
              <div className="space-y-2">
                {items.map((t) => <TaskCard key={t.id} task={t} />)}
                {items.length === 0 && (
                  <div className="rounded-md border border-dashed border-edge/60 p-4 text-center text-xs text-ink-dim/60">
                    empty
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
