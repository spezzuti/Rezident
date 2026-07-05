import { Ambient } from 'agentos-frontend'

/** Ambient is a page-atmosphere wash: absolutely positioned at the top of a
 * relatively-positioned page container, behind the content. */
function Page({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ position: 'relative', overflow: 'hidden', height: 170, flex: 1, minWidth: 180, border: '1px solid var(--color-edge)', borderRadius: 4, background: 'var(--color-bg)' }}>
      <Ambient color={color} />
      <div style={{ padding: 14, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase', color }}>
        [ {label} ]
      </div>
      <div style={{ padding: '0 14px', fontSize: 12, color: 'var(--color-ink-dim)' }}>
        page content sits above the wash
      </div>
    </div>
  )
}

export const SectionAtmospheres = () => (
  <div style={{ display: 'flex', gap: 12, padding: 8 }}>
    <Page color="var(--sec-console)" label="console" />
    <Page color="var(--sec-pipes)" label="pipelines" />
    <Page color="var(--sec-dreams)" label="simulations" />
  </div>
)
