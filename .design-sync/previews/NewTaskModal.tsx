import { NewTaskModal } from 'agentos-frontend'

/** The deploy-agent modal. It renders as a fixed full-viewport overlay; the
 * transform on the wrapper makes `position: fixed` resolve against the wrapper
 * instead of the viewport, so the whole modal fits the card. The agent-picker
 * row is absent here: it hydrates from /api/profiles, which doesn't exist at
 * design time. */
export const DeployAgent = () => (
  <div style={{ transform: 'translateZ(0)', position: 'relative', width: 680, height: 660, overflow: 'hidden', borderRadius: 6, background: 'var(--color-bg)' }}>
    <NewTaskModal onClose={() => {}} />
  </div>
)
