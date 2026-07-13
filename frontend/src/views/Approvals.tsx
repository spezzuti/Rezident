import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { get, post } from '../lib/api'
import { lockLabel, useMasterGuard } from '../lib/master'
import { useIsMobile } from '../lib/mobile'
import { sfx } from '../lib/sound'
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
  const mobile = useIsMobile()
  const editable = editableText(approval)
  const [edited, setEdited] = useState(editable?.value ?? '')
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showOpts, setShowOpts] = useState(false)
  const { locked, guard } = useMasterGuard() // only create_rule (Standing Order) is master-only; approve/deny stay open

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
      if (action === 'approve') sfx.confirm()
      else sfx.deny()
      onResolved()
    } catch (e: any) {
      setError(e.message ?? 'failed')
      setBusy(false)
    }
  }

  const wasEdited = !!editable && edited !== editable.value

  // On mobile the two vault buttons are the star of the show: full-width,
  // stacked, thumb-sized. On desktop they keep the inline housing row.
  const bigBtn = mobile ? { display: 'block', width: '100%', textAlign: 'center' as const, fontSize: 14, padding: '15px 16px' } : null
  const approveBtn = (
    <div className="wl-btn-housing" style={mobile ? { display: 'block', padding: 6, flex: 1 } : undefined}>
      <button
        type="button"
        className="wl-btn"
        style={{ ...bigBtn, ...(busy ? { opacity: 0.5, pointerEvents: 'none' } : null) }}
        disabled={busy}
        onClick={() => resolve('approve')}
      >
        OPEN VAULT{wasEdited ? ' (EDITED)' : ''}
      </button>
    </div>
  )
  const denyBtn = (
    <div className="wl-btn-housing" style={mobile ? { display: 'block', padding: 6, flex: 1 } : undefined}>
      <button
        type="button"
        className="wl-btn wl-btn--steel"
        style={{ color: 'var(--wl-red-hi)', ...bigBtn, ...(busy ? { opacity: 0.5, pointerEvents: 'none' } : null) }}
        disabled={busy}
        onClick={() => resolve('deny')}
      >
        DENY
      </button>
    </div>
  )
  const reasonInput = (
    <input
      className="wl-input"
      style={{ width: '100%' }}
      placeholder="reason (sent to the agent on deny)"
      value={reason}
      onChange={(e) => setReason(e.target.value)}
    />
  )
  const standingOrder = editable && (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, opacity: locked ? 0.55 : 1 }}>
      <Toggle on={alwaysAllow} onClick={guard(() => setAlwaysAllow(!alwaysAllow))} title="always allow this" />
      <span className="wl-microlabel" style={{ lineHeight: 1.5 }}>{lockLabel(locked, 'Standing')}<br />Order</span>
    </div>
  )

  return (
    <div className="wl-tile" style={{ padding: mobile ? '12px 13px' : '13px 14px', display: 'flex', flexDirection: 'column', gap: mobile ? 12 : 10 }}>
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

      {mobile ? (
        <>
          {/* the decision, front and centre */}
          {approveBtn}
          {denyBtn}
          {/* secondary rules-CRUD surface, collapsed out of the way */}
          <button
            type="button"
            className="wl-mono"
            onClick={() => setShowOpts((s) => !s)}
            style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: '2px 0', color: 'var(--wl-dim)', fontSize: 10, letterSpacing: 1.5, cursor: 'pointer' }}
          >
            {showOpts ? '▾ OPTIONS' : '▸ OPTIONS'}
          </button>
          {showOpts && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {reasonInput}
              {standingOrder}
            </div>
          )}
        </>
      ) : (
        <>
          {reasonInput}
          {/* physical controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', paddingTop: 2 }}>
            {approveBtn}
            {denyBtn}
            {standingOrder}
          </div>
        </>
      )}
      {error && <div className="wl-mono" style={{ fontSize: 10, color: 'var(--wl-red-hi)' }}>⚠ {error}</div>}
    </div>
  )
}

/* closed steel vault door — pure CSS */
/** The classic cog-shaped vault door: gear teeth around the rim, eight
 * riveted spokes over recessed segments, yellow "76" hub. */
function VaultDoor() {
  const SIZE = 250
  const C = SIZE / 2
  const teeth = Array.from({ length: 12 }, (_, i) => i * 30)
  const spokes = Array.from({ length: 8 }, (_, i) => i * 45)
  // rivets along each spoke (two per spoke, near rim and mid)
  const rivets = spokes.flatMap((deg) => [92, 62].map((r) => {
    const a = ((deg - 90) * Math.PI) / 180
    return { left: C + r * Math.cos(a) - 3, top: C + r * Math.sin(a) - 3 }
  }))
  const hubBolts = Array.from({ length: 8 }, (_, i) => {
    const a = ((i * 45 - 90) * Math.PI) / 180
    return { left: C + 33 * Math.cos(a) - 2.5, top: C + 33 * Math.sin(a) - 2.5 }
  })
  return (
    <div style={{ position: 'relative', width: SIZE, height: SIZE, filter: 'drop-shadow(0 16px 26px rgba(0,0,0,.55))' }}>
      {/* gear teeth */}
      {teeth.map((deg) => (
        <div key={deg} style={{
          position: 'absolute', left: '50%', top: '50%', width: 30, height: SIZE + 22,
          margin: `-${(SIZE + 22) / 2}px 0 0 -15px`, transform: `rotate(${deg}deg)`, pointerEvents: 'none',
        }}>
          <div style={{
            position: 'absolute', top: 0, left: 0, width: 30, height: 20, borderRadius: 3,
            background: 'linear-gradient(180deg, #5a6a76, #38454f)',
            border: '1px solid var(--wl-line)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,.2), inset 0 -2px 3px rgba(0,0,0,.4)',
          }} />
        </div>
      ))}
      {/* main disc */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, #5d6d79, var(--wl-steel) 45%, #232c35 82%, #161d24)',
        border: '2px solid var(--wl-line)',
        boxShadow: 'inset 0 3px 6px rgba(255,255,255,.14), inset 0 -10px 16px rgba(0,0,0,.5)',
      }} />
      {/* recessed segment field between spokes */}
      <div style={{
        position: 'absolute', inset: 22, borderRadius: '50%',
        background: 'radial-gradient(circle at 42% 34%, #39464f, var(--wl-steel-face-lo) 55%, var(--wl-well-2) 92%)',
        boxShadow: 'inset 0 5px 10px rgba(0,0,0,.55), inset 0 -2px 4px rgba(255,255,255,.05)',
      }} />
      {/* eight spokes */}
      {spokes.map((deg) => (
        <div key={deg} style={{
          position: 'absolute', left: '50%', top: '50%', width: 22, height: SIZE - 34,
          margin: `-${(SIZE - 34) / 2}px 0 0 -11px`,
          transform: `rotate(${deg}deg)`,
          background: 'linear-gradient(90deg, #333f49, #55646f 30%, #5d6d79 50%, #55646f 70%, #333f49)',
          borderRadius: 6,
          border: '1px solid var(--wl-line)',
          boxShadow: '0 0 6px rgba(0,0,0,.45), inset 0 0 3px rgba(255,255,255,.12)',
        }} />
      ))}
      {/* spoke rivets */}
      {rivets.map((r, i) => (
        <span key={i} className={`wl-screw${i % 5 === 3 ? ' wl-screw--rusty' : ''}`}
              style={{ left: r.left, top: r.top, width: 6, height: 6, transform: `rotate(${i * 40}deg)` }} />
      ))}
      {/* hub ring */}
      <div style={{
        position: 'absolute', left: '50%', top: '50%', width: 92, height: 92, margin: '-46px 0 0 -46px', borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, #5d6d79, #333e48 75%)',
        border: '2px solid var(--wl-line)',
        boxShadow: '0 3px 6px rgba(0,0,0,.55), inset 0 1px 1px rgba(255,255,255,.2)',
      }} />
      {hubBolts.map((b, i) => (
        <span key={i} className="wl-screw" style={{ left: b.left, top: b.top, width: 5, height: 5, transform: `rotate(${i * 55}deg)` }} />
      ))}
      {/* yellow enamel center — vault number */}
      <div style={{
        position: 'absolute', left: '50%', top: '50%', width: 58, height: 58, margin: '-29px 0 0 -29px', borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, #f2cd52, #d9a81e 55%, #b98a1e)',
        border: '2px solid var(--wl-line)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'Chakra Petch', sans-serif", fontWeight: 700, fontSize: 21, letterSpacing: 1, color: '#232a20',
        textShadow: '0 1px 0 rgba(255,255,255,.3)',
        boxShadow: '0 2px 6px rgba(0,0,0,.5), 0 0 18px rgba(232,193,74,.25), inset 0 2px 3px rgba(255,255,255,.4), inset 0 -3px 5px rgba(120,80,0,.4)',
      }}>
        76
      </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
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
