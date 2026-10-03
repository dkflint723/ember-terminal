/**
 * Two small rules for keeping asynchronous work apart, pure so they are tested
 * directly (test-single-flight.mjs): the update flow uses both.
 */

/**
 * At most one run at a time: a call made while one is in flight gets that run's
 * promise, and the next call after it settles — fulfilled or rejected — starts anew.
 */
export function singleFlight<T>(run: () => Promise<T>): { (): Promise<T>; readonly inFlight: Promise<T> | null } {
  let current: Promise<T> | null = null
  const call = (): Promise<T> => {
    if (!current) {
      // A run that throws before it is a promise leaves nothing in flight.
      const flight: Promise<T> = run().finally(() => {
        if (current === flight) current = null
      })
      current = flight
    }
    return current
  }
  Object.defineProperty(call, 'inFlight', { get: () => current })
  return call as { (): Promise<T>; readonly inFlight: Promise<T> | null }
}

/**
 * One after another, in the order given: each task starts when the one before it
 * has settled, and one that fails does not stop the ones after it.
 */
export function inOrder(): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (task) => {
    const next = tail.then(task).catch(() => {})
    tail = next
    return next
  }
}
