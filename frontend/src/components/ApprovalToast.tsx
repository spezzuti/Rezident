import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import type { ApprovalToast as ToastEntry } from '../store'
import { requestNotifyPermission } from '../lib/notify'

const MAX_VISIBLE = 3
const NUDGE_DISMISSED = 'agentos_notify_nudge_dismissed'

function currentPerm(): string {
  return typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
}

function toolLine(t: ToastEntry): string {
  const s = t.command ? `${t.tool} — ${t.command}` : t.tool
  return s.length > 120 ? s.slice(0, 119) + '…' : s
}

/**
 * APPROVAL TOAST — the PIP-OS in-page interrupt for `approval_pending`. A sticky
 * vault-door card (amber/warning enamel) top-right; no auto-dismiss because an
 * approval is the highest-value interrupt. Fed from store.approvalToasts (pushed
 * at the same ws.ts spot that plays the chime), so it clears itself the instant
 * the matching approval resolves. Stacks to 3, older ones fold into "+N more".
 */
export default function ApprovalToast({ mobile }: { mobile?: boolean }) {
  const toasts = useStore((s) => s.approvalToasts)
  const pending = useStore((s) => s.pendingApprovalCount)
  const dismiss = useStore((s) => s.dismissApprovalToast)
  const clearAll = useStore((s) => s.clearApprovalToasts)
  const navigate = useNavigate()

  const [perm, setPerm] = useState(currentPerm())
  const [nudgeOff, setNudgeOff] = useState(() => localStorage.getItem(NUDGE_DISMISSED) === '1')

  // Safety net: if the pending count falls to zero (e.g. resolved in another tab,
  // or a resync), don't leave orphaned cards hanging around.
  useEffect(() => {
    if (pending === 0 && toasts.length > 0) clearAll()
  }, [pending, toasts.length, clearAll])

  if (toasts.length === 0) return null

  const visible = toasts.slice(0, MAX_VISIBLE)
  const hidden = toasts.length - visible.length
  const showNudge = !nudgeOff && perm !== 'granted' && perm !== 'unsupported'

  const view = (t: ToastEntry) => {
    dismiss(t.id)
    navigate('/approvals')
  }

  const enableAlerts = () => {
    requestNotifyPermission().then((p) => {
      setPerm(p)
      if (p === 'granted') { localStorage.setItem(NUDGE_DISMISSED, '1'); setNudgeOff(true) }
    })
  }

  const dismissNudge = () => {
    localStorage.setItem(NUDGE_DISMISSED, '1')
    setNudgeOff(true)
  }

  return (
    <div className="wl-appr" style={mobile ? { right: 8, left: 8, top: 8 } : undefined}>
      {visible.map((t, i) => (
        <div className="wl-appr-card wl-appr-in" key={t.id}>
          <div className="wl-appr-stripe" />
          <div className="wl-appr-head wl-mono">⏸ VAULT DOOR SEALED</div>
          <div className="wl-appr-body">
            <div className="wl-appr-task">{t.taskTitle}</div>
            <div className="wl-appr-tool wl-mono">{toolLine(t)}</div>
          </div>
          {i === 0 && showNudge && (
            <div className="wl-appr-nudge wl-mono">
              <span>desktop alerts are off — </span>
              <button type="button" className="wl-appr-nudge-btn" onClick={enableAlerts}>ENABLE</button>
              <button type="button" className="wl-appr-nudge-x" title="don't show again" onClick={dismissNudge}>✕</button>
            </div>
          )}
          <div className="wl-appr-actions">
            <button type="button" className="wl-appr-btn wl-appr-btn--view" onClick={() => view(t)}>VIEW</button>
            <button type="button" className="wl-appr-btn wl-appr-btn--dismiss" onClick={() => dismiss(t.id)}>DISMISS</button>
          </div>
        </div>
      ))}
      {hidden > 0 && (
        <div className="wl-appr-more wl-mono" onClick={() => navigate('/approvals')} title="open the Vault Door">
          +{hidden} more awaiting sign-off →
        </div>
      )}
    </div>
  )
}
