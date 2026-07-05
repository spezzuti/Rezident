import { CountUp } from 'agentos-frontend'

const chip = (color: string): React.CSSProperties => ({
  fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 700, color,
  padding: '14px 22px', background: 'var(--color-bg)', borderRadius: 4,
  border: '1px solid var(--color-edge)', display: 'inline-block',
})

/** Animated count-up number (rAF tween). Used inside StatTile metrics. */
export const Currency = () => (
  <div style={chip('var(--color-accent)')}>
    <CountUp value={1.284} prefix="$" decimals={3} />
  </div>
)

export const WholeNumber = () => (
  <div style={chip('var(--color-ok)')}>
    <CountUp value={412} />
  </div>
)
