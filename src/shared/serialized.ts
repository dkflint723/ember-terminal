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
 * is remembered, and runs once, straight after. However many arrive meanwhile for
 * the same key, one more run covers them all.
 *
 * Each request is answered by the run that covers it, and by nothing else. The first
 * version handed every caller the promise for the whole queue, which settled only
 * when the queue was empty — and on a repository whose status takes longer than the
 * poll interval the poll refills it on every read, so a Commit that awaited its
 * refresh waited for as long as the window was visible, with its buttons disabled.
 * A failure is likewise told only to the requests that run was for: a request made
 * during a read that then fails is still read, and is not blamed for it.
 *
 * Keyed, for status read per directory: each key asked for while busy is run once,
 * in the order first asked, one at a time.
 */
export interface Serialized<K> {
  /** Run for `key` once whatever is under way has finished; resolves after that run. */
  (key: K): Promise<void>
  /**
   * Whether a run is under way or waiting. A poll asks this and skips its turn: it is
   * not reacting to a change, so a read already out answers it, and queuing another
   * behind it would keep git running back to back on exactly the repository slow
   * enough to be a problem.
   */
  busy(): boolean
}

interface Waiters {
  promise: Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
}

export function serialized<K>(run: (key: K) => Promise<void>): Serialized<K> {
  const pending = new Map<K, Waiters>()
  // Set before `run` is first called, so a run that asks again before its first
  // await queues behind itself rather than starting a second run beside it.
  let running = false

  const drain = async (): Promise<void> => {
    running = true
    try {
      while (pending.size > 0) {
        const [key, waiters] = pending.entries().next().value as [K, Waiters]
        pending.delete(key)
        try {
          await run(key)
          waiters.resolve()
        } catch (err) {
          waiters.reject(err)
        }
      }
    } finally {
      running = false
    }
  }

  const request = ((key: K): Promise<void> => {
    let waiters = pending.get(key)
    if (!waiters) {
      let resolve!: () => void
      let reject!: (err: unknown) => void
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      waiters = { promise, resolve, reject }
      pending.set(key, waiters)
    }
    if (!running) void drain()
    return waiters.promise
  }) as Serialized<K>
  request.busy = () => running || pending.size > 0
  return request
}
