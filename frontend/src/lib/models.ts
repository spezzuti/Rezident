/** Display designations for model ids. Crew wear short designations — the crew
 *  grammar is "HAIKU", "SONNET", "SOL" — never vendor-versioned ids. The full id
 *  (e.g. gpt-5.6-sol) stays in the DB/config where the CLI needs it verbatim. */

const GPT_ID = /^gpt-([\d.]+)-([a-z]+)$/i

/** "gpt-5.6-sol" -> "sol"; anything unrecognized passes through untouched. */
export function modelShort(m: string): string {
  const g = GPT_ID.exec(m)
  return g ? g[2] : m
}

/** "gpt-5.6-sol" -> "SOL 5.6" — name-plus-version, matching "HAIKU 4.5". */
export function modelDesignation(m: string): string {
  const g = GPT_ID.exec(m)
  return g ? `${g[2]} ${g[1]}`.toUpperCase() : m.toUpperCase()
}
