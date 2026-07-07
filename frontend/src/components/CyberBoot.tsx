import { useEffect, useRef, useState } from 'react'

/**
 * HACKERS (1995) boot animations — the crew's laptop boot logos, recreated
 * frame-by-frame from the film for the cyber theme. Each is its own boot;
 * Full Montage plays all four hard-cut. Pure SVG + CSS + canvas + synthesized
 * WebAudio (no assets). Click / any key skips.
 */

type Phase = 'crash' | 'acid' | 'nikon' | 'cereal' | 'planet' | 'end'

export type BootVariant = 'crash' | 'acid' | 'nikon' | 'cereal' | 'montage' | 'random'

export const BOOT_VARIANTS: { id: BootVariant; label: string; blurb: string; glyph: string }[] = [
  { id: 'crash', label: 'Crash Override', blurb: 'hazard-yellow eyepatch skull', glyph: '☠' },
  { id: 'acid', label: 'Acid Burn', blurb: 'fire in a flammable diamond', glyph: '🔥' },
  { id: 'nikon', label: 'Lord Nikon', blurb: 'camera aperture → red Nikon', glyph: '◉' },
  { id: 'cereal', label: 'Cereal Killer', blurb: 'dot-storm → eyepatch smiley', glyph: '☺' },
  { id: 'montage', label: 'Full Montage', blurb: 'all four, hard-cut', glyph: '▦' },
  { id: 'random', label: 'Random', blurb: 'a different one every boot', glyph: '⚄' },
]

const SINGLES = ['crash', 'acid', 'nikon', 'cereal'] as const
const CARD_MS: Record<(typeof SINGLES)[number], number> = { crash: 2800, acid: 2600, nikon: 3300, cereal: 3000 }

function buildSequence(variant: BootVariant): { phase: Phase; ms: number }[] {
  if (variant === 'montage') {
    return [
      { phase: 'crash', ms: 2100 },
      { phase: 'acid', ms: 1800 },
      { phase: 'nikon', ms: 2900 },
      { phase: 'cereal', ms: 2200 },
      { phase: 'planet', ms: 1200 },
    ]
  }
  const v = variant === 'random' ? SINGLES[(Math.random() * SINGLES.length) | 0] : variant
  return [{ phase: v, ms: CARD_MS[v] }, { phase: 'planet', ms: 1100 }]
}

export function loadBootVariant(): BootVariant {
  const v = (typeof localStorage !== 'undefined' && localStorage.getItem('agentos_cyberboot')) as BootVariant | null
  return v && BOOT_VARIANTS.some((b) => b.id === v) ? v : 'montage'
}

/* ============ synthesized boot SFX (WebAudio, no assets) ============ */

