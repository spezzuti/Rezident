/** Per-page ambient glow: a soft radial wash in the section's accent color,
 * so each page has its own atmosphere instead of a uniform blue. */
export default function Ambient({ color }: { color: string }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-96"
      style={{
        background: `radial-gradient(ellipse 70% 100% at 50% -30%, ${color}1f, transparent 70%)`,
      }}
    />
  )
}
