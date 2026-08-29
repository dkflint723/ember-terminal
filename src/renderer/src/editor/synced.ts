/**
 * What each retained editor buffer was last known to match on disk.
 *
 * Monaco models are keyed by file URI and deliberately outlive the panes that
 * showed them, which is what preserves undo history and keeps a language server's
 * view of a document intact. The cost is that a model can be older than the file:
 * reopen something that changed on disk in between and the editor showed the text
 * as it was, then wrote that back over the newer version on the next save.
 *
 * Knowing what the buffer last agreed with is the only way to tell those two cases
 * apart — a buffer the user has edited and a buffer the file has moved on from look
 * exactly alike otherwise, and guessing wrong either throws away someone's work or
 * silently reverts a file.
 *
 * Every place that brings a buffer and a file into agreement records it here: the
 * two save paths, Save All, revert, a reload after an external change, and the
 * write Claude Code makes when a diff is accepted. A path with no entry has never
 * been known to match, which is treated as unsaved work and left alone — so a
 * missing record is merely cautious, while a wrong one loses the file. There is
 * deliberately no way to forget a path: a model is never disposed, and dropping
 * the entry for one would leave the buffer looking edited forever.
 *
 * Keyed by path through the shared normalisation, since Windows hands back the same
 * file with different capitalisation depending on how it was reached — and a buffer
 * keyed one way while the documents that own it are compared another is how one file
 * ends up with two models and a single record describing whichever moved last.
 */
import { pathKey as key } from '@shared/paths'

const synced = new Map<string, string>()

/**
 * Record that a buffer and the file on disk agree.
 *
 * The text should be read back off the model rather than the value handed to it —
 * Monaco normalises line endings, so what a later comparison sees is the model's
 * own text — except after a write, where what reached disk is the truth and the
 * buffer may already have moved on.
 */
export function noteSynced(filePath: string | null, text: string): void {
  if (filePath) synced.set(key(filePath), text)
}

/** What the buffer last agreed with, or undefined if that was never recorded. */
export function lastSynced(filePath: string | null): string | undefined {
  return filePath ? synced.get(key(filePath)) : undefined
}

/** A disposed model's record has nothing left to describe. */
export function forgetSynced(filePath: string | null): void {
  if (filePath) synced.delete(key(filePath))
}
