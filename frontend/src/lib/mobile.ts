import { useEffect, useState } from 'react'

/* Phone-layout switch for PIP-OS. The views use inline styles throughout, so
   responsiveness is a JS branch, not a media query: `useIsMobile()` re-renders
   on viewport crossings and views flip their fixed grids to single-column.
   GRID//OS is deliberately desktop-first — the deck bezel scales, but a
   windowed desktop metaphor has no honest phone form. */
export const MOBILE_BP = 880

export function useIsMobile(bp: number = MOBILE_BP): boolean {
  const [mobile, setMobile] = useState(() => {
    try { return window.matchMedia(`(max-width: ${bp}px)`).matches } catch { return false }
  })
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp}px)`)
    const fn = () => setMobile(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [bp])
  return mobile
}
