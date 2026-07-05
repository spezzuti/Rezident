import { StatTile, CountUp } from 'agentos-frontend'

const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, maxWidth: 460, padding: 8 }

export const TelemetryGrid = () => (
  <div style={grid}>
    <StatTile label="Caps spent today (~est)" color="var(--sec-sched)">
      <CountUp value={1.284} prefix="$" decimals={3} />
    </StatTile>
    <StatTile label="Tokens today" color="var(--sec-comms)">
      <CountUp value={412.6} decimals={1} />
      <span style={{ fontSize: 14, color: 'var(--color-ink-dim)' }}>k</span>
    </StatTile>
    <StatTile label="Live burn" active color="var(--sec-pipes)">
      <CountUp value={0.318} prefix="$" decimals={3} />
    </StatTile>
    <StatTile label="Active agents" color="var(--color-accent)">
      <CountUp value={3} />
    </StatTile>
  </div>
)

export const SingleMetric = () => (
  <div style={{ maxWidth: 240, padding: 8 }}>
    <StatTile label="Week total" color="var(--sec-memory)">
      <CountUp value={14.92} prefix="$" decimals={2} />
    </StatTile>
  </div>
)
