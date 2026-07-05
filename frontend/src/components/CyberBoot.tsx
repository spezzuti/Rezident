import { useEffect, useRef, useState } from 'react'

/**
 * HACKERS (1995) boot animation — the "booting up" montage recreated for the
 * cyber theme. Four laptops flash their poster-art boot logos, hard-cut, then
 * a HACK THE PLANET sting hands off to the OS.
 *
 * Card 1 — Crash Override: black eyepatch skull on hazard yellow, rotating
 *          warning diamonds + strobing hazard placards, filmstrip skull column.
 * Card 2 — Acid Burn: fire blooms inside a red flammable diamond, resolves to
 *          the yellow flame pictogram.
 * Card 3 — Lord Nikon: charcoal camera aperture dilates open through a white
 *          flash, red "Nikon" wordmark streaks in, glitch-cut to the tri-color
 *          streak composite (the fuller clip-2 version).
 * Card 4 — Cereal Killer: white screen floods with growing Rasta dot-storm.
 *
 * Pure SVG + CSS + a little canvas — no assets. Click / any key skips.
 */

type Phase = 'crash' | 'acid' | 'nikon' | 'cereal' | 'planet' | 'end'

export type BootVariant = 'crash' | 'acid' | 'nikon' | 'cereal' | 'montage' | 'random'

/** The selectable boot sequences — each Hackers laptop is its own boot. */
export const BOOT_VARIANTS: { id: BootVariant; label: string; blurb: string; glyph: string }[] = [
  { id: 'crash', label: 'Crash Override', blurb: 'hazard-yellow eyepatch skull', glyph: '☠' },
  { id: 'acid', label: 'Acid Burn', blurb: 'fire in a flammable diamond', glyph: '🔥' },
  { id: 'nikon', label: 'Lord Nikon', blurb: 'camera aperture → red Nikon', glyph: '◉' },
  { id: 'cereal', label: 'Cereal Killer', blurb: 'psychedelic rasta dot-storm', glyph: '⦿' },
  { id: 'montage', label: 'Full Montage', blurb: 'all four, hard-cut', glyph: '▦' },
  { id: 'random', label: 'Random', blurb: 'a different one every boot', glyph: '⚄' },
]

const SINGLES = ['crash', 'acid', 'nikon', 'cereal'] as const
const CARD_MS: Record<(typeof SINGLES)[number], number> = { crash: 2600, acid: 2600, nikon: 2900, cereal: 2600 }

