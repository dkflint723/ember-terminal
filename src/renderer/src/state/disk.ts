import { useEffect } from 'react'
import { type EditorDocument, useStore } from './store'
import type { FileMark, FileStamp } from '@shared/types'
import { pathKey, samePath } from '@shared/paths'
import { baseOf, isWriting, lastSynced, noteBase, noteSynced } from '../editor/synced'

/**
 * Keeping open editors in line with the files they show.
 *
 * Nothing used to notice a file changing on disk. Claude Code in the next pane, a
 * branch switch, a pull, another program: the editor went on showing the old text
 * with nothing to say it was old, and the next save put it back. The save now
 * refuses to write over a version it has not seen, and that is the guarantee; this
 * is what makes the refusal rare. Each open file is looked at on a timer while the
 * window is visible, whenever the window gets focus back, and at once after
 * Ember's own git actions — and each buffer is dealt with by whether it holds work
 * of the person's own:
 *
 * - untouched since it last matched the disk: it follows the file, as one undoable
 *   edit, so what someone else wrote appears where it is being read;
 * - edited: nothing in it is touched, and the conflict bar says the file moved on
 *   now, rather than at the save;
 * - its file gone: kept as the only copy, marked unsaved, and the bar says so;
 * - its file back as it was — a stash popped, a branch switched back: the bar goes.
 *
 * Most files are only stat'ed. A different time or size is followed up by reading
 * the file, because only the bytes say whether it really changed; the same time and
 * size since the last look is taken as unchanged, except by a thorough check, which
 * reads everything it is asked about. What a stat misses the save still catches.
 */

/** How often open files are looked at while the window is visible. */
const POLL_MS = 2000

/**
 * What each file looked like the last time it was read, so the next look can skip
 * one that has not been touched since — including one whose change has already
 * been told to its editor, which would otherwise be read again on every tick.
 */
const lastSeen = new Map<string, FileMark>()

/*
 * One pass at a time, in order. A timer, a focus and a git action can all ask
 * within a moment, and two passes reading and replacing the same buffers would race
 * each other; a request made during a pass runs after it, so a caller that awaits a
 * check has had its files looked at by the time it goes on.
 */
let queue: Promise<void> = Promise.resolve()
let pending = 0

export function checkDisk(paths?: string[], opts: { thorough?: boolean } = {}): Promise<void> {
  pending++
  const run = queue
    .then(() => pass(paths, opts.thorough === true))
    .catch(() => {
      // A failed look is only a missed one; the next tick looks again.
    })
    .finally(() => {
      pending--
    })
  queue = run
  return run
}

