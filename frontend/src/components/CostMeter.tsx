import { useEffect, useRef, useState } from 'react'

/** Animated count-up number (rAF tween, respects prefers-reduced-motion). */
export function CountUp({ value, prefix = '', decimals = 0 }: { value: number; prefix?: string; decimals?: number }) {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(value)

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      setDisplay(value)
      return
    }
    const from = fromRef.current
    const start = performance.now()
    const dur = 500
    let raf: number
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(from + (value - from) * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return <span>{prefix}{display.toFixed(decimals)}</span>
}

export function StatTile({ label, children, active = false }: { label: string; children: React.ReactNode; active?: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-edge bg-panel px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-widest text-ink-dim">{label}</div>
      <div className="mt-1 font-mono text-xl text-ink">{children}</div>
      {active && <div className="shimmer-bar absolute inset-x-0 bottom-0 h-0.5" />}
    </div>
  )
}
