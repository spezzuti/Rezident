import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { get, post } from '../lib/api'
import { useStore } from '../store'

interface Approval {
  id: string
  task_id: string
  task_title?: string
  tool_name: string
  tool_input: Record<string, any>
  status: string
  created_at: string
}

function editableText(a: Approval): { field: string; value: string } | null {
  if (typeof a.tool_input?.command === 'string') return { field: 'command', value: a.tool_input.command }
  if (typeof a.tool_input?.file_path === 'string') return { field: 'file_path', value: a.tool_input.file_path }
  return null
}

function firstWords(command: string): string {
  const words = command.trim().split(/\s+/)
  return words.slice(0, Math.min(2, words.length)).join(' ')
}

function Toggle({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      className={`wl-toggle${on ? ' on' : ''}`}
      style={{ border: 'none', padding: 0, flex: 'none' }}
      onClick={onClick}
    >
      <span className="wl-toggle-lever" />
    </button>
  )
}

function ApprovalCard({ approval, onResolved }: { approval: Approval; onResolved: () => void }) {
  const editable = editableText(approval)
  const [edited, setEdited] = useState(editable?.value ?? '')
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function resolve(action: 'approve' | 'deny') {
    setBusy(true)
    setError('')
    const wasEdited = editable && edited !== editable.value
    const body: Record<string, any> = {
      action: action === 'approve' && wasEdited ? 'approve_edit' : action,
      reason: reason || undefined,
    }
    if (action === 'approve' && wasEdited && editable) {
      body.input = { ...approval.tool_input, [editable.field]: edited }
    }
    if (action === 'approve' && alwaysAllow && editable) {
      body.create_rule = {
        tool_name: approval.tool_name,
        field: editable.field,
        match_type: 'prefix',
        pattern: firstWords(edited),
        action: 'allow',
        priority: 80,
        description: `always allow (created from approval)`,
      }
    }
    try {
      await post(`/api/approvals/${approval.id}/resolve`, body)
      onResolved()
    } catch (e: any) {
      setError(e.message ?? 'failed')
      setBusy(false)
    }
  }

  const wasEdited = !!editable && edited !== editable.value

  return (
    <div className="wl-tile" style={{ padding: '13px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* containment order header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="wl-led wl-led--red wl-led--blink" />
        <span className="wl-lcd">{approval.tool_name.toUpperCase()}</span>
        <Link
          to={`/tasks/${approval.task_id}`}
          className="wl-mono"
          style={{ fontSize: 11, color: 'var(--wl-blue-hi)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
        >
          {approval.task_title ?? approval.task_id.slice(0, 8)}
        </Link>
        <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-faint)' }}>
          {new Date(approval.created_at + (approval.created_at.endsWith('Z') ? '' : 'Z')).toLocaleTimeString()}
        </span>
      </div>

      {/* payload — editable before opening the vault */}
      {editable ? (
        <textarea
          className="wl-input"
          style={{ width: '100%', resize: 'vertical' }}
          rows={Math.min(6, Math.max(2, edited.split('\n').length))}
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
        />
      ) : (
        <pre className="wl-input" style={{ margin: 0, maxHeight: 192, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 11 }}>
          {JSON.stringify(approval.tool_input, null, 2)}
        </pre>
      )}

      <input
        className="wl-input"
        style={{ width: '100%' }}
        placeholder="reason (sent to the agent on deny)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />

      {/* physical controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', paddingTop: 2 }}>
        <div className="wl-btn-housing">
          <button
            type="button"
            className="wl-btn"
            style={busy ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
            disabled={busy}
            onClick={() => resolve('approve')}
          >
            OPEN VAULT{wasEdited ? ' (EDITED)' : ''}
          </button>
        </div>
        <div className="wl-btn-housing">
          <button
            type="button"
            className="wl-btn wl-btn--steel"
            style={{ color: 'var(--wl-red-hi)', ...(busy ? { opacity: 0.5, pointerEvents: 'none' } : null) }}
            disabled={busy}
            onClick={() => resolve('deny')}
          >
            DENY
          </button>
        </div>
        {editable && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Toggle on={alwaysAllow} onClick={() => setAlwaysAllow(!alwaysAllow)} title="always allow this" />
            <span className="wl-microlabel" style={{ lineHeight: 1.5 }}>Standing<br />Order</span>
          </div>
        )}
      </div>
      {error && <div className="wl-mono" style={{ fontSize: 10, color: 'var(--wl-red-hi)' }}>⚠ {error}</div>}
    </div>
  )
}

/* closed steel vault door — pure CSS */
function VaultDoor() {
  const bolts = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * 2 * Math.PI - Math.PI / 2
    return { left: 105 + 88 * Math.cos(a) - 4.5, top: 105 + 88 * Math.sin(a) - 4.5, rot: i * 37 }
  })
  return (
    <div
      style={{
        position: 'relative', width: 210, height: 210, borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, #55646f, var(--wl-steel) 45%, #232c35 80%, #161d24)',
        boxShadow: '0 14px 30px rgba(0,0,0,.6), 0 4px 8px rgba(0,0,0,.45), inset 0 3px 6px rgba(255,255,255,.12), inset 0 -8px 14px rgba(0,0,0,.5)',
      }}
    >
      {bolts.map((b, i) => (
        <span key={i} className={`wl-screw${i === 3 || i === 7 ? ' wl-screw--rusty' : ''}`}
              style={{ left: b.left, top: b.top, transform: `rotate(${b.rot}deg)` }} />
      ))}
      {/* recessed inner plate */}
      <div style={{
        position: 'absolute', inset: 28, borderRadius: '50%',
        border: '3px solid var(--wl-line)',
        background: 'radial-gradient(circle at 40% 32%, #46555f, var(--wl-steel-face-lo) 70%, var(--wl-well-2))',
        boxShadow: 'inset 0 4px 8px rgba(0,0,0,.5), inset 0 -2px 4px rgba(255,255,255,.06)',
      }} />
      {/* locking-wheel spokes */}
      {[0, 60, 120].map((deg) => (
        <div key={deg} style={{
          position: 'absolute', left: '50%', top: '50%', width: 8, height: 112, margin: '-56px 0 0 -4px',
          borderRadius: 4, background: 'linear-gradient(180deg,#5a6a76,#38454f)',
          boxShadow: '0 2px 4px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.2)',
          transform: `rotate(${deg}deg)`,
        }} />
      ))}
      {/* wheel rim */}
      <div style={{
        position: 'absolute', left: '50%', top: '50%', width: 118, height: 118, margin: '-59px 0 0 -59px', borderRadius: '50%',
        background: 'radial-gradient(circle, transparent 43px, #4a5a66 44px, #2b3742 57px, transparent 58px)',
        filter: 'drop-shadow(0 3px 4px rgba(0,0,0,.5))',
      }} />
      {/* hub */}
      <div style={{
        position: 'absolute', left: '50%', top: '50%', width: 34, height: 34, margin: '-17px 0 0 -17px', borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, #6a7a86, #333e48 70%, var(--wl-well-2))',
        boxShadow: '0 2px 4px rgba(0,0,0,.6), inset 0 1px 1px rgba(255,255,255,.25)',
      }} />
    </div>
  )
}

export default function Approvals() {
  const [pending, setPending] = useState<Approval[]>([])
  const setPendingApprovalCount = useStore((s) => s.setPendingApprovalCount)
  const bump = useStore((s) => s.approvalBump)

  const refresh = useCallback(() => {
    get<Approval[]>('/api/approvals?status=pending').then((list) => {
      setPending(list)
      setPendingApprovalCount(list.length)
    })
  }, [setPendingApprovalCount])

  useEffect(() => {
    refresh()
  }, [refresh, bump])

  return (
    <div className="min-h-full p-4 md:p-6">
      <div className="wl-equip wl-rust-bl" style={{ position: 'relative', maxWidth: 780, margin: '0 auto' }}>
        <span className="wl-screw wl-screw--bl" />
        <span className="wl-screw wl-screw--rusty wl-screw--br" />
        <div className="wl-chevron" style={{ borderRadius: '11px 11px 0 0' }} />

        <div style={{ padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`wl-led ${pending.length > 0 ? 'wl-led--red wl-led--blink' : 'wl-led--green'}`} />
            <span className="wl-sectionlabel">Security Clearance Required</span>
            <span className="wl-mono" style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--wl-dim)' }}>
              {pending.length > 0 ? `${pending.length} CONTAINMENT ORDER${pending.length === 1 ? '' : 'S'} PENDING` : 'ALL CLEAR'}
            </span>
          </div>

          {pending.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '30px 0 24px' }}>
              <VaultDoor />
              <div className="wl-lcd" style={{ fontSize: 11 }}>THE VAULT DOOR IS SEALED</div>
              <div className="wl-mono" style={{ fontSize: 10, color: 'var(--wl-faint)' }}>nothing awaits clearance, overseer</div>
            </div>
          ) : (
            pending.map((a) => <ApprovalCard key={a.id} approval={a} onResolved={refresh} />)
          )}
        </div>
      </div>
    </div>
  )
}