let _ac: AudioContext | null = null
function ac(): AudioContext | null {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext
    if (!AC) return null
    if (!_ac) _ac = new AC()
    if (_ac.state === 'suspended') _ac.resume().catch(() => {})
    return _ac
  } catch {
    return null
  }
}
function beep(c: AudioContext, f0: number, f1: number, t0: number, dur: number, type: OscillatorType, g: number) {
  const o = c.createOscillator(), gain = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(f0, t0)
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur)
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(g, t0 + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  o.connect(gain).connect(c.destination)
  o.start(t0); o.stop(t0 + dur + 0.03)
}
function noise(c: AudioContext, t0: number, dur: number, g: number, type: BiquadFilterType, f0: number, f1: number) {
  const src = c.createBufferSource()
  const buf = c.createBuffer(1, Math.max(1, (c.sampleRate * dur) | 0), c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  src.buffer = buf
  const filt = c.createBiquadFilter()
  filt.type = type
  filt.frequency.setValueAtTime(f0, t0)
  if (f1 !== f0) filt.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur)
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(g, t0 + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  src.connect(filt).connect(gain).connect(c.destination)
  src.start(t0); src.stop(t0 + dur + 0.03)
}
function playBootSound(phase: Phase) {
  const c = ac()
  if (!c) return
  const t = c.currentTime + 0.02
  switch (phase) {
    case 'crash': // metallic power-on clank + rising alarm sweep
      beep(c, 90, 150, t, 0.5, 'sawtooth', 0.14)
      noise(c, t, 0.09, 0.12, 'bandpass', 1900, 600)
      beep(c, 300, 640, t + 0.13, 0.42, 'square', 0.05)
      break
    case 'acid': // fire whoosh
      noise(c, t, 0.7, 0.17, 'bandpass', 300, 2700)
      beep(c, 130, 60, t, 0.5, 'sine', 0.1)
      break
    case 'nikon': // shutter clicks + lens whir + chime
      noise(c, t, 0.035, 0.22, 'highpass', 3200, 3200)
      noise(c, t + 0.07, 0.035, 0.2, 'highpass', 3200, 3200)
      beep(c, 420, 120, t + 0.11, 0.5, 'sawtooth', 0.06)
      beep(c, 880, 880, t + 0.95, 0.6, 'sine', 0.08)
      beep(c, 1320, 1320, t + 1.0, 0.6, 'sine', 0.045)
      break
    case 'cereal': // bubbly ascending blips + boing
      for (let i = 0; i < 6; i++) beep(c, 300 + i * 130, 300 + i * 130, t + i * 0.1, 0.13, 'sine', 0.07)
      beep(c, 200, 500, t + 0.75, 0.4, 'triangle', 0.1)
      break
    case 'planet': // glitch zap + triumphant rise
      noise(c, t, 0.12, 0.18, 'bandpass', 400, 4200)
      beep(c, 220, 90, t, 0.12, 'square', 0.08)
      beep(c, 660, 990, t + 0.14, 0.5, 'sawtooth', 0.1)
      beep(c, 990, 1480, t + 0.2, 0.5, 'sine', 0.06)
      break
    default:
      break
  }
}

/** variants backed by a real boot-animation video (played full-screen with its own audio) — base path, .webm + .mp4 served */
const VIDEO_SRC: Partial<Record<BootVariant, string>> = {
  crash: '/boots/crash',
  acid: '/boots/acid',
  nikon: '/boots/nikon',
  cereal: '/boots/cereal',
}

/** plays a real boot-animation video: its own soundtrack, fades out + finishes on end or skip */
function VideoBoot({ src, onDone }: { src: string; onDone?: () => void }) {
  const vref = useRef<HTMLVideoElement>(null)
  const [fading, setFading] = useState(false)
  const finished = useRef(false)

  useEffect(() => {
    const v = vref.current
    if (!v) return
    const finish = () => {
      if (finished.current) return
      finished.current = true
      setFading(true)
      window.setTimeout(() => onDone?.(), 240)
    }
    // play with sound if we have user activation; fall back to muted if the browser blocks it
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}) })
    v.addEventListener('ended', finish)
    const guard = window.setTimeout(finish, 9000) // safety net if 'ended' never fires
    let armed = false
    const arm = window.setTimeout(() => { armed = true }, 400) // ignore the click that launched us
    const skip = () => { if (armed) finish() }
    window.addEventListener('keydown', skip)
    window.addEventListener('mousedown', skip)
    return () => {
      v.removeEventListener('ended', finish)
      window.removeEventListener('keydown', skip)
      window.removeEventListener('mousedown', skip)
      clearTimeout(guard); clearTimeout(arm)
    }
  }, [onDone])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 99999, overflow: 'hidden',
        background: '#000', cursor: 'pointer',
        opacity: fading ? 0 : 1, transition: 'opacity .22s linear',
      }}
    >
      <style>{CSS}</style>
      <video ref={vref} className="hb-bootvid" autoPlay playsInline preload="auto">
        <source src={`${src}.webm`} type="video/webm" />
        <source src={`${src}.mp4`} type="video/mp4" />
      </video>
      <div className="hb-crt" />
      <div className="hb-skip">CLICK / ANY KEY TO SKIP</div>
    </div>
  )
}

export default function CyberBoot({ variant = 'montage', onDone }: { variant?: BootVariant; onDone?: () => void }) {
  const videoSrc = VIDEO_SRC[variant]
  if (videoSrc) return <VideoBoot src={videoSrc} onDone={onDone} />
  return <SequencerBoot variant={variant} onDone={onDone} />
}

