import { useIsHandset, useStore } from '../store'

/**
 * Handset-aware guard for master-only controls (honest UX for paired devices).
 * `locked` — true when this session holds a device token; render the control in
 * its locked look (🔒 prefix / dimmed). `guard(fn)` — returns a click handler
 * that runs `fn` normally for the master console, but on a handset raises the
 * MASTER CLEARANCE toast instead of a doomed request. Tooltips don't exist on
 * touch, so the tap itself is the explanation; any call site not wrapped still
 * gets the same toast from the api.ts 403 backstop.
 */
export function useMasterGuard() {
  const locked = useIsHandset()
  function guard<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A): void => {
      if (locked) {
        useStore.getState().pushForbidden('Master token required')
        return
      }
      void fn(...args)
    }
  }
  return { locked, guard }
}

/** Label helper: prefixes the locked glyph so a handset sees the state at a glance. */
export function lockLabel(locked: boolean, label: string): string {
  return locked ? `🔒 ${label}` : label
}
