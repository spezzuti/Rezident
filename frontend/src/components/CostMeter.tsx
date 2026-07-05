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

export function StatTile({
  label, children, active = false, color = '#7fc8ff',
}: { label: string; children: React.ReactNode; active?: boolean; color?: string }) {
  return (
    <div className="glass relative overflow-hidden px-4 py-3" style={{ boxShadow: `inset 0 1px 0 rgba(226,232,240,0.04), 0 0 18px ${color}18` }}>
      <div className="hud-label" style={{ color: `${color}bb` }}>{label}</div>
      <div className="metric mt-1 text-2xl" style={{ color, textShadow: `0 0 26px ${color}44` }}>{children}</div>
      {active && (
        <div className="absolute inset-x-0 bottom-0 h-0.5"
             style={{ background: `linear-gradient(90deg, transparent, ${color}88, transparent)`, backgroundSize: '200% 100%', animation: 'shimmer 1.8s linear infinite' }} />
      )}
    </div>
  )
}
