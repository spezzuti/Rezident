import { create } from 'zustand'
import type { Stats, Task, TaskEvent } from '../lib/types'

const EVENT_CAP = 2000
const TICKER_CAP = 40

export interface TickerEntry {
  ts: string
  text: string
  tone: 'info' | 'ok' | 'warn' | 'err'
}

interface AgentOSStore {
  wsStatus: 'connecting' | 'open' | 'closed'
  tasks: Record<string, Task>
  taskEvents: Record<string, TaskEvent[]>
  pendingApprovalCount: number
  approvalBump: number // increments to trigger badge-pop animation
  stats: Stats | null
  ticker: TickerEntry[]
  pipelineRuns: Record<string, any>

  setWsStatus: (s: AgentOSStore['wsStatus']) => void
  upsertTask: (task: Task) => void
  setTasks: (tasks: Task[]) => void
  appendEvent: (event: TaskEvent) => void
  setEvents: (taskId: string, events: TaskEvent[]) => void
  clearEvents: (taskId: string) => void
  setStats: (stats: Stats) => void
  setPendingApprovalCount: (n: number) => void
  bumpApprovals: (delta: number) => void
  pushTicker: (entry: TickerEntry) => void
  upsertPipelineRun: (run: any) => void
}

export const useStore = create<AgentOSStore>((set) => ({
  wsStatus: 'connecting',
  tasks: {},
  taskEvents: {},
  pendingApprovalCount: 0,
  approvalBump: 0,
  stats: null,
  ticker: [],
  pipelineRuns: {},

  setWsStatus: (wsStatus) => set({ wsStatus }),
  upsertTask: (task) => set((s) => ({ tasks: { ...s.tasks, [task.id]: task } })),
  setTasks: (tasks) =>
    set(() => ({ tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) })),
  appendEvent: (event) =>
    set((s) => {
      const existing = s.taskEvents[event.task_id] ?? []
      // Dedupe by seq (replay + live tail can overlap at the boundary).
      if (existing.length > 0 && existing[existing.length - 1].seq >= event.seq) {
        if (existing.some((e) => e.seq === event.seq)) return {}
      }
      const next = [...existing, event].slice(-EVENT_CAP)
      return { taskEvents: { ...s.taskEvents, [event.task_id]: next } }
    }),
  setEvents: (taskId, events) =>
    set((s) => ({ taskEvents: { ...s.taskEvents, [taskId]: events.slice(-EVENT_CAP) } })),
  clearEvents: (taskId) =>
    set((s) => {
      const { [taskId]: _, ...rest } = s.taskEvents
      return { taskEvents: rest }
    }),
  setStats: (stats) => set({ stats }),
  setPendingApprovalCount: (n) => set({ pendingApprovalCount: n }),
  bumpApprovals: (delta) =>
    set((s) => ({
      pendingApprovalCount: Math.max(0, s.pendingApprovalCount + delta),
      approvalBump: delta > 0 ? s.approvalBump + 1 : s.approvalBump,
    })),
  pushTicker: (entry) =>
    set((s) => ({ ticker: [entry, ...s.ticker].slice(0, TICKER_CAP) })),
  upsertPipelineRun: (run) =>
    set((s) => ({ pipelineRuns: { ...s.pipelineRuns, [run.id]: run } })),
}))
