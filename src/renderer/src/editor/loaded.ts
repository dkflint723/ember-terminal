import { useSyncExternalStore } from 'react'
import type * as MonacoModule from './monaco'

/**
 * Monaco, for code that must not be the reason it loads.
 *
 * Monaco is most of the renderer's weight — it made the entry chunk 9.5 MB — and
 * a terminal-only session never draws an editor. It was in the startup bundle
 * anyway, because a chain of static imports reached it: the store through the
 * model pool, the status bar, the problems badge, the Claude panel. Each of them
 * only ever asks about models or markers, and there are none of either until
 * something has loaded Monaco to make them. So they ask here, and get nothing
 * until then.
 *
 * Only a type is imported, which is erased. `monaco.ts` announces itself when it
 * is evaluated, however it was reached — a lazy pane importing it directly counts
 * as much as `loadMonaco()` — so nothing that loads it has to remember to say so.
 */
type Monaco = typeof MonacoModule

let loaded: Monaco | null = null
const listeners = new Set<() => void>()

/** Called once, by monaco.ts, as it finishes evaluating. */
export function announceMonaco(module: Monaco): void {
  loaded = module
  for (const listener of listeners) listener()
}

/** Monaco if something has already loaded it; null if not, which means no models exist. */
export function monacoIfLoaded(): Monaco | null {
  return loaded
}

/** Load it now, or hand back the copy already here. */
export function loadMonaco(): Promise<Monaco> {
  return loaded ? Promise.resolve(loaded) : import('./monaco')
}

/** Run once Monaco is here — at once if it already is. Returns an unsubscribe. */
export function whenMonaco(run: (module: Monaco) => void): () => void {
  if (loaded) {
    run(loaded)
    return () => {}
  }
  const once = (): void => {
    listeners.delete(once)
    if (loaded) run(loaded)
  }
  listeners.add(once)
  return () => listeners.delete(once)
}

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

/** Monaco for a component: null until it loads, and a re-render when it does. */
export function useMonaco(): Monaco | null {
  return useSyncExternalStore(subscribe, monacoIfLoaded)
}
