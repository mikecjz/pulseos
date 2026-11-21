/**
 * The DSH Web client's active color scheme as a React-subscribable source. The viewer has no theme
 * of its own: it reads `ctx.theme` (`@deepseek-ai/dsh-client-ui-theme`) and follows its
 * `theme/change` event, so a switch in DSH's Appearance settings, or an OS flip while DSH follows the
 * system, re-themes the viewer in place.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** The two palettes the viewer draws with. */
export type ColorScheme = 'light' | 'dark'

/**
 * The scheme of DSH's resolved active theme; a registered third-party theme maps to the base palette it builds on.
 * @param snapshot - DSH theme snapshot.
 * @returns the viewer palette to use.
 */
export function schemeOf(snapshot: Pick<ThemeSnapshot, 'active'>): ColorScheme {
  return snapshot.active.colorScheme
}

/** A subscribable color scheme, shaped for `useSyncExternalStore`. */
export interface SchemeSource {
  getSnapshot(): ColorScheme
  subscribe(listener: () => void): () => void
}

/**
 * Follow DSH's active theme for the lifetime of `ctx`.
 * @param ctx - client context with the `theme` service injected.
 * @returns the scheme source; its listeners are released with `ctx`.
 */
export function followHostTheme(ctx: Context): SchemeSource {
  let scheme = schemeOf(ctx.theme.getTheme())
  const listeners = new Set<() => void>()
  ctx.on('theme/change', (snapshot) => {
    const next = schemeOf(snapshot)
    if (next === scheme) return
    scheme = next
    for (const listener of listeners) listener()
  })
  return {
    getSnapshot: () => scheme,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