function SequencerBoot({ variant, onDone }: { variant: BootVariant; onDone?: () => void }) {
  const seq = useRef(buildSequence(variant))
  const [phase, setPhase] = useState<Phase>(seq.current[0].phase)
  const timers = useRef<number[]>([])
  const finished = useRef(false)

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const finish = () => {
      if (finished.current) return
      finished.current = true
      onDone?.()
    }
    if (reduced) {
      setPhase('planet')
      timers.current.push(window.setTimeout(finish, 900))
    } else {
      let t = 0
      for (const step of seq.current) {
        const at = t
        timers.current.push(window.setTimeout(() => setPhase(step.phase), at))
        t += step.ms
      }
      timers.current.push(window.setTimeout(() => setPhase('end'), t))
      timers.current.push(window.setTimeout(finish, t + 260))
    }
    const skip = () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
      setPhase('end')
      window.setTimeout(finish, 220)
    }
    window.addEventListener('keydown', skip)
    window.addEventListener('mousedown', skip)
    return () => {
      timers.current.forEach(clearTimeout)
      window.removeEventListener('keydown', skip)
      window.removeEventListener('mousedown', skip)
    }
  }, [onDone])

  useEffect(() => { playBootSound(phase) }, [phase])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 99999, overflow: 'hidden',
        background: '#000', cursor: 'pointer',
        opacity: phase === 'end' ? 0 : 1, transition: 'opacity .22s linear',
      }}
    >
      <style>{CSS}</style>
      {phase === 'crash' && <CrashOverride />}
      {phase === 'acid' && <AcidBurn />}
      {phase === 'nikon' && <LordNikon />}
      {phase === 'cereal' && <CerealKiller />}
      {phase === 'planet' && <HackThePlanet />}
      <div className="hb-crt" />
      <div className="hb-skip">CLICK / ANY KEY TO SKIP</div>
    </div>
  )
}

/* ============ Card 1 — Crash Override (industrial hazard UI) ============ */

const CR = { bg: '#f2c200', ink: '#000000', blu: '#1f7bff', red: '#d81f2b', wht: '#ffffff' }

/** diamond (rotated-square) path centred at (cx,cy) with half-extents hx,hy */
function crDia(cx: number, cy: number, hx: number, hy: number) {
  return `M${cx} ${cy - hy}L${cx + hx} ${cy}L${cx} ${cy + hy}L${cx - hx} ${cy}Z`
}

/** miniature white stencil skull centred at (cx,cy); eye/teeth voids punched in `hole` colour */
function MiniSkull({ cx, cy, s, hole }: { cx: number; cy: number; s: number; hole: string }) {
  return (
    <g transform={`translate(${cx} ${cy}) scale(${s})`}>
      <path fill={CR.wht} d="M0-17C-11-17-18-9-18 1-18 8-14 13-9 16L-9 21C-9 24-7 26-4 26L4 26C7 26 9 24 9 21L9 16C14 13 18 8 18 1 18-9 11-17 0-17Z" />
      <circle cx="-7.5" cy="0" r="4.3" fill={hole} />
      <circle cx="7.5" cy="0" r="4.3" fill={hole} />
      <g fill={hole}>
        <rect x="-6" y="16" width="2.4" height="8" rx="1" />
        <rect x="-1.2" y="16" width="2.4" height="8" rx="1" />
        <rect x="3.6" y="16" width="2.4" height="8" rx="1" />
      </g>
    </g>
  )
}

/** one cell of the far-left vertical hazard strip */
function StripCell({ cy, color }: { cy: number; color: string }) {
  return (
    <g>
      <path d={crDia(72, cy, 41, 45)} fill={color} stroke={CR.ink} strokeWidth="4" strokeLinejoin="miter" />
      <MiniSkull cx={72} cy={cy} s={0.92} hole={color} />
    </g>
  )
}