function sameMark(a: FileMark | undefined, b: FileMark): boolean {
  if (a === undefined || typeof a === 'string' || typeof b === 'string') return a === b
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/**
 * The version the buffer on this file is based on. A recorded `null` — based on no
 * file at all — is an answer, and only a missing record falls back to the version
 * the document last read.
 */
function baseFor(filePath: string, docs: EditorDocument[]): FileStamp | null | undefined {
  const recorded = baseOf(filePath)
  return recorded !== undefined ? recorded : docs[0]?.stamp
}

/** Every document showing this file, as the store has them now. */
function documentsAt(filePath: string): EditorDocument[] {
  const found: EditorDocument[] = []
  for (const pane of Object.values(useStore.getState().panes)) {
    if (pane.kind !== 'editor') continue
    for (const doc of pane.documents) if (samePath(doc.filePath, filePath)) found.push(doc)
  }
  return found
}

async function pass(paths: string[] | undefined, thorough: boolean): Promise<void> {
  const { modelUri, monaco } = await import('../editor/monaco')
  const { replaceBuffer } = await import('../editor/reload')

  // Each open file once, however many panes are showing it.
  const wanted = paths ? new Set(paths.map(pathKey)) : null
  const open = new Map<string, string>()
  for (const pane of Object.values(useStore.getState().panes)) {
    if (pane.kind !== 'editor') continue
    for (const doc of pane.documents) {
      if (!doc.filePath) continue
      const k = pathKey(doc.filePath)
      if (wanted && !wanted.has(k)) continue
      if (!open.has(k)) open.set(k, doc.filePath)
    }
  }
  if (open.size === 0) return
  const files = [...open.values()]
  const marks = await window.ember.markFiles(files)

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    const k = pathKey(filePath)
    const mark = marks[i]
    // Something there that could not be looked at is not a deletion, and a file
    // being saved right now is about to be the buffer's own version.
    if (mark === undefined || mark === 'unreadable' || isWriting(filePath)) continue
    const docs = documentsAt(filePath)
    if (docs.length === 0) continue
    const base = baseFor(filePath, docs)

    if (mark === 'missing') {
      lastSeen.set(k, mark)
      // A buffer based on no file at all expects exactly this.
      if (base === null) continue
      if (docs.every((d) => d.conflict === 'deleted' && d.dirty)) continue
      useStore.getState().patchDocumentsAt(filePath, { conflict: 'deleted', dirty: true })
      continue
    }

    // Untouched since the last look — or, never looked at, since the version the
    // buffer is based on.
    const seen = lastSeen.get(k) ?? (base ? { mtimeMs: base.mtimeMs, size: base.size } : undefined)
    if (!thorough && sameMark(seen, mark)) continue

    const res = await window.ember.readFile(filePath)
    // Turned binary, or too big to edit: the buffer is left as it is.
    if (!res.ok) continue
    lastSeen.set(k, mark)

    /*
     * Everything from here is decided on the state as it is after the read, not as
     * it was before it: a tab can close, a save can start and a key can be pressed
     * while the file is being read, and a buffer judged untouched a round trip ago
     * may not be now. There is no await between this judgement and acting on it.
     */
    if (isWriting(filePath)) continue
    const now = documentsAt(filePath)
    if (now.length === 0) continue
    const agreedBase = baseFor(filePath, now)
    const sameAsBase = agreedBase
      ? res.stamp.hash === agreedBase.hash
      : agreedBase === undefined && res.content === now[0].savedContent
    const model = monaco.editor.getModel(modelUri(filePath))
    const agreed = lastSynced(filePath)
    const edited = model
      ? agreed === undefined || model.getValue() !== agreed
      : now.some((d) => d.dirty)

    if (sameAsBase) {
      // The version the buffer is based on: touched without changing, or put back
      // as it was. The newer time is kept so the next look can skip reading it, and
      // a conflict that no longer exists goes.
      noteBase(filePath, res.stamp)
      if (now.some((d) => d.conflict)) {
        const text = model?.getValue()
        useStore.getState().patchDocumentsAt(filePath, (d) => ({
          conflict: null,
          savedContent: res.content,
          eol: res.eol,
          stamp: res.stamp,
          encoding: res.encoding,
          dirty: text === undefined ? d.dirty : text !== res.content
        }))
      }
      continue
    }

    if (!edited) {
      /*
       * Nothing of the person's own in it, so it follows the file.
       *
       * The document first, then the buffer: dirtiness is the buffer compared with
       * the document's copy of the disk, and the other order would see the new text
       * against the old copy, call it an edit, and start an auto-save for it.
       */
      useStore.getState().patchDocumentsAt(filePath, {
        savedContent: res.content,
        eol: res.eol,
        stamp: res.stamp,
        encoding: res.encoding,
        dirty: false,
        conflict: null
      })
      if (model) {
        replaceBuffer(model, res.content, res.eol)
        noteSynced(filePath, model.getValue(), res.stamp)
      } else {
        noteBase(filePath, res.stamp)
      }
      continue
    }

    // Work of their own, on top of a version that is no longer there. The buffer
    // is not touched; the document's copy of the disk is, so dirtiness and the
    // comparison are measured against what is really there.
    useStore.getState().patchDocumentsAt(filePath, {
      savedContent: res.content,
      eol: res.eol,
      stamp: res.stamp,
      encoding: res.encoding,
      dirty: true,
      conflict: 'changed'
    })
  }
}

/**
 * Look at the open files on a timer while the window is visible, and the moment it
 * comes back into view or focus. Mounted once, at the app root.
 */
export function useDiskChecking(): void {
  useEffect(() => {
    const look = (): void => {
      if (document.visibilityState !== 'visible') return
      // A pass still running is still looking; stacking another behind it every
      // tick would only queue the same work.
      if (pending > 0) return
      void checkDisk()
    }
    const timer = window.setInterval(look, POLL_MS)
    // Coming back to the window is when a change made elsewhere is most likely, and
    // it should be there on arrival rather than up to a tick later.
    window.addEventListener('focus', look)
    document.addEventListener('visibilitychange', look)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', look)
      document.removeEventListener('visibilitychange', look)
    }
  }, [])
}
