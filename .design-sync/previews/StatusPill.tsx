import { StatusPill } from 'agentos-frontend'

const row: React.CSSProperties = {
  display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
  padding: 16, background: 'var(--color-bg)', borderRadius: 4, border: '1px solid var(--color-edge)',
}

export const ActiveStates = () => (
  <div style={row}>
    <StatusPill status="queued" />
    <StatusPill status="running" />
    <StatusPill status="awaiting_approval" />
    <StatusPill status="waiting_input" />
    <StatusPill status="verifying" />
  </div>
)

export const TerminalStates = () => (
  <div style={row}>
    <StatusPill status="done" />
    <StatusPill status="failed" />
    <StatusPill status="cancelled" />
  </div>
)