function CrashOverride() {
  const strip = Array.from({ length: 16 })
  const teeth = Array.from({ length: 6 })
  return (
    <div className="hb-fill" style={{ background: CR.bg }}>
      <svg className="hb-crash-svg" viewBox="0 0 1280 720" preserveAspectRatio="xMidYMid meet">
        <defs>
          <clipPath id="crStripClip"><rect x="18" y="26" width="108" height="668" /></clipPath>
        </defs>

        {/* ---- massive diamond framing system (thick geometric black) ---- */}
        <g className="hb-cr-frame" fill="none" stroke={CR.ink} strokeWidth="22" strokeLinejoin="miter">
          <path d={crDia(350, 380, 310, 280)} />
          <path d={crDia(970, 380, 310, 280)} />
        </g>

        {/* ---- right icons + mechanical bracket/gear (slides in from the right) ---- */}
        <g className="hb-cr-right">
          <g fill={CR.ink}>
            <rect x="1150" y="286" width="130" height="188" rx="20" />
            <g transform="translate(1236 380)">
              {Array.from({ length: 8 }).map((_, i) => (
                <rect key={i} x="-11" y="-70" width="22" height="26" transform={`rotate(${i * 45})`} />
              ))}
              <circle r="52" />
            </g>
            <circle cx="1236" cy="380" r="19" fill={CR.bg} />
          </g>

          {/* bomb hazard diamond (top-right) — white stencil */}
          <path d={crDia(1066, 196, 132, 122)} fill={CR.ink} stroke={CR.wht} strokeWidth="6" />
          <g stroke={CR.wht} fill="none" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="1060" cy="216" r="40" />
            <rect x="1050" y="162" width="20" height="18" />
            <path d="M1076 166 Q1100 154 1096 132" />
          </g>
          <path d="M1092 118 l5 -13 l5 13 l13 5 l-13 5 l-5 13 l-5 -13 l-13 -5 Z" fill={CR.wht} />

          {/* flame hazard diamond (bottom-right) — white stencil */}
          <path d={crDia(1092, 566, 132, 122)} fill={CR.ink} stroke={CR.wht} strokeWidth="6" />
          <path d="M1092 506 C1116 532 1120 558 1107 583 C1099 598 1082 600 1072 588 C1063 577 1066 557 1080 545 C1077 557 1086 561 1088 550 C1090 535 1079 529 1088 510 C1092 524 1103 530 1099 547 C1112 536 1109 519 1092 506 Z" fill={CR.wht} />
        </g>

        {/* ---- skull (bold, symmetric geometric stencil; flat jaw) ---- */}
        <g className="hb-cr-skull">
          <path fill={CR.ink} d="M185 300C185 210 250 160 340 160C430 160 495 210 495 300L495 360L470 430L458 545L222 545L210 430L185 360Z" />
          {/* open circular eye socket (right) */}
          <circle cx="408" cy="310" r="42" fill={CR.bg} />
          {/* eyepatch — a bold circular socket + a clean solid rectangle bar intersecting it */}
          <circle cx="272" cy="310" r="42" fill={CR.bg} />
          <rect x="202" y="290" width="140" height="40" transform="rotate(-55 272 310)" fill={CR.ink} />
          {/* nostrils — two identical, parallel, untilted pill voids */}
          <rect x="324" y="396" width="14" height="46" rx="7" fill={CR.bg} />
          <rect x="342" y="396" width="14" height="46" rx="7" fill={CR.bg} />
          {/* teeth — mathematically uniform vertical rectangle cutouts; jaw stays flat below them */}
          <g fill={CR.bg}>
            {teeth.map((_, i) => <rect key={i} x={250 + i * 33} y="468" width="15" height="72" />)}
          </g>
        </g>

        {/* ---- central "NO SUN" stencil at the shared vertex ---- */}
        <g className="hb-cr-nosun">
          <circle cx="630" cy="380" r="94" fill={CR.bg} stroke={CR.ink} strokeWidth="10" />
          <circle cx="630" cy="380" r="18" fill={CR.ink} />
          <g stroke={CR.ink} strokeWidth="7" strokeLinecap="round">
            {Array.from({ length: 12 }).map((_, i) => {
              const a = (i / 12) * Math.PI * 2
              return <line key={i} x1={630 + 30 * Math.cos(a)} y1={380 + 30 * Math.sin(a)} x2={630 + 50 * Math.cos(a)} y2={380 + 50 * Math.sin(a)} />
            })}
          </g>
          {/* prohibition slash — a solid rectangle at a clean 45° */}
          <rect x="541" y="367" width="178" height="26" transform="rotate(-45 630 380)" fill={CR.ink} />
        </g>

        {/* ---- far-left vertical strip: alternating blue/red skull diamonds, scrolling ---- */}
        <g clipPath="url(#crStripClip)">
          <g className="hb-cr-strip">
            {strip.map((_, i) => (
              <StripCell key={i} cy={68 + i * 92} color={i % 2 === 0 ? CR.blu : CR.red} />
            ))}
          </g>
        </g>
      </svg>
      <div className="hb-handle" style={{ color: CR.ink }}>CRASH OVERRIDE</div>
    </div>
  )
}

/* ============ Card 2 — Acid Burn (canvas fire) — unchanged, it's perfect ============ */

