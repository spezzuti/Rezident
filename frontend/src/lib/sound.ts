/**
 * PIP-OS UI sound engine — the wasteland counterpart to the GRID//OS deck audio.
 * Character: physical and warm — relay thunks, bakelite knob detents, low CRT
 * blooms — not neon chiptune blips (that's the cyberdeck's voice). Every cue is
 * built from voice() (lowpass-tamed tone) + thunk() (band-passed noise contact)
 * so the whole console sounds like one machine.
 *
 * Toggle lives in System › Interface (localStorage 'agentos_sound', default on).
 * The notification chime (lib/notify.ts) stays separate — it has its own toggle
 * and must ring even for users who mute the console clicks.
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

// Browsers gate audio behind a user gesture — call from the first pointer/key event.
export function primeSound() {
  const ctx = ensure()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
}

type VoiceOpt = {
  type?: OscillatorType
  gain?: number
  cut?: number // lowpass cutoff — keep low (≤2600) for the warm vault-console timbre
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
    const peak = opt.gain ?? 0.04
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(opt.cut ?? 2000, t)
    lp.Q.value = 0.5
    lp.connect(ctx.destination)
    const mk = (f: number, pk: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = opt.type ?? 'sine'
      o.frequency.setValueAtTime(f, t)
      if (opt.glide) o.frequency.exponentialRampToValueAtTime(opt.glide * (f / freq), t + dur)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(pk, t + (opt.attack ?? 0.012))
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

// Band-passed noise burst = a physical contact click. Lower center = chunkier.
function thunk(dur = 0.05, gain = 0.05, center = 900, when = 0) {
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
    bp.Q.value = 1.1
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
  /** generic physical button — relay press */
  click() {
    thunk(0.04, 0.055, 820)
    voice(240, 0.055, { type: 'sine', gain: 0.018, cut: 1500 })
  },
  /** sidebar nav — heavier bakelite switch */
  nav() {
    thunk(0.06, 0.065, 540)
    voice(185, 0.09, { type: 'triangle', gain: 0.024, cut: 1300, glide: 150 })
  },
  /** mode knob — rotary detent double-clack */
  knob() {
    thunk(0.03, 0.05, 1100)
    thunk(0.05, 0.08, 600, 0.06)
    voice(150, 0.07, { type: 'triangle', gain: 0.02, cut: 1100, when: 0.06 })
  },
  /** modal / drawer opens — rising warm sweep */
  open() {
    thunk(0.05, 0.04, 700)
    voice(150, 0.15, { type: 'triangle', gain: 0.035, cut: 1600, glide: 330, attack: 0.02, detune: 2.002 })
  },
  /** modal / drawer closes — falling */
  close() {
    voice(320, 0.12, { type: 'triangle', gain: 0.03, cut: 1400, glide: 140 })
  },
  /** approval granted / deploy accepted — warm low triad, vault door yields */
  confirm() {
    thunk(0.07, 0.06, 480)
    ;[196, 261.63, 329.63].forEach((f, i) =>
      voice(f, 0.42, { type: 'triangle', gain: 0.04, cut: 2200, when: i * 0.07, detune: 2.002 }),
    )
  },
  /** approval denied — low klaxon buzz */
  deny() {
    voice(112, 0.3, { type: 'sawtooth', gain: 0.045, cut: 750, glide: 84 })
    voice(56, 0.3, { type: 'sine', gain: 0.035 })
  },
  /** a task landed done — soft two-note ding (gentler than the notify chime) */
  done() {
    voice(392, 0.4, { type: 'sine', gain: 0.038, cut: 2600, detune: 2.003 })
    voice(523.25, 0.5, { type: 'sine', gain: 0.034, cut: 2600, when: 0.12, detune: 2.003 })
  },
  /** a task failed — descending groan + sub thud */
  fail() {
    voice(220, 0.34, { type: 'sawtooth', gain: 0.04, cut: 900, glide: 150 })
    voice(82, 0.3, { type: 'sine', gain: 0.04, when: 0.05 })
    thunk(0.08, 0.05, 300, 0.05)
  },
  /** boot log line tick — CRT typewriter */
  bootTick() {
    thunk(0.02, 0.028, 1400)
  },
  /** boot power-on — reactor hum swell */
  power() {
    voice(50, 0.8, { type: 'sine', gain: 0.055, attack: 0.3, cut: 500 })
    voice(100, 0.7, { type: 'triangle', gain: 0.03, attack: 0.25, cut: 700, detune: 1.5 })
    thunk(0.2, 0.02, 350, 0.02)
  },
}
