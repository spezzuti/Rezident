# design-sync notes — AgenticOS

- This repo is an APP, not a packaged DS. The DS surface is `frontend/src/ds-entry.ts` (deliberate entry: 7 components + DSProvider); never point `--entry` at `src/main.tsx` (it boots the whole app on import).
- Converter invocation (repo root): `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules frontend/node_modules --out ./ds-bundle` (entry comes from cfg.entry).
- CSS is compiled Tailwind v4: `cfg.buildCmd` (`npm run build && npm run ds:css` in `frontend/`) produces the stable `frontend/dist/ds-styles.css` (copies the hashed vite asset). **Always re-run it after theme/source changes before the converter** — cssEntry points at that copy.
- Compiled Tailwind contains ONLY app-used utility classes — preview glue and conventions must use inline styles + CSS vars, never invented utility classes.
- `DSProvider` (frontend/src/ds-provider.tsx) wraps previews in a MemoryRouter — TaskCard/NewTaskModal throw without router context.
- NewTaskModal renders a `position: fixed` overlay; its preview contains it with a `transform: translateZ(0)` wrapper. It also fetches `/api/profiles` on mount — fails silently at design time, agent-picker row simply absent.
- Playwright: cached chromium build 1208 → playwright@1.58.0 (pinned in .ds-sync install). Cache at `%LOCALAPPDATA%\ms-playwright`.
- Grade files must be BOM-free JSON — PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM that package-capture silently rejects (grades show as pending). Write them with node.

## Known render warns
- `[FONT_MISSING] "Cascadia Code"` — accepted by design: user chose to bundle Inter + JetBrains Mono (SIL OFL, in `frontend/dsfonts/`); the mono stack intentionally falls through Cascadia → JetBrains Mono.

## Re-sync risks
- `frontend/dist/ds-styles.css` goes stale silently if `cfg.buildCmd` isn't re-run before the converter — the bundle would ship an old theme.
- TaskCard preview inlines Task-shaped fixture objects; if the `Task` type gains required fields, the preview `.tsx` files need updating (build will fail loudly on TS, which is the desired signal).
- Theme work is ongoing (wasteland default + cyber variant); any token renames in `frontend/src/index.css` invalidate the conventions header vocabulary — re-run its validation grep on re-sync.
- Fonts were fetched from rsms.me / JetBrains GitHub at sync time; files are committed in `frontend/dsfonts/`, so no network needed on re-sync.
