import { pathKey } from '@shared/paths'
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
 *
 * Keyed by the file, not by how its path was spelled. The same file arrives
 * spelled differently from different places — a language server hands back
 * lowercase with forward slashes, Explorer does not — and the lot kept each
 * spelling as its own entry while disposing by the file. So a file closed under
 * one spelling and reopened under another left its old entry standing, and when
 * that entry came up for eviction twenty files later it disposed the live buffer:
 * the tab rebuilt itself from disk, and the unsaved edit in it was gone.
 */
const parked = new Map<string, string>()
const SPACES = 20

/**
 * Whether any open document still shows a file. Asked before disposing, as a
 * second line behind the keying above: a model something is showing is never
 * the lot's to throw away. Supplied by the store, which this module must not
 * reach into.
 */
let stillShown: (filePath: string) => boolean = () => false

export function whenAskingIfShown(check: (filePath: string) => boolean): void {
  stillShown = check
}

/**
 * A document closed. `stillOpenElsewhere` is the store's own answer for
 * whether another pane holds the same file — computed by the caller because
 * this module must not reach into the store it is called from.
 */
export function parkModel(filePath: string | null, stillOpenElsewhere: boolean): void {
  if (!filePath || stillOpenElsewhere) return
  // Re-inserted at the back of the queue, however long it was already parked.
  const key = pathKey(filePath)
  parked.delete(key)
  parked.set(key, filePath)

  while (parked.size > SPACES) {
    const [oldestKey, oldest] = parked.entries().next().value as [string, string]
    parked.delete(oldestKey)
    if (stillShown(oldest)) continue
    monaco.editor.getModel(modelUri(oldest))?.dispose()
    forgetSynced(oldest)
  }
}

/** A document opened (or reopened): its model is in use, not parked. */
export function unparkModel(filePath: string | null): void {
  if (filePath) parked.delete(pathKey(filePath))
}
