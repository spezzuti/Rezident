# AgentOS conventions (read before building)

AgentOS is a dark, Fallout-inspired "Pip-OS" command-console system. Every design is dark-first: set the page background to `var(--color-bg)` (near-black brown) — components are illegible on white.

## Setup

- **Wrap the app in `DSProvider`** (exported from the bundle). `TaskCard` and `NewTaskModal` render router links and **throw without it**.
- Optional page atmosphere: `.os-backdrop` (fixed, z -2, grid + dust) as the first child of the page; `<Ambient color="var(--sec-console)"/>` inside any `position: relative` page container for a section-colored top wash.
- Two themes ship: default wasteland, and `<html data-theme="cyber">` for the neon-green Hackers variant. All tokens swap automatically — never hardcode hexes.

## Styling idiom: CSS variables + a small fixed utility vocabulary

The stylesheet is compiled Tailwind — **only the classes below and the ones in shipped component markup exist; do not invent other utility classes.** For your own layout glue, use inline styles with the tokens.

Core tokens: `--color-bg`, `--color-panel`, `--color-panel-2`, `--color-input`, `--color-edge`, `--color-ink`, `--color-ink-2`, `--color-ink-dim`, `--color-ink-dimmer`, `--color-accent` (amber), `--color-gold`, `--color-ok` (pip green), `--color-warn`, `--color-err`, `--color-violet`, `--font-mono`, `--panel-radius`.

Section accents (one hue per app area): `--sec-console`, `--sec-board`, `--sec-comms`, `--sec-pipes`, `--sec-sched`, `--sec-memory`, `--sec-companions`, `--sec-dreams`, `--sec-vault`, `--sec-system`.

Alpha idiom: `color-mix(in srgb, var(--color-accent) 27%, transparent)` — never hex-suffix a var.

Reusable classes: `.glass` (panel box), `.glass-bright` (accented panel), `.hud-label` (mono uppercase bracketed section label), `.hud-corner` (corner brackets), `.fo-tab` (inverse-video Pip-Boy tab strip), `.neon-divider`, `.neon-text`, `.metric` (big mono number), `.btn-glow` / `.focus-glow` (themed glows; set `--glow-c` inline to a section color), `.event-in` (fade-slide entrance), `.dot-running` (pulse), `.card-running` / `.card-awaiting` / `.card-verifying` (status border glows), `.shimmer-bar`, `.stream-cursor`, `.ticker-track`, `.scanlines`, `.os-backdrop`.

## Where the truth lives

Read `styles.css` → `_ds_bundle.css` (full compiled theme incl. both theme blocks) before styling anything; per-component API is each `components/general/<Name>/<Name>.d.ts` with usage in `<Name>.prompt.md`.

## Idiomatic snippet

```tsx
<DSProvider>
  <div style={{ position: 'relative', minHeight: '100vh', background: 'var(--color-bg)', color: 'var(--color-ink)' }}>
    <Ambient color="var(--sec-console)" />
    <div className="hud-label" style={{ padding: 16 }}>Overseer Console</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 16 }}>
      <StatTile label="Caps spent today" color="var(--sec-sched)"><CountUp value={1.28} prefix="$" decimals={2} /></StatTile>
      <div className="glass" style={{ padding: 12 }}>
        <StatusPill status="running" />
      </div>
    </div>
  </div>
</DSProvider>
```
