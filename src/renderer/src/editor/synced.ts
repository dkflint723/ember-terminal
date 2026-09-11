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
import type { FileStamp } from '@shared/types'

const synced = new Map<string, string>()

/*
 * And which version of the file that was.
 *
 * The text says whether the buffer has been edited; this says what the edits sit
 * on top of, which is what a save sends along to be checked against the disk — so
 * a file that changed since is caught at the write, whoever changed it. Kept apart
 * from the text because the two are not always known together: text carried over
 * from the last session agrees with nothing on disk and is still based on a version
 * of it.
 */
const bases = new Map<string, FileStamp | null>()

/**
 * Record that a buffer and the file on disk agree.
 *
 * The text should be read back off the model rather than the value handed to it —
 * Monaco normalises line endings, so what a later comparison sees is the model's
 * own text — except after a write, where what reached disk is the truth and the
 * buffer may already have moved on.
 *
 * The stamp is the version of the file that text is. It is asked for every time
 * rather than kept from before, because a stamp left over from an earlier version
 * would make the next save refuse over a change the buffer already has. Undefined
 * says it is not known, and a save then writes without checking.
 */
export function noteSynced(filePath: string | null, text: string, stamp: FileStamp | undefined): void {
  if (!filePath) return
  synced.set(key(filePath), text)
  if (stamp === undefined) bases.delete(key(filePath))
  else bases.set(key(filePath), stamp)
}

/** Record only what the buffer is based on, for text that does not match it. */
export function noteBase(filePath: string | null, stamp: FileStamp | null | undefined): void {
  if (!filePath) return
  if (stamp === undefined) bases.delete(key(filePath))
  else bases.set(key(filePath), stamp)
}

/** What the buffer last agreed with, or undefined if that was never recorded. */
export function lastSynced(filePath: string | null): string | undefined {
  return filePath ? synced.get(key(filePath)) : undefined
}

/**
 * The version of the file the buffer's text is based on: what a save expects to
 * find on disk. Undefined when that is not known.
 */
export function baseOf(filePath: string | null): FileStamp | null | undefined {
  return filePath ? bases.get(key(filePath)) : undefined
}

/** A disposed model's record has nothing left to describe. */
export function forgetSynced(filePath: string | null): void {
  if (!filePath) return
  synced.delete(key(filePath))
  bases.delete(key(filePath))
}

/*
 * Saves in flight.
 *
 * A save changes the file before the record above can say so — the write lands,
 * then its result comes back — and a look at the disk in between would see a new
 * version the buffer is not based on yet, and call the editor's own save somebody
 * else's change.
 */
const writing = new Map<string, number>()

export function beginWrite(filePath: string): void {
  writing.set(key(filePath), (writing.get(key(filePath)) ?? 0) + 1)
}

export function endWrite(filePath: string): void {
  const left = (writing.get(key(filePath)) ?? 1) - 1
  if (left > 0) writing.set(key(filePath), left)
  else writing.delete(key(filePath))
}

export function isWriting(filePath: string): boolean {
  return writing.has(key(filePath))
}
