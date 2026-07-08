/**
 * PIP-OS UI sound engine — the wasteland counterpart to the GRID//OS deck audio.
 * Character: Pip-Boy authentic — bright ratchety ticks, square-wave terminal
 * chirps, rotary detents, a CRT power-on whine — clearly audible mid-band
 * (700–2000Hz), not sub-bass "taste" nobody's laptop speakers can reproduce.
 * Loudness is calibrated against the notify chime (lib/notify.ts): main cues
 * peak around 0.08–0.12, in the same league, so they actually register.
 *
 * Toggle lives in System › Interface (localStorage 'agentos_sound', default on).
 * The notification chime stays separate — it has its own switch and must ring
 * even for users who mute the console.
 */

let ac: AudioContext | null = null
let on = localStorage.getItem('agentos_sound') !== '0' // default on

export function getSoundOn(): boolean {
  return on
}

export function setSoundOn(v: boolean) {
  on = v
  localStorage.setItem('agentos_sound', v ? '1' : '0')
}

/* Sound categories — the master switch rules them all; each category can be
   muted on its own (System › Interface). ui = clicks/nav/knob/drawers,
   alert = confirm/deny/done/fail verdicts, boot = the ROBCO ceremony. */
export type SoundCat = 'ui' | 'alert' | 'boot'
export const SOUND_CATS: { key: SoundCat; label: string; hint: string }[] = [
  { key: 'ui', label: 'CONTROLS', hint: 'buttons · nav · knobs · drawers' },
  { key: 'alert', label: 'VERDICTS', hint: 'approvals · task done/failed' },
  { key: 'boot', label: 'BOOT', hint: 'reactor swell · teletype' },
]

let cats: Record<SoundCat, boolean> = { ui: true, alert: true, boot: true }
try {
  const saved = JSON.parse(localStorage.getItem('agentos_sound_cats') || '{}')
  cats = { ...cats, ...saved }
} catch { /* defaults stand */ }

export function getSoundCats(): Record<SoundCat, boolean> {
  return { ...cats }
}

export function setSoundCat(cat: SoundCat, v: boolean) {
  cats[cat] = v
  localStorage.setItem('agentos_sound_cats', JSON.stringify(cats))
}

function catOn(c: SoundCat): boolean {
  return on && cats[c] !== false
}

function ensure(): AudioContext | null {
  if (!ac) {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AC) ac = new AC()
    } catch {
      /* audio is best-effort */
    }
  }
  return ac
}

// Browsers gate audio behind a user gesture — call from the first pointer/key
// event. (The desktop exe sets --autoplay-policy=no-user-gesture-required, so
// there the boot sequence is audible with no click at all.)
export function primeSound() {
  const ctx = ensure()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
}

type VoiceOpt = {
  type?: OscillatorType
  gain?: number
  cut?: number // lowpass cutoff — tames square/saw edges without killing presence
  glide?: number // exponential pitch target by note end
  when?: number // schedule offset (s)
  attack?: number
  detune?: number // second partial at freq*detune for body (e.g. 2.003 = shimmery octave)
}

function voice(freq: number, dur: number, opt: VoiceOpt = {}) {
  const ctx = ensure()
  if (!on || !ctx || ctx.state !== 'running') return
  try {
    const t = ctx.currentTime + (opt.when || 0)
    const peak = opt.gain ?? 0.08
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(opt.cut ?? 2800, t)
    lp.Q.value = 0.5
    lp.connect(ctx.destination)
    const mk = (f: number, pk: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = opt.type ?? 'sine'
      o.frequency.setValueAtTime(f, t)
      if (opt.glide) o.frequency.exponentialRampToValueAtTime(opt.glide * (f / freq), t + dur)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(pk, t + (opt.attack ?? 0.01))
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      o.connect(g).connect(lp)
      o.start(t)
      o.stop(t + dur + 0.05)
    }
    mk(freq, peak)
    if (opt.detune) mk(freq * opt.detune, peak * 0.4)
  } catch {
    /* best-effort */
  }
}

// Band-passed noise burst = a physical tick/ratchet. Center in the 900–2000Hz
// band so it reads as a crisp mechanical contact on any speaker.
function tick(dur = 0.03, gain = 0.1, center = 1500, when = 0) {
  const ctx = ensure()
  if (!on || !ctx || ctx.state !== 'running') return
  try {
    const t = ctx.currentTime + when
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur))
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.setValueAtTime(center, t)
    bp.Q.value = 1.2
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(bp).connect(g).connect(ctx.destination)
    src.start(t)
  } catch {
    /* best-effort */
  }
}

