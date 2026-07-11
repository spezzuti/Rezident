import { useCallback, useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { get, post } from '../lib/api'
import { useIsMobile } from '../lib/mobile'

// Desktop/web management surface (master token). Mint a pairing code, render it as
// a QR the phone's PairDevice screen scans, and manage the paired-device registry.
// The QR encodes the EXACT JSON the phone parses: {code, url}.

const PHOS_YELLOW = '#e8c14a'
const PHOS_RED = '#dd8471'
const PHOS_GREEN = '#8fd18f'

interface Device {
  id: string
  label: string
  scopes: string[] | string | null
  fcm_token: string | null
  created_at: string
  last_seen: string | null
  expires_at: string | null
  revoked: number | boolean
}

interface PairStart {
  code: string
  base_url: string
  expires_at: string
}

// The QR payload the PairDevice screen parses. Kept in one place so both ends agree.
function qrPayload(code: string, url: string): string {
  return JSON.stringify({ code, url })
}

function fmtAgo(iso: string | null): string {
  if (!iso) return 'never'
  const then = Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)
  if (Number.isNaN(then)) return iso
  const d = Date.now() - then
  const mins = Math.floor(d / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function Countdown({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)))
  useEffect(() => {
    const t = setInterval(() => {
      const s = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
      setLeft(s)
      if (s <= 0) onExpire()
    }, 1000)
    return () => clearInterval(t)
  }, [expiresAt, onExpire])
  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')
  return (
    <span style={{ color: left <= 30 ? PHOS_RED : PHOS_YELLOW }}>
      {left > 0 ? `EXPIRES IN ${mm}:${ss}` : 'CODE EXPIRED'}
    </span>
  )
}

