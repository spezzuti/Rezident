import { useCallback, useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { del, get, post } from '../lib/api'
import { useIsMobile } from '../lib/mobile'
import { sfx } from '../lib/sound'

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

// Remote Access state (Tailscale) — this pairing card is the ONE place remote access is
// driven: connect, status, and disconnect all live here. state ∈ Stopped | Starting |
// NeedsLogin | Running | Error — any unlisted value is treated as a transient connect.
interface TailscaleStatus {
  enabled: boolean
  hostname: string
  running: boolean
  alive: boolean
  state: string
  auth_url: string
  ip: string
  dns: string
  error: string
  tailnet_url: string
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
  const [removing, setRemoving] = useState<string | null>(null)
  // Remote Access (Tailscale) — queried on mount, driven to Running by connectRemote.
  const [ts, setTs] = useState<TailscaleStatus | null>(null)
  const [tsBusy, setTsBusy] = useState(false)
  const [tsMsg, setTsMsg] = useState('')

  useEffect(() => { get<TailscaleStatus>('/api/system/tailscale').then(setTs).catch(() => {}) }, [])

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

  // CONNECT remote access: join the tailnet, then poll the backend state (~2.5s cadence,
  // cap ~3 min) through Starting → NeedsLogin → Running until it settles Running or Error.
  // Mirrors System.tsx's TailscalePanel.connect(). We only ever connect from here — the
  // approve-in-browser step surfaces as NeedsLogin below, and this same loop keeps polling
  // across it, so the section flips itself green once the node is authorized.
  async function connectRemote() {
    if (tsBusy) return
    setTsBusy(true); setTsMsg('')
    try {
      let st = await post<TailscaleStatus>('/api/system/tailscale', { enable: true })
      setTs(st)
      const t0 = Date.now()
      while (st.state !== 'Running' && st.state !== 'Error' && Date.now() - t0 < 3 * 60_000) {
        await new Promise((r) => setTimeout(r, 2500))
        st = await get<TailscaleStatus>('/api/system/tailscale')
        setTs(st)
      }
      if (st.state === 'Running') sfx.confirm()
      else if (st.state === 'Error') { setTsMsg(st.error || 'the tailnet join failed'); sfx.deny() }
      else setTsMsg('still connecting — this can take a moment; reopen the page to check')
    } catch (e) {
      setTsMsg(e instanceof Error ? e.message : 'connect request failed'); sfx.deny()
    } finally {
      setTsBusy(false)
    }
  }

  // DISCONNECT remote access: leave the tailnet. Unlike connect there's no poll loop —
  // the backend returns Stopped immediately, so one round-trip settles it.
  async function disconnectRemote() {
    if (tsBusy) return
    setTsBusy(true); setTsMsg('')
    try {
      const st = await post<TailscaleStatus>('/api/system/tailscale', { enable: false })
      setTs(st); sfx.confirm()
    } catch (e) {
      setTsMsg(e instanceof Error ? e.message : 'disconnect request failed'); sfx.deny()
    } finally {
      setTsBusy(false)
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

  async function remove(id: string) {
    setRemoving(id)
    try {
      await del(`/api/devices/${id}`)
      await load()
    } catch {
      /* surfaced on next load; keep the row */
    } finally {
      setRemoving(null)
    }
  }

  const payload = pair ? qrPayload(pair.code, pair.base_url) : ''

  // ---- Remote Access derived state (mirrors TailscalePanel) ----
  const tsState = ts?.state ?? ''
  const tsRunning = !!ts?.running || tsState === 'Running'
  const tsError = tsState === 'Error'
  const tsNeedsLogin = tsState === 'NeedsLogin'
  // enabled + not Running/Error/Stopped/NeedsLogin = a transient connecting state
  const tsConnecting = !tsRunning && !tsError && !tsNeedsLogin && !!ts?.enabled && tsState !== 'Stopped'
  const tsAuthUrl = ts?.auth_url ?? ''
  const tsAddr = ts?.dns || ts?.ip || ''
  const openTsAuth = () => tsAuthUrl && window.open(tsAuthUrl, '_blank', 'noopener')

  let tsLed = 'wl-led--off'
  if (tsRunning) tsLed = 'wl-led--green'
  else if (tsError) tsLed = 'wl-led--red'
  else if (tsNeedsLogin || tsConnecting) tsLed = 'wl-led--yellow'

  const tsHeadline =
    ts === null ? 'CHECKING REMOTE ACCESS…'
    : tsRunning ? `ON THE TAILNET${tsAddr ? ` · ${tsAddr}` : ''}`
    : tsError ? 'CONNECTION ERROR'
    : tsNeedsLogin ? 'WAITING FOR AUTHORIZATION'
    : tsConnecting ? 'CONNECTING…'
    : 'OFF — THIS NETWORK ONLY'
  const tsHeadColor =
    tsRunning ? PHOS_GREEN
    : tsError ? PHOS_RED
    : (tsNeedsLogin || tsConnecting) ? PHOS_YELLOW
    : '#dfd8c6'

  // A minted code carries the bind the backend advertised WHEN it was minted. If we're on
  // the tailnet now but the code's URL doesn't reference the tailnet dns/ip, it was minted
  // LAN-only — nudge a regenerate so the QR pairs over Tailscale.
  const codeOverTailnet = !!pair && (
    (!!ts?.dns && pair.base_url.includes(ts.dns)) || (!!ts?.ip && pair.base_url.includes(ts.ip))
  )
  const showTailnetNudge = tsRunning && !!pair && !expired && !codeOverTailnet

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

          {/* ---- STEP 0 · REMOTE ACCESS (Tailscale) — folded into the top of pairing ---- */}
          <div
            style={{
              marginBottom: 16,
              padding: '11px 13px',
              borderRadius: 8,
              background: 'linear-gradient(180deg,#1c242c,#141a20)',
              border: '1px solid #10151a',
              ...(tsRunning ? { boxShadow: 'inset 0 0 0 1px rgba(143,209,143,.28)' } : {}),
            }}
          >
            {/* status line */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <span className={`wl-led ${tsLed}`} style={{ flex: 'none' }} />
              <span
                className="wl-mono"
                style={{ fontSize: 12, color: tsHeadColor, wordBreak: 'break-all', textShadow: tsRunning ? '0 0 6px rgba(143,209,143,.5)' : 'none' }}
              >
                {tsHeadline}
              </span>
              <span className="wl-microlabel" style={{ marginLeft: 'auto', flex: 'none' }}>REMOTE ACCESS</span>
            </div>

            {/* RUNNING — on the tailnet: reassure + the one-time phone guide */}
            {tsRunning && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0', lineHeight: 1.55 }}>
                  This handset pairs over your private network — works anywhere.
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid rgba(255,255,255,.07)', paddingTop: 8 }}>
                  <div className="wl-microlabel">ON YOUR PHONE — ONE TIME</div>
                  <div className="wl-mono" style={{ fontSize: 10.5, color: '#dfd8c6', lineHeight: 1.5, display: 'flex', gap: 7 }}>
                    <span style={{ color: PHOS_GREEN, flex: 'none' }}>①</span>
                    <span>Install <b style={{ color: '#fff' }}>Tailscale</b> on your phone and sign into your tailnet <span style={{ color: '#8fa0b0' }}>(once)</span>.</span>
                  </div>
                  <div className="wl-mono" style={{ fontSize: 10.5, color: '#dfd8c6', lineHeight: 1.5, display: 'flex', gap: 7 }}>
                    <span style={{ color: PHOS_GREEN, flex: 'none' }}>②</span>
                    <span>Scan the QR below in the <b style={{ color: '#fff' }}>Rezident</b> app.</span>
                  </div>
                </div>
                {/* leaving the tailnet is rare — keep it an understated text link, not a button */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="wl-mono"
                    style={{ fontSize: 9.5, background: 'none', border: 'none', padding: 0, color: '#6f7f8c', cursor: 'pointer', ...(tsBusy ? { opacity: 0.5, pointerEvents: 'none' } : {}) }}
                    disabled={tsBusy}
                    onClick={disconnectRemote}
                  >
                    {tsBusy ? '◦ disconnecting…' : '◦ disconnect remote access'}
                  </button>
                  {tsMsg && <span className="wl-mono" style={{ fontSize: 9.5, color: PHOS_YELLOW }}>{tsMsg}</span>}
                </div>
              </div>
            )}

            {/* NEEDSLOGIN — approve the node in the browser once; the poll loop keeps running */}
            {tsNeedsLogin && (
              tsAuthUrl ? (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                  <button
                    type="button"
                    className="wl-btn wl-btn--steel"
                    style={{ padding: '7px 14px', boxShadow: 'inset 0 0 0 1px var(--wl-yellow)', color: PHOS_YELLOW }}
                    onClick={openTsAuth}
                  >
                    AUTHORIZE THIS DEVICE ▸
                  </button>
                  <span className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0', lineHeight: 1.5 }}>
                    Waiting for you to approve this device in Tailscale… a browser tab should have opened.
                  </span>
                  <button
                    type="button"
                    className="wl-mono"
                    style={{ fontSize: 9.5, background: 'none', border: '1px solid rgba(255,255,255,.14)', color: '#dfd8c6', cursor: 'pointer', padding: '4px 10px' }}
                    onClick={openTsAuth}
                  >
                    no tab appeared? open the approval page ↗
                  </button>
                </div>
              ) : (
                <span className="wl-mono" style={{ display: 'block', marginTop: 8, fontSize: 10, color: '#8fa0b0' }}>
                  Contacting Tailscale…
                </span>
              )
            )}

            {/* CONNECTING (Starting / transient) — nothing to click, just reassure */}
            {tsConnecting && (
              <span className="wl-mono" style={{ display: 'block', marginTop: 8, fontSize: 10, color: '#8fa0b0', lineHeight: 1.5 }}>
                Contacting Tailscale… the approval link appears in a few seconds.
              </span>
            )}

            {/* ERROR — reason + retry (never a dead-end) */}
            {tsError && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                {ts?.error && (
                  <span className="wl-mono" style={{ fontSize: 10, color: PHOS_RED, lineHeight: 1.5 }}>&gt; {ts.error}</span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="wl-btn wl-btn--steel"
                    style={{ padding: '7px 14px', ...(tsBusy ? { opacity: 0.5, pointerEvents: 'none' } : {}) }}
                    disabled={tsBusy}
                    onClick={connectRemote}
                  >
                    {tsBusy ? 'WORKING…' : '↻ RETRY'}
                  </button>
                  {tsMsg && <span className="wl-mono" style={{ fontSize: 10, color: PHOS_YELLOW }}>{tsMsg}</span>}
                </div>
              </div>
            )}

            {/* OFF / STOPPED — the pitch + CONNECT (LAN-only pairing still works below) */}
            {!tsRunning && !tsError && !tsNeedsLogin && !tsConnecting && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="wl-mono" style={{ fontSize: 10, color: '#8fa0b0', lineHeight: 1.55 }}>
                  Pair for access from anywhere over your private Tailscale network — no VPS, no public exposure.
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="wl-btn wl-btn--steel"
                    style={{ padding: '7px 14px', ...((tsBusy || ts === null) ? { opacity: 0.5, pointerEvents: 'none' } : {}) }}
                    disabled={tsBusy || ts === null}
                    onClick={connectRemote}
                  >
                    {tsBusy ? 'CONNECTING…' : '▸ CONNECT REMOTE ACCESS'}
                  </button>
                  {tsMsg && <span className="wl-mono" style={{ fontSize: 10, color: PHOS_YELLOW }}>{tsMsg}</span>}
                </div>
                <span className="wl-mono" style={{ fontSize: 9.5, color: '#6f7f8c', lineHeight: 1.5 }}>
                  …or just pair on your local Wi-Fi (both devices on the same network).
                </span>
              </div>
            )}
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
                <div style={{ display: 'flex', gap: 10, marginTop: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div className="wl-btn-housing" style={{ display: 'inline-block' }}>
                    <button className="wl-btn" style={{ padding: '8px 14px' }} disabled={starting} onClick={startPairing}>
                      {expired ? '↻ NEW CODE' : '↻ REGENERATE'}
                    </button>
                  </div>
                  {showTailnetNudge && (
                    <span className="wl-mono" style={{ fontSize: 10, color: PHOS_YELLOW, lineHeight: 1.35 }} title="this code was minted before you joined the tailnet — its URL is LAN-only">
                      ▲ regenerate to pair over Tailscale
                    </span>
                  )}
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
                  {revoked && (
                    <button
                      className="wl-btn wl-btn--steel"
                      style={{ padding: '6px 12px', fontSize: 10, flex: 'none', color: PHOS_RED }}
                      disabled={removing === d.id}
                      onClick={() => remove(d.id)}
                    >
                      {removing === d.id ? 'REMOVING…' : 'REMOVE'}
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
