import { useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { get } from '../lib/api'
import { addConnection, clearAuthFailure } from '../lib/connections'
import { wsClient } from '../lib/ws'

// The phone's pairing gate. Shown ONLY under Capacitor when there is no active
// connection (or a device token was invalidated mid-session). There is no /login
// inside the app — the QR the desktop renders (payload {code, url}) is the sole
// credential path, with manual entry as an always-available fallback so pairing
// works even without a working camera (and so this screen is testable in a browser).
//
// On a successful claim the returned {device_id, token, base_url} becomes the new
// active connection and the console boots. Every failure state (bad code, denied
// camera, unreachable server) stays IN this screen with a retry — no dead ends.

const PHOS_RED = '#dd8471'
const PHOS_YELLOW = '#e8c14a'
const PHOS_GREEN = '#8fd18f'

// A friendly default device label from the platform (editable before claim).
function defaultLabel(): string {
  try {
    const p = Capacitor.getPlatform?.() || 'android'
    return p === 'android' ? 'Android Phone' : p.charAt(0).toUpperCase() + p.slice(1)
  } catch {
    return 'Android Phone'
  }
}

type Phase = 'idle' | 'scanning' | 'claiming'

interface ClaimResp {
  device_id: string
  token: string
  base_url: string
}

// The exact JSON payload the desktop QR encodes and this screen parses.
interface PairPayload {
  code: string
  url: string
}

function parsePayload(raw: string): PairPayload | null {
  try {
    const p = JSON.parse(raw)
    if (p && typeof p.code === 'string' && typeof p.url === 'string' && p.code && p.url) {
      return { code: p.code, url: p.url }
    }
  } catch {
    /* not our QR */
  }
  return null
}

export default function PairDevice({ onPaired }: { onPaired?: () => void } = {}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [label, setLabel] = useState(defaultLabel())
  const [error, setError] = useState('')
  const native = Capacitor.isNativePlatform()

  // --- claim: shared by the scan path and the manual path ---------------------
  async function claim(payloadUrl: string, payloadCode: string) {
    const base = payloadUrl.trim().replace(/\/+$/, '') // tolerate a trailing slash
    const pin = payloadCode.trim()
    if (!base || !pin) {
      setError('> MISSING SERVER URL OR CODE')
      return
    }
    setError('')
    setPhase('claiming')
    try {
      const res = await fetch(`${base}/api/pair/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pin, label: label.trim() || defaultLabel() }),
      })
      if (!res.ok) {
        let detail = 'pairing failed'
        try {
          detail = (await res.json()).detail ?? detail
        } catch {
          /* not json */
        }
        setError(`> ${String(detail).toUpperCase()}`)
        setPhase('idle')
        return
      }
      const claimed = (await res.json()) as ClaimResp
      // Store as the new active connection (addConnection makes it active + clears
      // the auth-failed flag). The base_url is the reachable address the desktop
      // advertised — store it verbatim.
      addConnection({
        id: claimed.device_id,
        label: label.trim() || defaultLabel(),
        baseUrl: claimed.base_url.replace(/\/+$/, ''),
        token: claimed.token,
        kind: 'direct',
      })
      clearAuthFailure()
      // Confirm the freshly-minted token actually authenticates before booting in.
      await get<{ ok: boolean }>('/api/auth/check')
      // Bring the live socket up against the new connection, then hand off.
      wsClient.connect()
      onPaired?.()
    } catch (e) {
      // Network error (server unreachable, wrong URL, CORS) — never a dead end.
      setError(`> CANNOT REACH SERVER — CHECK THE URL${e instanceof Error ? '' : ''}`)
      setPhase('idle')
    }
  }

  // --- QR scan (native only) --------------------------------------------------
  async function scan() {
    setError('')
    if (!native) {
      setError('> CAMERA SCAN IS ANDROID-ONLY — USE MANUAL ENTRY')
      return
    }
    setPhase('scanning')
    try {
      // Dynamic import: the barcode plugin only exists on the device build; code-
      // splitting keeps it out of the initial bundle and off the web path.
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning')
      const perm = await BarcodeScanner.requestPermissions()
      if (perm.camera !== 'granted' && perm.camera !== 'limited') {
        setError('> CAMERA PERMISSION DENIED — USE MANUAL ENTRY BELOW')
        setPhase('idle')
        return
      }
      const { barcodes } = await BarcodeScanner.scan()
      const first = barcodes?.[0]?.rawValue ?? ''
      const payload = parsePayload(first)
      if (!payload) {
        setError('> UNRECOGNISED QR — SCAN THE PAIRING CODE ON THE DESKTOP')
        setPhase('idle')
        return
      }
      setUrl(payload.url)
      setCode(payload.code)
      await claim(payload.url, payload.code)
    } catch (e) {
      // Includes the user cancelling the scanner — fall back to manual, no dead end.
      setError('> SCAN CANCELLED OR UNAVAILABLE — USE MANUAL ENTRY BELOW')
      setPhase('idle')
    }
  }

  const busy = phase !== 'idle'

  return (
    <div className="wl-app flex min-h-screen items-center justify-center p-4">
      <div className="wl-equip wl-rust-bl w-full" style={{ maxWidth: 460, overflow: 'hidden' }}>
        <div className="wl-chevron" style={{ borderRadius: '11px 11px 0 0' }} />
        <span className="wl-screw" style={{ top: 20, left: 7 }} />
        <span className="wl-screw wl-screw--rusty" style={{ top: 20, right: 7, transform: 'rotate(70deg)' }} />
        <span className="wl-screw wl-screw--bl" />
        <span className="wl-screw wl-screw--br" />

        <div style={{ padding: '18px 22px 22px' }}>
          {/* ---- 76 badge + PIP-OS header ---- */}
          <div className="flex items-center gap-3" style={{ padding: '0 2px 14px' }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: 'radial-gradient(circle at 35% 30%, #4a5a6a, #212a33)',
                border: '2px solid #d9ad2e',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: PHOS_YELLOW,
                fontWeight: 700,
                fontSize: 13,
                boxShadow: '0 2px 4px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.15)',
              }}
            >
              76
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#dfd8c6', letterSpacing: 2, textShadow: '0 1px 0 rgba(255,255,255,.1), 0 -1px 1px rgba(0,0,0,.6)' }}>
                PIP-OS
              </div>
              <div style={{ fontSize: 8, color: '#8fa0b0', letterSpacing: 2 }}>
                DEVICE PAIRING
              </div>
            </div>
            <span className="wl-led wl-led--yellow wl-led--blink" style={{ marginLeft: 'auto' }} />
          </div>

          {/* ---- CRT status strip ---- */}
          <div className="wl-monitor-bezel">
            <div className="wl-crt wl-power-on" style={{ minHeight: 96, padding: '12px 14px', fontSize: 11, lineHeight: 1.7 }}>
              <div className="wl-scanlines" />
              <div className="wl-glare" />
              <div className="relative">
                <div>&gt; ROBCO TERMLINK — UNPAIRED HANDSET</div>
                <div>&gt; awaiting overseer pairing code</div>
                <div style={{ color: PHOS_YELLOW, textShadow: '0 0 6px rgba(232,193,74,.35)' }}>
                  {phase === 'scanning'
                    ? '> OPENING CAMERA…'
                    : phase === 'claiming'
                      ? '> CLAIMING PAIRING CODE…'
                      : '> SCAN THE QR ON YOUR DESKTOP — OR ENTER IT BELOW'}
                </div>
                <span className="wl-cursor" />
              </div>
            </div>
          </div>

          {/* ---- primary: scan ---- */}
          <div className="wl-btn-housing mt-4 w-full" style={{ display: 'block' }}>
            <button
              className="wl-btn w-full"
              style={{ padding: '10px 16px' }}
              disabled={busy}
              onClick={scan}
            >
              {phase === 'scanning' ? 'SCANNING…' : '▣ SCAN PAIRING QR'}
            </button>
          </div>

          {/* ---- divider ---- */}
          <div
            className="wl-mono"
            style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 4px', fontSize: 9, color: '#8fa0b0', letterSpacing: 2 }}
          >
            <span style={{ flex: 1, height: 1, background: '#2a343e' }} />
            OR ENTER MANUALLY
            <span style={{ flex: 1, height: 1, background: '#2a343e' }} />
          </div>

          {/* ---- manual entry ---- */}
          <label className="wl-microlabel" style={{ display: 'block', marginTop: 8 }}>SERVER URL</label>
          <input
            className="wl-input mt-1 w-full"
            placeholder="http://desktop.tailnet.ts.net:8734"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />

          <label className="wl-microlabel" style={{ display: 'block', marginTop: 10 }}>PAIRING CODE</label>
          <input
            className="wl-input mt-1 w-full"
            placeholder="paste the code from the desktop"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => e.key === 'Enter' && !busy && claim(url, code)}
          />

          <label className="wl-microlabel" style={{ display: 'block', marginTop: 10 }}>THIS DEVICE</label>
          <input
            className="wl-input mt-1 w-full"
            placeholder="device name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />

          {error && (
            <div className="wl-mono mt-3" style={{ fontSize: 11, color: PHOS_RED, textShadow: '0 0 5px rgba(221,132,113,.4)' }}>
              {error}
            </div>
          )}

          <div className="wl-btn-housing mt-4 w-full" style={{ display: 'block' }}>
            <button
              className="wl-btn w-full"
              style={{ padding: '10px 16px', color: PHOS_GREEN }}
              disabled={busy}
              onClick={() => claim(url, code)}
            >
              {phase === 'claiming' ? 'PAIRING…' : '▸ PAIR THIS DEVICE'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
