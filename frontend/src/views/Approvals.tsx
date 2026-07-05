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

  return (
    <div className="card-awaiting rounded-lg border border-edge bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-warn/15 px-2 py-0.5 font-mono text-xs font-bold text-warn">
          {approval.tool_name}
        </span>
        <Link to={`/tasks/${approval.task_id}`} className="truncate text-sm text-ink hover:text-accent">
          {approval.task_title ?? approval.task_id.slice(0, 8)}
        </Link>
        <span className="ml-auto font-mono text-[11px] text-ink-dim">
          {new Date(approval.created_at + (approval.created_at.endsWith('Z') ? '' : 'Z')).toLocaleTimeString()}
        </span>
      </div>

      {editable ? (
        <textarea
          className="mt-3 w-full rounded-md border border-edge bg-bg px-3 py-2 font-mono text-sm text-ink outline-none focus:border-warn"
          rows={Math.min(6, Math.max(2, edited.split('\n').length))}
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
        />
      ) : (
        <pre className="mt-3 max-h-48 overflow-auto rounded-md border border-edge bg-bg px-3 py-2 font-mono text-xs text-ink-dim">
          {JSON.stringify(approval.tool_input, null, 2)}
        </pre>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          className="rounded-md bg-ok/90 px-5 py-2 text-sm font-bold text-black hover:bg-ok disabled:opacity-50"
          disabled={busy}
          onClick={() => resolve('approve')}
        >
          Approve{editable && edited !== editable.value ? ' (edited)' : ''}
        </button>
        <button
          className="rounded-md border border-err/60 px-5 py-2 text-sm font-bold text-err hover:bg-err/10 disabled:opacity-50"
          disabled={busy}
          onClick={() => resolve('deny')}
        >
          Deny
        </button>
        {editable && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-dim">
            <input type="checkbox" checked={alwaysAllow} onChange={(e) => setAlwaysAllow(e.target.checked)} />
            always allow this
          </label>
        )}
        <input
          className="min-w-32 flex-1 rounded-md border border-edge bg-bg px-2 py-1.5 text-xs outline-none focus:border-accent"
          placeholder="reason (sent to the agent on deny)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error && <div className="mt-2 text-xs text-err">{error}</div>}
    </div>
  )
}

function firstWords(command: string): string {
  const words = command.trim().split(/\s+/)
  return words.slice(0, Math.min(2, words.length)).join(' ')
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
      <h1 className="hud-label !text-xs" style={{ color: '#fbbf24' }}>
        Approvals {pending.length > 0 && <span>({pending.length} pending)</span>}
      </h1>
      <div className="mx-auto mt-4 max-w-2xl space-y-4">
        {pending.length === 0 ? (
          <div className="rounded-lg border border-dashed border-edge p-8 text-center text-sm text-ink-dim">
            Nothing awaiting your sign-off.
          </div>
        ) : (
          pending.map((a) => <ApprovalCard key={a.id} approval={a} onResolved={refresh} />)
        )}
      </div>
    </div>
  )
}
