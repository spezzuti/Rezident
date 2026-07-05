/**
 * Singleton WebSocket: auto-reconnect with backoff, per-channel seq tracking
 * so a phone that slept resumes with `after` and misses nothing.
 */
import { getToken } from './api'
import { useStore } from '../store'
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
      if (msg.type === 'task_upsert') store.upsertTask(msg.payload as Task)
      else if (msg.type === 'approval_pending') store.bumpApprovals(1)
      else if (msg.type === 'approval_resolved') store.bumpApprovals(-1)
      return
    }
    if (msg.channel?.startsWith('task:')) {
      const event = msg as TaskEvent
      this.lastSeq[msg.channel] = Math.max(this.lastSeq[msg.channel] ?? 0, event.seq)
      store.appendEvent(event)
    }
  }
}

export const wsClient = new WSClient()