function AcidBurn() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!
    const ctx = cv.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = cv.clientWidth, H = cv.clientHeight
    cv.width = W * dpr; cv.height = H * dpr; ctx.scale(dpr, dpr)
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.28
    type P = { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number }
    const parts: P[] = []
    let raf = 0, run = true
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    function frame() {
      ctx.clearRect(0, 0, W, H)
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(cx, cy - R); ctx.lineTo(cx + R, cy); ctx.lineTo(cx, cy + R); ctx.lineTo(cx - R, cy); ctx.closePath()
      ctx.clip()
      if (!reduced) for (let i = 0; i < 14; i++) parts.push({ x: cx + (Math.random() - 0.5) * R, y: cy + R * 0.6, vx: (Math.random() - 0.5) * 0.6, vy: -1.6 - Math.random() * 2.4, life: 0, max: 40 + Math.random() * 30, r: 6 + Math.random() * 10 })
      ctx.globalCompositeOperation = 'lighter'
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]; p.life++; p.x += p.vx; p.y += p.vy; p.vy += 0.02
        const t = p.life / p.max
        if (t >= 1) { parts.splice(i, 1); continue }
        const a = (1 - t) * 0.5
        const col = t < 0.4 ? `rgba(255,220,90,${a})` : t < 0.75 ? `rgba(255,120,20,${a})` : `rgba(200,40,10,${a})`
        ctx.fillStyle = col
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + t), 0, Math.PI * 2); ctx.fill()
      }
      ctx.restore()
      if (run) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => { run = false; cancelAnimationFrame(raf) }
  }, [])
  return (
    <div className="hb-fill" style={{ background: '#000' }}>
      <div className="hb-flamediamond" />
      <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <svg className="hb-flameicon" viewBox="0 0 100 120" width="150" height="180">
        <path d="M50 8 c14 20 24 26 14 44 c-3 6 8 3 8 -7 c9 15 -2 45 -22 45 c-20 0 -27 -20 -15 -37 c3 12 10 7 7 0 c-6 -15 8 -25 8 -45 Z" fill="#ffe500" />
        <rect x="18" y="104" width="64" height="7" rx="2" fill="#ffe500" />
      </svg>
      <div className="hb-handle" style={{ color: '#ff2a00' }}>ACID BURN</div>
    </div>
  )
}

/* ============ Card 3 — Lord Nikon (aperture → Nikon) ============ */

/** the opening iris (dilates on white) — charcoal disc, dark seams, white hole */
function OpeningIris({ w = 380 }: { w?: number }) {
  return (
    <svg viewBox="0 0 200 200" width={w} height={w} style={{ display: 'block' }}>
      <circle cx="100" cy="100" r="95" fill="#333" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <path key={i} d="M100 100 Q152 74 176 106" stroke="#151515" strokeWidth="4" fill="none" transform={`rotate(${i * 60} 100 100)`} />
      ))}
      <circle cx="100" cy="100" r="26" fill="#fff" />
    </svg>
  )
}

/** the logo iris (final composite) — black disc, prominent WHITE blade swirl */
function LogoIris({ w = 440 }: { w?: number }) {
  const hex = Array.from({ length: 6 }).map((_, i) => {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2
    return `${100 + 17 * Math.cos(a)},${100 + 17 * Math.sin(a)}`
  }).join(' ')
  return (
    <svg viewBox="0 0 200 200" width={w} height={w} style={{ display: 'block' }}>
      <circle cx="100" cy="100" r="96" fill="#0a0a0a" />
      {/* 6 white curved blades spiraling to the rim */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <path key={i} d="M100 80 Q157 79 160 140" stroke="#fff" strokeWidth="15" fill="none" strokeLinecap="round" transform={`rotate(${i * 60} 100 100)`} />
      ))}
      {/* central hexagonal aperture opening */}
      <polygon points={hex} fill="none" stroke="#fff" strokeWidth="6" />
    </svg>
  )
}

function LordNikon() {
  return (
    <div className="hb-fill hb-nikon" style={{ background: '#000' }}>
      {/* A: charcoal iris dilates open on white, then white flash */}
      <div className="hb-nk-open">
        <div className="hb-iris"><OpeningIris /></div>
      </div>
      <div className="hb-nk-flash" />
      {/* B: red Nikon on white */}
      <div className="hb-nk-red">
        <span className="hb-nikonword" style={{ color: '#f5330a' }}>Nikon</span>
      </div>
      {/* C: composite — black iris re-forms center with white blade swirl, big WHITE Nikon over it, brushed streaks */}
      <div className="hb-nk-final">
        <div className="hb-streaks" />
        <div className="hb-finaliris"><LogoIris w={560} /></div>
        <span className="hb-nikonword hb-nikonword--white">Nikon</span>
      </div>
    </div>
  )
}

