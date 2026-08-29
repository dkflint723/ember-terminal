import { monaco, modelUri } from './monaco'
import { forgetSynced } from './synced'

/**
 * The parking lot for models whose documents have closed.
 *
 * Models deliberately outlive their tabs — reopening a file should keep its
 * undo history, folds and scroll position, and the language server should not
 * see a close-and-reopen for what a person experiences as one editing session.
 * But "outlive" had no horizon: every file ever opened held its buffer for the
 * life of the window, and the language servers held a mirror of each one.
 *
 * So closed documents park here instead, newest over oldest, and the lot has
 * spaces for twenty. Eviction is the one true goodbye: the model is disposed,
 * which is also what makes the client send its didClose — the synchronizer
 * watches models, not tabs, so disposing is the only honest way to tell the
 * server, and the reason closing a tab must NOT send one itself.
 */
const parked = new Map<string, true>()
const SPACES = 20

/**
 * A document closed. `stillOpenElsewhere` is the store's own answer for
 * whether another pane holds the same file — computed by the caller because
 * this module must not reach into the store it is called from.
 */
export function parkModel(filePath: string | null, stillOpenElsewhere: boolean): void {
  if (!filePath || stillOpenElsewhere) return
  // Re-inserted at the back of the queue, however long it was already parked.
  parked.delete(filePath)
  parked.set(filePath, true)

  while (parked.size > SPACES) {
    const oldest = parked.keys().next().value as string
    parked.delete(oldest)
    monaco.editor.getModel(modelUri(oldest))?.dispose()
    forgetSynced(oldest)
  }
}

/** A document opened (or reopened): its model is in use, not parked. */
export function unparkModel(filePath: string | null): void {
  if (filePath) parked.delete(filePath)
}
