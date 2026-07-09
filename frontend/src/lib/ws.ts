/**
 * Singleton WebSocket: auto-reconnect with backoff, per-channel seq tracking
 * so a phone that slept resumes with `after` and misses nothing.
 */
import { getToken } from './api'
import { useStore } from '../store'
import { fireApproval } from './notify'
import { sfx } from './sound'
import type { Task, TaskEvent } from './types'

type Channel = string

class WSClient {
  private ws: WebSocket | null = null
  private channels = new Set<Channel>()
  private lastSeq: Record<string, number> = {}
  private backoff = 500
  private reconnectTimer: number | null = null
  private closedByUser = false

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.closedByUser = false
    useStore.getState().setWsStatus('connecting')
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(getToken())}`)

    this.ws.onopen = () => {
      this.backoff = 500
      useStore.getState().setWsStatus('open')
      if (this.channels.size > 0) this.sendSubscribe([...this.channels])
    }
    this.ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data))
    this.ws.onclose = () => {
      useStore.getState().setWsStatus('closed')
      this.ws = null
      if (!this.closedByUser) {
        this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, 15000)
      }
    }
    this.ws.onerror = () => this.ws?.close()
  }

  disconnect() {
    this.closedByUser = true
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }

  subscribe(channel: Channel) {
    if (this.channels.has(channel)) return
    this.channels.add(channel)
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe([channel])
  }

  unsubscribe(channel: Channel) {
    this.channels.delete(channel)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ unsubscribe: [channel] }))
    }
  }

  private sendSubscribe(channels: Channel[]) {
    const after: Record<string, number> = {}
    for (const ch of channels) {
      if (this.lastSeq[ch]) after[ch] = this.lastSeq[ch]
    }
    this.ws!.send(JSON.stringify({ subscribe: channels, after }))
  }

  private handleMessage(msg: any) {
    const store = useStore.getState()
    if (msg.type === 'resync') {
      // Queue overflowed server-side; re-hydrate open task streams via REST.
      window.dispatchEvent(new CustomEvent('agentos:resync'))
      return
    }
    if (msg.channel === 'global') {
      if (msg.type === 'task_upsert') {
        const task = msg.payload as Task
        const prev = store.tasks[task.id]
        // audible verdicts in PIP-OS only — the GRID//OS deck has its own voice
        if (prev && prev.status !== task.status && document.documentElement.dataset.theme !== 'cyber') {
          if (task.status === 'done') sfx.done()
          else if (task.status === 'failed') sfx.fail()
        }
        if (!prev || prev.status !== task.status) {
          store.pushTicker({
            ts: msg.ts,
            text: `${task.title} → ${task.status.replace('_', ' ').toUpperCase()}`,
            tone: task.status === 'done' ? 'ok'
              : task.status === 'failed' ? 'err'
              : task.status === 'awaiting_approval' ? 'warn' : 'info',
          })
        }
        store.upsertTask(task)
      } else if (msg.type === 'approval_pending') {
        store.bumpApprovals(1)
        store.pushTicker({ ts: msg.ts, text: `⏸ APPROVAL REQUIRED · ${msg.payload.tool} · ${msg.payload.task_title ?? ''}`, tone: 'warn' })
        // Drive the in-page toast from the store (the toast is React; notify.ts is a plain module).
        const input = (msg.payload.input ?? {}) as Record<string, unknown>
        const command = typeof input.command === 'string' ? input.command
          : typeof input.file_path === 'string' ? input.file_path : ''
        store.pushApprovalToast({
          id: msg.payload.approval_id ?? `${msg.payload.task_id}:${msg.ts}`,
          taskId: msg.payload.task_id ?? '',
          taskTitle: msg.payload.task_title ?? 'A task',
          tool: msg.payload.tool ?? 'a tool',
          command,
          ts: msg.ts,
        })
        fireApproval(msg.payload.task_title ?? 'A task', msg.payload.tool ?? 'a tool')
      } else if (msg.type === 'approval_resolved') {
        store.bumpApprovals(-1)
        // clear the exact card this resolution belongs to (approve/deny/cancel all route here)
        if (msg.payload?.approval_id) store.dismissApprovalToast(msg.payload.approval_id)
      } else if (msg.type === 'pipeline_update') {
        const run = msg.payload
        const prevRun = store.pipelineRuns[run.id]
        // a run crossing from running → terminal is the completion MOMENT: one
        // ticker line + one audible verdict (PIP-OS only; GRID//OS has its own voice)
        const terminal = run.status === 'done' || run.status === 'failed' || run.status === 'cancelled'
        if (prevRun && prevRun.status === 'running' && terminal) {
          const NAME = (run.pipeline_name ?? 'PIPELINE').toUpperCase()
          if (document.documentElement.dataset.theme !== 'cyber') {
            if (run.status === 'done') sfx.done()
            else if (run.status === 'failed') sfx.fail()
          }
          const text = run.status === 'done'
            ? `▣ OPERATION COMPLETE — ${NAME}${run.result_summary ? ' · ' + String(run.result_summary).slice(0, 80) : ''}`
            : run.status === 'failed'
              ? `▣ OPERATION FAILED — ${NAME} · ${String(run.error ?? '').slice(0, 120)}`
              : `▣ OPERATION ABORTED — ${NAME}`
          store.pushTicker({
            ts: msg.ts,
            text,
            tone: run.status === 'done' ? 'ok' : run.status === 'failed' ? 'err' : 'warn',
          })
        }
        store.upsertPipelineRun(run)
      }
      return
    }
    if (msg.channel?.startsWith('task:')) {
      // transient ACP streaming deltas — no seq, not persisted; accumulate a live bubble
      if (msg.type === 'assistant_delta') { store.appendStream(msg.task_id, msg.payload?.text ?? ''); return }
      if (msg.type === 'thinking_delta' || msg.type === 'stream_end') return
      const event = msg as TaskEvent
      this.lastSeq[msg.channel] = Math.max(this.lastSeq[msg.channel] ?? 0, event.seq)
      // the persisted full reply supersedes the live stream — seal the bubble
      if (msg.type === 'assistant_text') store.clearStream(msg.task_id)
      store.appendEvent(event)
    }
  }
}

export const wsClient = new WSClient()