export default function Devices() {
  const mobile = useIsMobile()
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [listError, setListError] = useState('')
  const [pair, setPair] = useState<PairStart | null>(null)
  const [pairError, setPairError] = useState('')
  const [starting, setStarting] = useState(false)
  const [expired, setExpired] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setDevices(await get<Device[]>('/api/devices'))
      setListError('')
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'failed to load devices')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function startPairing() {
    setStarting(true)
    setPairError('')
    setExpired(false)
    try {
      // No base_url override: the backend advertises its own reachable bind. The
      // operator can still edit the URL on the phone if they front it with MagicDNS.
      const res = await post<PairStart>('/api/pair/start', {})
      setPair(res)
    } catch (e) {
      setPairError(e instanceof Error ? e.message : 'failed to start pairing')
    } finally {
      setStarting(false)
    }
  }

  async function revoke(id: string) {
    setRevoking(id)
    try {
      await post(`/api/devices/${id}/revoke`, {})
      await load()
    } catch {
      /* surfaced on next load; keep the row */
    } finally {
      setRevoking(null)
    }
  }

  const payload = pair ? qrPayload(pair.code, pair.base_url) : ''

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ============ PAIR A PHONE ============ */}
      <div className="wl-equip wl-rust-bl" style={{ overflow: 'hidden' }}>
        <div className="wl-chevron" style={{ borderRadius: '11px 11px 0 0' }} />
        <span className="wl-screw" style={{ top: 18, left: 9 }} />
        <span className="wl-screw wl-screw--rusty" style={{ top: 18, right: 9 }} />
        <div style={{ padding: '18px 20px 20px' }}>
          <div className="wl-engraved" style={{ fontSize: 14, marginBottom: 4 }}>PAIR A HANDSET</div>
          <div className="wl-mono" style={{ fontSize: 10.5, color: '#8fa0b0', lineHeight: 1.6, marginBottom: 14 }}>
            Mint a single-use pairing code, then scan the QR from the Rezident app on your phone.
            Codes are short-lived — pair promptly.
          </div>

          {!pair && (
            <div className="wl-btn-housing" style={{ display: 'inline-block' }}>
              <button className="wl-btn" style={{ padding: '10px 18px' }} disabled={starting} onClick={startPairing}>
                {starting ? 'MINTING…' : '▣ PAIR A PHONE'}
              </button>
            </div>
          )}
          {pairError && (
            <div className="wl-mono mt-2" style={{ fontSize: 11, color: PHOS_RED }}>&gt; {pairError.toUpperCase()}</div>
          )}

          {pair && (
            <div style={{ display: 'flex', flexDirection: mobile ? 'column' : 'row', gap: 20, alignItems: mobile ? 'stretch' : 'flex-start' }}>
              {/* QR */}
              <div
                style={{
                  background: '#e9e4d4',
                  padding: 12,
                  borderRadius: 8,
                  border: '2px solid #10151a',
                  boxShadow: 'inset 0 0 0 2px rgba(0,0,0,.15), 0 2px 6px rgba(0,0,0,.5)',
                  alignSelf: mobile ? 'center' : 'flex-start',
                  opacity: expired ? 0.35 : 1,
                  filter: expired ? 'grayscale(1)' : 'none',
                }}
              >
                <QRCodeSVG value={payload} size={188} level="M" bgColor="#e9e4d4" fgColor="#161b12" />
              </div>

              {/* code + url + countdown */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div className="wl-microlabel">PAIRING CODE</div>
                  <div className="wl-mono" style={{ fontSize: 16, color: PHOS_GREEN, wordBreak: 'break-all', letterSpacing: 1 }}>{pair.code}</div>
                </div>
                <div>
                  <div className="wl-microlabel">SERVER URL</div>
                  <div className="wl-mono" style={{ fontSize: 12, color: '#dfd8c6', wordBreak: 'break-all' }}>{pair.base_url}</div>
                </div>
                <div className="wl-mono" style={{ fontSize: 11 }}>
                  &gt; <Countdown expiresAt={pair.expires_at} onExpire={() => setExpired(true)} />
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                  <div className="wl-btn-housing" style={{ display: 'inline-block' }}>
                    <button className="wl-btn" style={{ padding: '8px 14px' }} disabled={starting} onClick={startPairing}>
                      {expired ? '↻ NEW CODE' : '↻ REGENERATE'}
                    </button>
                  </div>
                  <button
                    className="wl-btn wl-btn--steel"
                    style={{ padding: '8px 14px' }}
                    onClick={() => { setPair(null); setExpired(false) }}
                  >
                    DONE
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ============ PAIRED DEVICES ============ */}
      <div className="wl-equip wl-rust-bl" style={{ overflow: 'hidden' }}>
        <span className="wl-screw" style={{ top: 18, left: 9 }} />
        <span className="wl-screw wl-screw--rusty" style={{ top: 18, right: 9 }} />
        <div style={{ padding: '18px 20px 20px' }}>
          <div className="wl-engraved" style={{ fontSize: 14, marginBottom: 12 }}>PAIRED HANDSETS</div>

          {listError && <div className="wl-mono" style={{ fontSize: 11, color: PHOS_RED }}>&gt; {listError.toUpperCase()}</div>}
          {devices === null && !listError && (
            <div className="wl-mono" style={{ fontSize: 11, color: '#8fa0b0' }}>&gt; LOADING REGISTRY…</div>
          )}
          {devices && devices.length === 0 && (
            <div className="wl-mono" style={{ fontSize: 11, color: '#8fa0b0' }}>&gt; NO DEVICES PAIRED YET</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {devices?.map((d) => {
              const revoked = !!d.revoked
              return (
                <div
                  key={d.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 12px', borderRadius: 8,
                    background: 'linear-gradient(180deg,#1c242c,#141a20)',
                    border: '1px solid #10151a',
                    opacity: revoked ? 0.5 : 1,
                  }}
                >
                  <span className={`wl-led wl-led--${revoked ? 'red' : 'green'}`} style={{ flex: 'none' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: '#dfd8c6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.label || 'Unnamed device'}
                      {revoked && <span className="wl-mono" style={{ fontSize: 9, color: PHOS_RED, marginLeft: 8 }}>REVOKED</span>}
                      {!revoked && d.fcm_token && <span className="wl-mono" style={{ fontSize: 9, color: PHOS_YELLOW, marginLeft: 8 }}>PUSH</span>}
                    </div>
                    <div className="wl-mono" style={{ fontSize: 9.5, color: '#8fa0b0' }}>
                      seen {fmtAgo(d.last_seen)} · paired {fmtAgo(d.created_at)}
                    </div>
                  </div>
                  {!revoked && (
                    <button
                      className="wl-btn wl-btn--steel"
                      style={{ padding: '6px 12px', fontSize: 10, flex: 'none', color: PHOS_RED }}
                      disabled={revoking === d.id}
                      onClick={() => revoke(d.id)}
                    >
                      {revoking === d.id ? 'REVOKING…' : 'REVOKE'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
