/**
 * One run at a time, and no request lost.
 *
 * Git status was guarded by a flag that dropped any request made while a read was
 * under way, so a slow repository never had two `git status` processes stacked on
 * it. But the read in flight may have started before the change being asked about —
 * a merge begun in the terminal, a `cd` into a repository — and it published the old
 * state while the request that would have seen the new one was thrown away, leaving
 * the next poll, up to three seconds later, to catch up. Pressing Refresh could do
 * nothing at all.
 *
 * This keeps the guard and fixes the loss: a request made while a run is under way
 * is remembered, and runs once, straight after. However many arrive meanwhile, one
 * more run covers them all. The promise a caller gets resolves only when a run that
 * started after its request has finished, so awaiting a refresh means the answer is
 * at least as new as the question.
 *
 * Keyed, for status read per directory: each key asked for while busy is run once,
 * in the order first asked, one at a time.
 */
export function serialized<K>(run: (key: K) => Promise<void>): (key: K) => Promise<void> {
  const pending = new Set<K>()
  let draining: Promise<void> | null = null

  const drain = async (): Promise<void> => {
    try {
      while (pending.size > 0) {
        const key = pending.values().next().value as K
        pending.delete(key)
        await run(key)
      }
    } finally {
      draining = null
    }
  }

  return (key: K): Promise<void> => {
    pending.add(key)
    if (!draining) draining = drain()
    return draining
  }
}
