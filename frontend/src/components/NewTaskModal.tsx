import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { post } from '../lib/api'
import type { Task } from '../lib/types'
import { useStore } from '../store'

export default function NewTaskModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState('')
  const [verify, setVerify] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const upsertTask = useStore((s) => s.upsertTask)
  const navigate = useNavigate()

  async function submit() {
    if (!title.trim() || !prompt.trim()) return
    setBusy(true)
    setError('')
    try {
      const task = await post<Task>('/api/tasks', {
        title: title.trim(),
        prompt: prompt.trim(),
        kind: 'general',
        cwd: cwd.trim() || null,
        verify_command: verify.trim() || null,
      })
      upsertTask(task)
      onClose()
      navigate(`/tasks/${task.id}`)
    } catch (e: any) {
      setError(e.message ?? 'failed to create task')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-edge bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-bold uppercase tracking-widest text-accent">New Task</h2>
        <div className="mt-4 space-y-3">
          <input
            autoFocus
            className="w-full rounded-md border border-edge bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="h-28 w-full rounded-md border border-edge bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            placeholder="Prompt — what should the agent do?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <input
            className="w-full rounded-md border border-edge bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            placeholder="Working directory (optional, defaults to scratch)"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
          <input
            className="w-full rounded-md border border-edge bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            placeholder="Verify command (optional, bash) — e.g. pytest -q"
            value={verify}
            onChange={(e) => setVerify(e.target.value)}
          />
          {error && <div className="text-sm text-err">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button className="rounded-md px-3 py-1.5 text-sm text-ink-dim hover:text-ink" onClick={onClose}>
              Cancel
            </button>
            <button
              className="rounded-md bg-accent/90 px-4 py-1.5 text-sm font-semibold text-black hover:bg-accent disabled:opacity-50"
              disabled={busy || !title.trim() || !prompt.trim()}
              onClick={submit}
            >
              {busy ? 'Launching…' : 'Launch'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
