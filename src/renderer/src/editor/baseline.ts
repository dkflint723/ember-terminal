import type * as MonacoModule from './monaco'

type Model = MonacoModule.monaco.editor.ITextModel

/**
 * Whether a buffer differs from what is on disk, without reading the buffer.
 *
 * Every keystroke used to answer this with `editor.getValue() !== savedContent`,
 * which builds the whole file as a string — sixteen megabytes of string per key in
 * the largest file the editor will open. Monaco already counts: its alternative
 * version id moves with every edit and moves back when an edit is undone. So the
 * version at which the buffer last matched the disk is written down, and the
 * question becomes a comparison of two numbers.
 *
 * Kept against the saved text it was taken for. When `savedContent` changes — a
 * save, a reload from disk — the old version means nothing, and the answer is
 * worked out the long way once, which is also when a new baseline can be taken.
 * A buffer that is already different from a text it has never matched (a restored
 * unsaved buffer) goes the long way until it first matches: exactly what every
 * buffer did before, and no worse.
 */
const baselines = new WeakMap<Model, { version: number; saved: string }>()

/** The buffer now matches `saved`; remember the version at which it does. */
export function markClean(model: Model, saved: string): void {
  baselines.set(model, { version: model.getAlternativeVersionId(), saved })
}

export function isModified(model: Model, saved: string): boolean {
  const baseline = baselines.get(model)
  if (baseline && baseline.saved === saved) {
    if (model.getAlternativeVersionId() === baseline.version) return false
    /*
     * A different version is not proof of a different text. Undo and redo back to
     * the saved state do not always land on the version written down — a change
     * followed from disk and then undone and redone came back unsaved while the
     * buffer matched the file exactly. So when the length agrees, which an edit
     * that changed anything nearly always breaks, the text is compared and the
     * baseline taken afresh; a different length is still answered by the numbers.
     */
    if (model.getValueLength() !== saved.length) return true
  }
  const modified = model.getValue() !== saved
  if (!modified) markClean(model, saved)
  return modified
}
