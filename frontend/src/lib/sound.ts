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

export const sfx = {
  /** generic button — crisp Pip-Boy select: ratchet tick + short terminal chirp */
  click() {
    tick(0.03, 0.1, 1500)
    voice(1050, 0.05, { type: 'square', gain: 0.045, cut: 2400 })
  },
  /** sidebar nav — tab-switch: double tick + rising chirp */
  nav() {
    tick(0.035, 0.11, 1300)
    tick(0.03, 0.07, 900, 0.045)
    voice(740, 0.08, { type: 'square', gain: 0.055, cut: 2600, glide: 990 })
  },
  /** mode knob — heavy rotary ratchet, three detents + a low seat */
  knob() {
    tick(0.03, 0.12, 1700)
    tick(0.03, 0.1, 1200, 0.055)
    tick(0.05, 0.12, 700, 0.11)
    voice(220, 0.08, { type: 'triangle', gain: 0.05, cut: 1500, when: 0.11 })
  },
  /** modal / drawer opens — rising sweep with a latch tick */
  open() {
    tick(0.04, 0.08, 1200)
    voice(320, 0.16, { type: 'triangle', gain: 0.09, cut: 2600, glide: 640, attack: 0.015, detune: 2.002 })
  },
  /** modal / drawer closes — falling */
  close() {
    tick(0.035, 0.07, 900)
    voice(620, 0.14, { type: 'triangle', gain: 0.08, cut: 2200, glide: 280 })
  },
  /** approval granted / deploy accepted — bright Pip-Boy double-beep over a warm base */
  confirm() {
    voice(880, 0.12, { type: 'square', gain: 0.08, cut: 3200 })
    voice(1174.66, 0.22, { type: 'square', gain: 0.075, cut: 3400, when: 0.09, detune: 2.003 })
    voice(196, 0.3, { type: 'triangle', gain: 0.05, cut: 1400, when: 0.02 })
    tick(0.05, 0.08, 800)
  },
  /** approval denied — vault klaxon buzz */
  deny() {
    voice(160, 0.34, { type: 'sawtooth', gain: 0.11, cut: 900, glide: 118 })
    voice(80, 0.34, { type: 'sine', gain: 0.09 })
    tick(0.06, 0.09, 400, 0.02)
  },
  /** a task landed done — clear two-note ding-dong */
  done() {
    voice(784, 0.35, { type: 'sine', gain: 0.1, cut: 3400, detune: 2.004 })
    voice(1046.5, 0.5, { type: 'sine', gain: 0.09, cut: 3600, when: 0.13, detune: 2.004 })
  },
  /** a task failed — descending womp + thud */
  fail() {
    voice(392, 0.4, { type: 'sawtooth', gain: 0.1, cut: 1200, glide: 170 })
    voice(98, 0.35, { type: 'sine', gain: 0.1, when: 0.04 })
    tick(0.09, 0.1, 300, 0.04)
  },
  /** boot log line — audible terminal keystroke */
  bootTick() {
    tick(0.025, 0.085, 1900)
  },
  /** boot power-on — reactor swell + rising CRT whine you can actually hear */
  power() {
    voice(60, 0.9, { type: 'sine', gain: 0.11, attack: 0.25, cut: 600 })
    voice(150, 0.8, { type: 'triangle', gain: 0.07, attack: 0.2, cut: 900 })
    voice(520, 0.7, { type: 'sine', gain: 0.035, glide: 1900, attack: 0.35, cut: 3000 })
    tick(0.3, 0.05, 500, 0.05)
  },
}