/* Design rule (learned the hard way): square waves + rising pitch glides read as
   Mario. The vault console is MECHANICAL — filtered-noise clacks, damped low
   thumps, teletype ticks. Tones only where a verdict needs one, low and short. */
export const sfx = {
  /** generic button — relay press: clack + faint low thump */
  click() {
    if (!catOn('ui')) return
    tick(0.035, 0.1, 1100)
    tick(0.02, 0.05, 2100, 0.006)
    voice(190, 0.05, { type: 'sine', gain: 0.05, cut: 600 })
  },
  /** sidebar nav — dull mechanical page ka-chunk, zero melody */
  nav() {
    if (!catOn('ui')) return
    tick(0.04, 0.11, 750)
    tick(0.035, 0.09, 450, 0.055)
    voice(130, 0.1, { type: 'sine', gain: 0.075, cut: 500 })
  },
  /** mode knob — heavy rotary ratchet, three detents + a low seat */
  knob() {
    if (!catOn('ui')) return
    tick(0.03, 0.12, 1700)
    tick(0.03, 0.1, 1200, 0.055)
    tick(0.05, 0.12, 700, 0.11)
    voice(220, 0.08, { type: 'triangle', gain: 0.05, cut: 1500, when: 0.11 })
  },
  /** modal / drawer opens — latch + soft low body */
  open() {
    if (!catOn('ui')) return
    tick(0.04, 0.09, 900)
    voice(210, 0.12, { type: 'sine', gain: 0.06, cut: 750 })
  },
  /** modal / drawer closes — lower latch */
  close() {
    if (!catOn('ui')) return
    tick(0.035, 0.08, 650)
    voice(165, 0.11, { type: 'sine', gain: 0.055, cut: 650 })
  },
  /** approval granted / deploy accepted — terminal ack: two low machine blips */
  confirm() {
    if (!catOn('alert')) return
    voice(440, 0.09, { type: 'sine', gain: 0.09, cut: 1600 })
    voice(587.33, 0.14, { type: 'sine', gain: 0.085, cut: 1600, when: 0.09 })
    tick(0.05, 0.08, 800)
  },
  /** approval denied — vault klaxon buzz */
  deny() {
    if (!catOn('alert')) return
    voice(150, 0.3, { type: 'sawtooth', gain: 0.11, cut: 800, glide: 115 })
    voice(75, 0.3, { type: 'sine', gain: 0.09 })
    tick(0.06, 0.09, 400, 0.02)
  },
  /** a task landed done — one dark service-bell strike, not a jingle */
  done() {
    if (!catOn('alert')) return
    voice(523.25, 0.55, { type: 'sine', gain: 0.09, cut: 5000, detune: 2.72 })
    voice(392, 0.4, { type: 'sine', gain: 0.05, cut: 2000, when: 0.02 })
  },
  /** a task failed — low descending groan + thud */
  fail() {
    if (!catOn('alert')) return
    voice(300, 0.4, { type: 'sawtooth', gain: 0.1, cut: 700, glide: 150 })
    voice(98, 0.35, { type: 'sine', gain: 0.1, when: 0.04 })
    tick(0.09, 0.1, 300, 0.04)
  },
  /** boot log — full typewriter thock (line landings) */
  bootTick() {
    if (!catOn('boot')) return
    tick(0.02, 0.07, 1700)
    tick(0.014, 0.04, 900, 0.01)
  },
  /** boot log — single teletype character tick (rapid-fire safe) */
  type() {
    if (!catOn('boot')) return
    tick(0.016, 0.05, 1600 + Math.random() * 600)
  },
  /** boot power-on — reactor swell with a faint CRT whine underneath */
  power() {
    if (!catOn('boot')) return
    voice(60, 0.9, { type: 'sine', gain: 0.11, attack: 0.25, cut: 600 })
    voice(150, 0.8, { type: 'triangle', gain: 0.07, attack: 0.2, cut: 900 })
    voice(420, 0.8, { type: 'sine', gain: 0.02, glide: 1200, attack: 0.4, cut: 2400 })
    tick(0.3, 0.05, 500, 0.05)
  },
}
