import { useEffect } from 'react'
import { useStore } from '../store'

const AUTO_DISMISS_MS = 8000

/**
 * MASTER CLEARANCE TOAST — the honest-UX backstop for a paired handset hitting a
 * master-only mutation (403). Single-slot (repeat taps refresh the same card
 * rather than stacking), auto-dismisses, and explains the recovery path instead
 * of leaving a button that silently does nothing. Fed from store.forbidden,
 * pushed by lib/api.ts.
 */
export default function MasterOnlyToast({ mobile }: { mobile?: boolean }) {
  const forbidden = useStore((s) => s.forbidden)
  const clear = useStore((s) => s.clearForbidden)

  useEffect(() => {
    if (!forbidden) return
    const t = window.setTimeout(clear, AUTO_DISMISS_MS)
    return () => window.clearTimeout(t)
  }, [forbidden, clear])

  if (!forbidden) return null

  return (
    <div className="wl-appr" style={mobile ? { right: 8, left: 8, bottom: 64, top: 'auto' } : { bottom: 24, top: 'auto' }}>
      <div className="wl-appr-card wl-appr-in" key={forbidden.at}>
        <div className="wl-appr-stripe" />
        <div className="wl-appr-head wl-mono">⛔ MASTER CLEARANCE REQUIRED</div>
        <div className="wl-appr-body">
          <div className="wl-appr-task">That control belongs to the overseer console.</div>
          <div className="wl-appr-tool wl-mono">
            {forbidden.message} — from a handset you can deploy, chat, and approve;
            configuration changes need the desktop login.
          </div>
        </div>
        <div className="wl-appr-actions">
          <button type="button" className="wl-appr-btn wl-appr-btn--dismiss" onClick={clear}>UNDERSTOOD</button>
        </div>
      </div>
    </div>
  )
}