function buildSequence(variant: BootVariant): { phase: Phase; ms: number }[] {
  if (variant === 'montage') {
    return [
      { phase: 'crash', ms: 1900 },
      { phase: 'acid', ms: 1700 },
      { phase: 'nikon', ms: 2600 },
      { phase: 'cereal', ms: 1700 },
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

export default function CyberBoot({ variant = 'montage', onDone }: { variant?: BootVariant; onDone?: () => void }) {
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
      {/* CRT scanline + vignette wash over the whole montage */}
      <div className="hb-crt" />
      <div className="hb-skip">CLICK / ANY KEY TO SKIP</div>
    </div>
  )
}

/* ============ Card 1 — Crash Override ============ */

function Skull() {
  // Blocky pirate-skull pictogram with an eyepatch over the right socket.
  return (
    <svg viewBox="0 0 100 110" width="240" height="264" style={{ display: 'block' }}>
      <g fill="#0a0a0a">
        {/* cranium + jaw */}
        <path d="M50 6C28 6 15 21 15 43c0 12 5 21 12 27v13c0 6 4 10 10 10h26c6 0 10-4 10-10V70c7-6 12-15 12-27C85 21 72 6 50 6Z" />
      </g>
      {/* left eye socket */}
      <circle cx="36" cy="45" r="10" fill="#f2c200" />
      {/* right eye — covered by the patch */}
      <g>
        <path d="M78 30 L52 52" stroke="#0a0a0a" strokeWidth="5" strokeLinecap="round" fill="none" />
        <ellipse cx="64" cy="45" rx="11" ry="9" fill="#0a0a0a" transform="rotate(-20 64 45)" />
      </g>
      {/* nose */}
      <path d="M50 55 L44 68 L56 68 Z" fill="#f2c200" />
      {/* teeth */}
      <g fill="#f2c200">
        <rect x="38" y="82" width="4.5" height="12" rx="1" />
        <rect x="45" y="82" width="4.5" height="12" rx="1" />
        <rect x="52" y="82" width="4.5" height="12" rx="1" />
        <rect x="59" y="82" width="4.5" height="12" rx="1" />
      </g>
    </svg>
  )
}

function HazardPlacard({ kind }: { kind: 'bomb' | 'flame' | 'trefoil' }) {
  return (
    <svg viewBox="0 0 60 60" width="60" height="60">
      <rect x="6" y="6" width="48" height="48" rx="4" transform="rotate(45 30 30)" fill="none" stroke="#0a0a0a" strokeWidth="3" />
      {kind === 'bomb' && (
        <g fill="#0a0a0a">
          <circle cx="30" cy="34" r="9" />
          <path d="M34 24 q3 -6 8 -5" stroke="#0a0a0a" strokeWidth="2.4" fill="none" />
          <path d="M40 18 l2 -3 l2 3 l-2 2 Z" />
        </g>
      )}
      {kind === 'flame' && (
        <path d="M30 16 c6 8 10 10 6 18 c-1 2 3 1 3 -3 c4 6 -1 15 -9 15 c-8 0 -11 -8 -6 -15 c1 5 4 3 3 0 c-2 -6 3 -10 3 -15 Z" fill="#0a0a0a" />
      )}
      {kind === 'trefoil' && (
        <g fill="#0a0a0a">
          <circle cx="30" cy="32" r="4" />
          {[0, 120, 240].map((d) => (
            <path key={d} d="M30 32 L38 18 A16 16 0 0 1 22 18 Z" transform={`rotate(${d} 30 32)`} />
          ))}
        </g>
      )}
    </svg>
  )
}

function CrashOverride() {
  return (
    <div className="hb-fill" style={{ background: '#f2c200' }}>
      {/* filmstrip column of skull-diamonds down the left edge */}
      <div className="hb-strip">
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i} style={{ color: i % 2 ? '#e01020' : '#1e5ae0' }}>◈</span>
        ))}
      </div>
      {/* rotating warning diamonds behind the skull */}
      <div className="hb-diamond hb-diamond--a" />
      <div className="hb-diamond hb-diamond--b" />
      {/* strobing hazard placards flying in */}
      <div className="hb-placard hb-placard--tl"><HazardPlacard kind="bomb" /></div>
      <div className="hb-placard hb-placard--tr"><HazardPlacard kind="flame" /></div>
      <div className="hb-placard hb-placard--br"><HazardPlacard kind="trefoil" /></div>
      <div className="hb-skull"><Skull /></div>
      <div className="hb-handle" style={{ color: '#0a0a0a' }}>CRASH OVERRIDE</div>
    </div>
  )
}

/* ============ Card 2 — Acid Burn (canvas fire) ============ */

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
      // diamond clip
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
      {/* resolves to the flame pictogram */}
      <svg className="hb-flameicon" viewBox="0 0 100 120" width="150" height="180">
        <path d="M50 8 c14 20 24 26 14 44 c-3 6 8 3 8 -7 c9 15 -2 45 -22 45 c-20 0 -27 -20 -15 -37 c3 12 10 7 7 0 c-6 -15 8 -25 8 -45 Z" fill="#ffe500" />
        <rect x="18" y="104" width="64" height="7" rx="2" fill="#ffe500" />
      </svg>
      <div className="hb-handle" style={{ color: '#ff2a00' }}>ACID BURN</div>
    </div>
  )
}

/* ============ Card 3 — Lord Nikon (aperture → Nikon) ============ */

function Aperture({ fill, className }: { fill: string; className?: string }) {
  return (
    <svg viewBox="0 0 200 200" width="360" height="360" className={className} style={{ display: 'block' }}>
      <g>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <path key={i} d="M100 100 L154 100 A54 54 0 0 1 127 147 Z" fill={fill} transform={`rotate(${i * 60} 100 100)`} />
        ))}
      </g>
    </svg>
  )
}

