import { create } from 'zustand'
import type { Stats, Task, TaskEvent } from '../lib/types'

const EVENT_CAP = 2000
const TICKER_CAP = 40

export interface TickerEntry {
  ts: string
  text: string
  tone: 'info' | 'ok' | 'warn' | 'err'
}

const TOAST_CAP = 8

export interface ApprovalToast {
  id: string        // the approval_id — lets approval_resolved clear the exact card
  taskId: string
  taskTitle: string
  tool: string
  command: string   // Bash command / file_path snippet, when present
  ts: string
}

export interface Identity {
  kind: 'master' | 'device'
  scopes: string[] | null // null = master (all scopes)
}

interface RezidentStore {
  wsStatus: 'connecting' | 'open' | 'closed'
  tasks: Record<string, Task>
  taskEvents: Record<string, TaskEvent[]>
  streaming: Record<string, string> // taskId -> live (unpersisted) ACP token stream for the in-flight turn
  pendingApprovalCount: number
  approvalBump: number // increments to trigger badge-pop animation
  stats: Stats | null
  ticker: TickerEntry[]
  pipelineRuns: Record<string, any>
  approvalToasts: ApprovalToast[]
  // Single source of truth for the desktop self-update indicator. Set by whichever
  // component fetches /api/update/status (App-level check + the System panel), read
  // by the App-level announce and the System nav badge so there's no double-fetch race.
  updateAvailable: boolean
  updateLatest: string
  // Who this session's bearer is (GET /api/whoami). null until fetched; a paired
  // handset is kind:'device' and master-only controls render locked for it.
  identity: Identity | null
  // Single-slot "master clearance required" toast — refreshed (not stacked) on
  // repeat 403s; `at` bumps so the card re-arms its auto-dismiss timer.
  forbidden: { message: string; at: number } | null

  setWsStatus: (s: RezidentStore['wsStatus']) => void
  upsertTask: (task: Task) => void
  setTasks: (tasks: Task[]) => void
  appendEvent: (event: TaskEvent) => void
  setEvents: (taskId: string, events: TaskEvent[]) => void
  clearEvents: (taskId: string) => void
  appendStream: (taskId: string, text: string) => void
  clearStream: (taskId: string) => void
  setStats: (stats: Stats) => void
  setPendingApprovalCount: (n: number) => void
  bumpApprovals: (delta: number) => void
  pushTicker: (entry: TickerEntry) => void
  upsertPipelineRun: (run: any) => void
  pushApprovalToast: (toast: ApprovalToast) => void
  dismissApprovalToast: (id: string) => void
  clearApprovalToasts: () => void
  setUpdateStatus: (available: boolean, latest: string) => void
  setIdentity: (identity: Identity) => void
  pushForbidden: (message: string) => void
  clearForbidden: () => void
}

export const useStore = create<RezidentStore>((set) => ({
  wsStatus: 'connecting',
  tasks: {},
  taskEvents: {},
  streaming: {},
  pendingApprovalCount: 0,
  approvalBump: 0,
  stats: null,
  ticker: [],
  pipelineRuns: {},
  approvalToasts: [],
  updateAvailable: false,
  updateLatest: '',
  identity: null,
  forbidden: null,

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
  appendStream: (taskId, text) =>
    set((s) => ({ streaming: { ...s.streaming, [taskId]: (s.streaming[taskId] ?? '') + text } })),
  clearStream: (taskId) =>
    set((s) => {
      if (!(taskId in s.streaming)) return {}
      const { [taskId]: _s, ...rest } = s.streaming
      return { streaming: rest }
    }),
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
  pushApprovalToast: (toast) =>
    set((s) =>
      s.approvalToasts.some((t) => t.id === toast.id)
        ? {}
        : { approvalToasts: [toast, ...s.approvalToasts].slice(0, TOAST_CAP) },
    ),
  dismissApprovalToast: (id) =>
    set((s) => {
      const next = s.approvalToasts.filter((t) => t.id !== id)
      return next.length === s.approvalToasts.length ? {} : { approvalToasts: next }
    }),
  clearApprovalToasts: () => set((s) => (s.approvalToasts.length ? { approvalToasts: [] } : {})),
  setUpdateStatus: (available, latest) =>
    set((s) =>
      s.updateAvailable === available && s.updateLatest === latest
        ? {}
        : { updateAvailable: available, updateLatest: latest },
    ),
  setIdentity: (identity) => set({ identity }),
  pushForbidden: (message) => set({ forbidden: { message, at: Date.now() } }),
  clearForbidden: () => set({ forbidden: null }),
}))

/** True when this session holds a paired-device token (not the master).
 *  While identity is still loading (null) it reports false, so the desktop
 *  never flashes locked controls. */
export function useIsHandset(): boolean {
  return useStore((s) => s.identity?.kind === 'device')
}
