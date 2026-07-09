import { useState } from 'react'
import { useStore } from '../store'
import type { TickerEntry } from '../store'

const TONE_COLOR: Record<string, string> = {
  ok: 'var(--wl-green)',
  err: 'var(--wl-red-hi)',
  warn: 'var(--wl-yellow)',
  info: 'var(--wl-phos-g)',
}

function toneColor(tone?: string) {
  return TONE_COLOR[tone ?? 'info'] ?? TONE_COLOR.info
}

function hhmmss(ts: string) {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * COMMS FEED — the PIP-OS consumer for store.ticker (stage activity + the
 * `▣ OPERATION COMPLETE` run-completion moments). A slim phosphor strip docked
 * at the bottom of the vault console: collapsed shows the latest line; click to
 * expand the last ~20 newest-first. GRID//OS has its own ticker (CyberShell).
 */
export default function CommsFeed({ mobile }: { mobile?: boolean }) {
  const ticker = useStore((s) => s.ticker)
  const [open, setOpen] = useState(false)
  const latest: TickerEntry | undefined = ticker[0]
  const recent = ticker.slice(0, 20)

  return (
    <div className="wl-comms" style={{ left: mobile ? 0 : 232 }}>
      {open && (
        <div className="wl-comms-panel wl-crt wl-crt--flat">
          <div className="wl-scanlines" />
          <div className="wl-comms-head">
            <span className="wl-mono wl-comms-title">▣ COMMS FEED</span>
            <button
              type="button"
              className="wl-comms-x"
              title="collapse feed"
              onClick={() => setOpen(false)}
            >
              ▾ COLLAPSE
            </button>
          </div>
          <div className="wl-comms-log">
            {recent.length === 0 ? (
              <div className="wl-comms-quiet wl-mono">— feed quiet —</div>
            ) : (
              recent.map((e, i) => (
                <div className="wl-comms-line wl-mono" key={`${e.ts}-${i}`}>
                  <span className="wl-comms-ts">{hhmmss(e.ts)}</span>
                  <span style={{ color: toneColor(e.tone) }}>{e.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div
        className="wl-comms-strip wl-crt wl-crt--flat"
        title={open ? 'collapse feed' : 'expand comms feed'}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="wl-scanlines" />
        <span className="wl-comms-tag wl-mono">COMMS</span>
        {latest ? (
          <span
            key={`${latest.ts}-${latest.text}`}
            className="wl-comms-latest wl-mono wl-comms-in"
            style={{ color: toneColor(latest.tone) }}
          >
            {latest.text}
          </span>
        ) : (
          <span className="wl-comms-latest wl-comms-quiet wl-mono">— feed quiet —</span>
        )}
        <span className="wl-comms-caret">{open ? '▾' : '▴'}</span>
      </div>
    </div>
  )
}