function LordNikon() {
  return (
    <div className="hb-fill hb-nikon" style={{ background: '#000' }}>
      {/* sub-phase A: charcoal aperture dilates open on black → white flash */}
      <div className="hb-nk-open">
        <Aperture fill="#333" className="hb-iris" />
      </div>
      <div className="hb-nk-flash" />
      {/* sub-phase B: red Nikon on white */}
      <div className="hb-nk-red">
        <span className="hb-nikonword" style={{ color: '#f5330a' }}>Nikon</span>
      </div>
      {/* sub-phase C: tri-color streak composite + black aperture + black word + corner icon */}
      <div className="hb-nk-final">
        <div className="hb-streaks" />
        <div className="hb-finaliris"><Aperture fill="#0e0e0e" /></div>
        <span className="hb-nikonword hb-nikonword--black" style={{ color: '#0a0a0a' }}>Nikon</span>
        <svg className="hb-corneriris" viewBox="0 0 60 60" width="54" height="54">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <path key={i} d="M30 30 L46 30 A16 16 0 0 1 38 44 Z" fill="#f5330a" transform={`rotate(${i * 60} 30 30)`} />
          ))}
        </svg>
      </div>
    </div>
  )
}

/* ============ Card 4 — Cereal Killer (canvas dot-storm) ============ */

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
    let cx = W / 2, cy = H / 2, spread = 30, raf = 0, run = true
    function frame() {
      if (!reduced) {
        spread = Math.min(Math.max(W, H) * 0.75, spread + 9)
        for (let i = 0; i < 7; i++) {
          const a = Math.random() * Math.PI * 2, d = Math.random() * spread
          dots.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: 0, max: 8 + Math.random() * 26, c: COLORS[(Math.random() * COLORS.length) | 0] })
        }
      }
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H)
      ctx.globalAlpha = 0.82
      for (const d of dots) { if (d.r < d.max) d.r += 1.4; ctx.fillStyle = d.c; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill() }
      ctx.globalAlpha = 1
      if (dots.length > 1400) dots.splice(0, dots.length - 1400)
      if (run) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => { run = false; cancelAnimationFrame(raf) }
  }, [])
  return (
    <div className="hb-fill" style={{ background: '#fff' }}>
      <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
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
/* cards hard-cut in, like the film */
.hb-fill { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; overflow:hidden; opacity:1; }
/* subtle CRT — scanlines + faint edge vignette, kept light so the bright
   poster art stays punchy (the film screens are clean, not murky) */
.hb-crt { position:absolute; inset:0; pointer-events:none; z-index:5; opacity:.5;
  background:
    repeating-linear-gradient(0deg, rgba(0,0,0,.11) 0 1px, transparent 1px 3px),
    radial-gradient(ellipse at center, transparent 68%, rgba(0,0,0,.28) 100%);
  animation: hb-flick 3.2s steps(1) infinite; }
@keyframes hb-flick { 0%,100%{opacity:.5} 3%{opacity:.34} 4%{opacity:.5} 47%{opacity:.5} 48%{opacity:.4} 49%{opacity:.5} }
.hb-skip { position:absolute; bottom:14px; right:16px; z-index:6; font-family:"IBM Plex Mono",Consolas,monospace;
  font-size:9px; letter-spacing:3px; color:rgba(180,255,210,.4); }
.hb-handle { position:absolute; bottom:34px; left:0; right:0; text-align:center; z-index:4;
  font-family:"IBM Plex Mono",Consolas,monospace; font-size:15px; font-weight:700; letter-spacing:8px;
  animation: hb-handlein .5s .3s both; }
@keyframes hb-handlein { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }

/* crash override */
.hb-skull { position:relative; z-index:3; filter: drop-shadow(0 4px 10px rgba(0,0,0,.25)); animation: hb-skullpop .55s cubic-bezier(.3,1.5,.5,1) both; }
@keyframes hb-skullpop { 0%{transform:scale(.3) rotate(-8deg);opacity:0} 100%{transform:scale(1);opacity:1} }
.hb-diamond { position:absolute; width:300px; height:300px; border:6px solid #0a0a0a; }
.hb-diamond--a { animation: hb-dia 1.9s linear both; }
.hb-diamond--b { width:220px; height:220px; animation: hb-dia 1.9s linear reverse both; }
@keyframes hb-dia { 0%{transform:rotate(45deg) scale(.2);opacity:0} 20%{opacity:.9} 100%{transform:rotate(160deg) scale(1.4);opacity:0} }
.hb-strip { position:absolute; left:14px; top:0; bottom:0; z-index:4; display:flex; flex-direction:column; gap:10px; font-size:26px;
  animation: hb-striproll 1.9s linear infinite; }
@keyframes hb-striproll { from{transform:translateY(0)} to{transform:translateY(-72px)} }
.hb-placard { position:absolute; z-index:2; opacity:0; }
.hb-placard--tl { top:15%; left:19%; animation: hb-plin .5s .15s ease-out both; }
.hb-placard--tr { top:19%; right:17%; animation: hb-plin .5s .35s ease-out both; }
.hb-placard--br { bottom:21%; right:23%; animation: hb-plin .5s .55s ease-out both; }
@keyframes hb-plin { from{opacity:0;transform:scale(2) rotate(30deg)} 70%{opacity:1} to{opacity:.9;transform:none} }

/* acid burn */
.hb-flamediamond { position:absolute; width:300px; height:300px; border:5px solid #ff2a00; transform:rotate(45deg);
  box-shadow:0 0 40px rgba(255,42,0,.5); animation: hb-fdin .4s ease-out both; }
@keyframes hb-fdin { from{opacity:0;transform:rotate(45deg) scale(.5)} to{opacity:1;transform:rotate(45deg) scale(1)} }
.hb-flameicon { position:absolute; z-index:3; opacity:0; filter:drop-shadow(0 0 18px rgba(255,229,0,.6));
  animation: hb-flamein .5s 1.05s ease-out both; }
@keyframes hb-flamein { from{opacity:0;transform:scale(.4)} 70%{opacity:1;transform:scale(1.12)} to{opacity:1;transform:scale(1)} }

/* lord nikon */
.hb-nikon > div { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; }
.hb-nk-open { animation: hb-nkopenwrap .1s 1.05s forwards; }         /* hide after phase A */
@keyframes hb-nkopenwrap { to { opacity:0; visibility:hidden; } }
.hb-iris { transform-origin:50% 50%; animation: hb-irisopen 1.05s cubic-bezier(.5,0,.8,1) both; }
@keyframes hb-irisopen { 0%{transform:scale(.18) rotate(0)} 100%{transform:scale(4.2) rotate(120deg)} }
.hb-nk-flash { background:#fff; opacity:0; animation: hb-flash 1.4s linear both; }
@keyframes hb-flash { 0%,70%{opacity:0} 76%{opacity:1} 90%{opacity:1} 100%{opacity:1} }
.hb-nk-red { background:#fff; opacity:0; animation: hb-nkred 2.6s linear both; }
@keyframes hb-nkred { 0%,74%{opacity:0} 80%{opacity:1} 88%{opacity:1} 90%{opacity:0} 100%{opacity:0} }
.hb-nikonword { font-family:"Chakra Petch","Trebuchet MS",sans-serif; font-weight:700; font-style:italic;
  font-size:74px; letter-spacing:-1px; transform:skewX(-8deg); }
.hb-nk-red .hb-nikonword { animation: hb-wordstreak .3s .78s cubic-bezier(.2,.8,.3,1) both; }
@keyframes hb-wordstreak { from{opacity:0;transform:skewX(-8deg) scaleY(.3) translateY(-40px);filter:blur(8px)} to{opacity:1;transform:skewX(-8deg);filter:none} }
.hb-nk-final { opacity:0; animation: hb-nkfinal 2.6s linear both; }
@keyframes hb-nkfinal { 0%,90%{opacity:0} 93%{opacity:1} 100%{opacity:1} }
.hb-streaks { position:absolute; inset:0;
  background:
    linear-gradient(115deg, #bfbfbf 0 22%, transparent 22%),
    linear-gradient(115deg, transparent 22%, #556b2f 22% 52%, transparent 52%),
    linear-gradient(115deg, transparent 52%, #c9a227 52% 100%),
    repeating-linear-gradient(115deg, rgba(42,75,215,.5) 0 2px, transparent 2px 26px);
  filter:contrast(1.1); animation: hb-glitchshift .12s steps(2) 6; }
@keyframes hb-glitchshift { 0%{transform:translateX(0)} 50%{transform:translateX(-6px)} 100%{transform:translateX(0)} }
.hb-finaliris { position:absolute; }
.hb-nikonword--black { position:absolute; z-index:2; }
.hb-corneriris { position:absolute; top:20px; right:22px; z-index:3; }

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
  .hb-crt, .hb-htp-main, .hb-htp-main::before { animation:none; }
}
`