/* ============ Card 4 — Cereal Killer (dot-storm → eyepatch smiley) ============ */

function Smiley() {
  const ink = '#1c1c1c'
  // coordinates measured from the reference (center 100,100, r 90)
  return (
    <svg viewBox="0 0 200 200" width="520" height="520" style={{ display: 'block', maxWidth: '82vh', maxHeight: '82vh' }}>
      <circle cx="100" cy="100" r="90" fill="#f2d41a" stroke={ink} strokeWidth="11" />
      {/* open eye — tall oval, upper-left: measured centroid (68,70), 34×46 */}
      <ellipse cx="68" cy="70" rx="17" ry="23" fill={ink} transform="rotate(6 68 70)" />
      {/* eyepatch strap — from the top of the head down to the lens */}
      <path d="M66 30 L112 60" stroke={ink} strokeWidth="13" strokeLinecap="round" fill="none" />
      {/* eyepatch lens — aviator shape pointing to the right edge (centroid ~135,72) */}
      <path d="M106 52 Q140 57 168 78 Q150 98 116 90 Q99 77 106 52 Z" fill={ink} />
      {/* smile — wide upturned arc: measured ends (40,110), dip to ~155 */}
      <path d="M40 110 Q100 204 162 110" stroke={ink} strokeWidth="12" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function CerealKiller() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!
    const ctx = cv.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = cv.clientWidth, H = cv.clientHeight
    cv.width = W * dpr; cv.height = H * dpr; ctx.scale(dpr, dpr)
    const COLORS = ['#ff2a00', '#ffd500', '#33cc33', '#0a0a0a']
    type D = { x: number; y: number; r: number; max: number; c: string }
    const dots: D[] = []
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cx = W / 2, cy = H / 2
    let spread = 30, raf = 0, run = true, frame = 0
    function step() {
      frame++
      if (!reduced && frame < 110) {
        spread = Math.min(Math.max(W, H) * 0.72, spread + 9)
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * Math.PI * 2, d = Math.random() * spread
          dots.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: 0, max: 8 + Math.random() * 26, c: COLORS[(Math.random() * COLORS.length) | 0] })
        }
      }
      // background lerps black → white (the film starts dark, resolves on white)
      const bgT = Math.min(1, frame / 60)
      const g = Math.round(bgT * 255)
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = `rgb(${g},${g},${g})`
      ctx.fillRect(0, 0, W, H)
      // dots swarm, then fade away once the smiley pops in (~frame 105) so it dominates the final frame
      const fade = frame < 105 ? 0.82 : Math.max(0, 0.82 * (1 - (frame - 105) / 55))
      ctx.globalAlpha = fade
      if (fade > 0) for (const d of dots) { if (d.r < d.max) d.r += 1.5; ctx.fillStyle = d.c; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill() }
      ctx.globalAlpha = 1
      if (dots.length > 1500) dots.splice(0, dots.length - 1500)
      if (run) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => { run = false; cancelAnimationFrame(raf) }
  }, [])
  return (
    <div className="hb-fill" style={{ background: '#000' }}>
      <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      {/* the dot-storm resolves into the eyepatch smiley, dead center */}
      <div className="hb-smiley"><Smiley /></div>
      <div className="hb-handle" style={{ color: '#0a0a0a' }}>CEREAL KILLER</div>
    </div>
  )
}

/* ============ Card 5 — HACK THE PLANET ============ */

function HackThePlanet() {
  return (
    <div className="hb-fill" style={{ background: '#04060a' }}>
      <div className="hb-htp">
        <div className="hb-htp-sub">// THE GIBSON // UPLINK ESTABLISHED</div>
        <div className="hb-htp-main" data-text="HACK THE PLANET">HACK THE PLANET</div>
      </div>
    </div>
  )
}

/* ============ styles ============ */

const CSS = `
.hb-fill { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; overflow:hidden; opacity:1; }
.hb-bootvid { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#000; display:block; }
/* CRT overlay — tuned to match GRID//OS: fine scanlines, deep vignette, sweeping scan band, flicker */
.hb-crt { position:absolute; inset:0; pointer-events:none; z-index:6; opacity:.55; overflow:hidden;
  background:
    repeating-linear-gradient(0deg, rgba(0,0,0,.14) 0 1px, transparent 1px 3px),
    radial-gradient(130% 120% at 50% 44%, transparent 54%, rgba(0,0,0,.46) 100%);
  animation: hb-flick 3.2s steps(1) infinite; }
.hb-crt::after { content:''; position:absolute; left:0; right:0; top:0; height:130px; pointer-events:none;
  background:linear-gradient(180deg, rgba(150,220,255,.06), transparent); mix-blend-mode:screen;
  animation: hb-scanbar 8.5s linear infinite; }
@keyframes hb-scanbar { 0%{transform:translateY(-130px)} 100%{transform:translateY(100vh)} }
@keyframes hb-flick { 0%,100%{opacity:.55} 3%{opacity:.38} 4%{opacity:.55} 47%{opacity:.55} 48%{opacity:.44} 49%{opacity:.55} }
.hb-skip { position:absolute; bottom:14px; right:16px; z-index:7; font-family:"IBM Plex Mono",Consolas,monospace;
  font-size:9px; letter-spacing:3px; color:rgba(180,255,210,.4); }
.hb-handle { position:absolute; bottom:34px; left:0; right:0; text-align:center; z-index:5;
  font-family:"IBM Plex Mono",Consolas,monospace; font-size:15px; font-weight:700; letter-spacing:8px;
  animation: hb-handlein .5s .3s both; }
@keyframes hb-handlein { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }

/* crash override — single-SVG industrial hazard UI (1280x720 user space) */
.hb-crash-svg { position:absolute; inset:0; width:100%; height:100%; }
.hb-cr-frame { opacity:0; animation: hb-crfade .45s .05s ease-out both; }
.hb-cr-nosun { opacity:0; animation: hb-crfade .45s .42s ease-out both; }
.hb-cr-skull { opacity:0; animation: hb-crrise .55s .2s cubic-bezier(.2,.8,.3,1) both; }
.hb-cr-right { opacity:0; animation: hb-crslide .55s .32s cubic-bezier(.2,.8,.3,1) both; }
.hb-cr-strip { animation: hb-crscroll 4.6s linear infinite; }
@keyframes hb-crfade { from{opacity:0} to{opacity:1} }
@keyframes hb-crrise { from{opacity:0;transform:translateY(28px)} to{opacity:1;transform:translateY(0)} }
@keyframes hb-crslide { from{opacity:0;transform:translateX(260px)} to{opacity:1;transform:translateX(0)} }
@keyframes hb-crscroll { from{transform:translateY(0)} to{transform:translateY(-736px)} }

/* acid burn */
.hb-flamediamond { position:absolute; width:300px; height:300px; border:5px solid #ff2a00; transform:rotate(45deg);
  box-shadow:0 0 40px rgba(255,42,0,.5); animation: hb-fdin .4s ease-out both; }
@keyframes hb-fdin { from{opacity:0;transform:rotate(45deg) scale(.5)} to{opacity:1;transform:rotate(45deg) scale(1)} }
.hb-flameicon { position:absolute; z-index:3; opacity:0; filter:drop-shadow(0 0 18px rgba(255,229,0,.6));
  animation: hb-flamein .5s 1.05s ease-out both; }
@keyframes hb-flamein { from{opacity:0;transform:scale(.4)} 70%{opacity:1;transform:scale(1.12)} to{opacity:1;transform:scale(1)} }

/* lord nikon */
.hb-nikon > div { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; }
.hb-nk-open { animation: hb-nkopenwrap .1s 1.15s forwards; }
@keyframes hb-nkopenwrap { to { opacity:0; visibility:hidden; } }
.hb-iris { transform-origin:50% 50%; animation: hb-irisopen 1.15s cubic-bezier(.45,0,.75,1) both; }
@keyframes hb-irisopen { 0%{transform:scale(.16) rotate(0)} 100%{transform:scale(4.6) rotate(140deg)} }
.hb-nk-flash { background:#fff; opacity:0; animation: hb-flash 1.5s linear both; }
@keyframes hb-flash { 0%,70%{opacity:0} 75%{opacity:1} 100%{opacity:1} }
.hb-nk-red { background:#fff; opacity:0; animation: hb-nkred 2.9s linear both; }
@keyframes hb-nkred { 0%,72%{opacity:0} 78%{opacity:1} 86%{opacity:1} 90%{opacity:0} 100%{opacity:0} }
.hb-nikonword { font-family:"Chakra Petch","Trebuchet MS",sans-serif; font-weight:700; font-style:italic;
  font-size:118px; letter-spacing:-1px; transform:skewX(-8deg); }
.hb-nk-red .hb-nikonword { animation: hb-wordstreak .3s 1.32s cubic-bezier(.2,.8,.3,1) both; }
@keyframes hb-wordstreak { from{opacity:0;transform:skewX(-8deg) scaleY(.3) translateY(-40px);filter:blur(8px)} to{opacity:1;transform:skewX(-8deg);filter:none} }
.hb-nk-final { opacity:0; animation: hb-nkfinal 2.9s linear both; }
@keyframes hb-nkfinal { 0%,88%{opacity:0} 91%{opacity:1} 100%{opacity:1} }
/* brushed diagonal streaks: silver (thin left) / forest green (dominant) / gold (right) */
.hb-streaks { position:absolute; inset:0;
  background:
    repeating-linear-gradient(78deg, rgba(255,255,255,.10) 0 1.5px, transparent 1.5px 5px),
    repeating-linear-gradient(78deg, rgba(0,0,0,.14) 0 1px, transparent 1px 7px),
    linear-gradient(100deg, #cfcfcf 0 14%, #5b7d31 14%, #3f5c22 40%, #5b7d31 58%, #c9a227 63%, #d8b23a 100%);
  animation: hb-glitchshift .12s steps(2) 6; }
@keyframes hb-glitchshift { 0%{transform:translateX(0)} 50%{transform:translateX(-6px)} 100%{transform:translateX(0)} }
.hb-finaliris { position:absolute; filter:drop-shadow(0 10px 30px rgba(0,0,0,.5)); }
.hb-nikonword--white { position:absolute; z-index:2; color:#fff; font-size:190px; letter-spacing:-4px; text-shadow:0 3px 12px rgba(0,0,0,.55), 0 0 2px rgba(0,0,0,.8); }

/* cereal killer */
.hb-smiley { position:absolute; z-index:3; opacity:0; filter:drop-shadow(0 6px 16px rgba(0,0,0,.3));
  animation: hb-smileyin .6s 1.55s cubic-bezier(.3,1.4,.5,1) both; }
@keyframes hb-smileyin { 0%{opacity:0;transform:scale(.2) rotate(-12deg)} 70%{opacity:1} 100%{opacity:1;transform:scale(1)} }

/* hack the planet */
.hb-htp { text-align:center; animation: hb-htpin .3s ease-out both; }
@keyframes hb-htpin { from{opacity:0;transform:scale(1.15)} to{opacity:1;transform:none} }
.hb-htp-sub { font-family:"IBM Plex Mono",Consolas,monospace; font-size:11px; letter-spacing:6px; color:#39ff84; margin-bottom:14px;
  text-shadow:0 0 8px rgba(57,255,132,.7); }
.hb-htp-main { position:relative; font-family:"Chakra Petch",sans-serif; font-weight:700; font-size:46px; letter-spacing:6px; color:#39ff84;
  text-shadow:0 0 14px rgba(57,255,132,.8),0 0 40px rgba(57,255,132,.35); animation: hb-glitchtext .18s steps(2) infinite; }
.hb-htp-main::before, .hb-htp-main::after { content:attr(data-text); position:absolute; inset:0; }
.hb-htp-main::before { color:#ff2fd6; transform:translate(-2px,0); mix-blend-mode:screen; animation: hb-glitchtext .2s steps(2) infinite reverse; }
.hb-htp-main::after { color:#00e5ff; transform:translate(2px,0); mix-blend-mode:screen; }
@keyframes hb-glitchtext { 0%,100%{transform:translate(0)} 50%{transform:translate(1px,-1px)} }

@media (prefers-reduced-motion: reduce) {
  .hb-crt, .hb-htp-main, .hb-htp-main::before, .hb-cr-strip { animation:none; }
  .hb-cr-frame, .hb-cr-nosun, .hb-cr-skull, .hb-cr-right { opacity:1; animation:none; }
}
`
