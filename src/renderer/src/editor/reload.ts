import { monaco } from './monaco'

/**
 * Bring a buffer to new text as one undoable edit, touching only the part that
 * differs.
 *
 * `setValue` does the same job in a line and takes the undo history, the caret and
 * the scroll position with it — and a file reloaded underneath someone reading it,
 * or put back to the disk's version from a conflict, is exactly when those matter.
 * Replacing only the stretch between the common beginning and the common end keeps
 * the caret where it was unless the change was under it, and Ctrl+Z brings back
 * what the buffer held.
 *
 * The line endings go first, so the text is taken in on the file's own, and as an
 * undo step of their own. In one step with the text, redo breaks: Monaco replays
 * an edit at offsets counted in the line endings it was made in, but before it
 * puts those line endings back — so when a reload had changed them, undo then redo
 * put the text a character early for every line above it, and left the buffer
 * garbled and unsaved (seen on a CRLF file reloaded as LF). Apart, each step is
 * replayed in the line endings it was recorded in. Undoing a reload that also
 * changed them takes a second Ctrl+Z, for a change nobody can see.
 */
export function replaceBuffer(
  model: monaco.editor.ITextModel,
  text: string,
  eol: 'lf' | 'crlf'
): void {
  const sequence =
    eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF
  model.pushStackElement()
  if (model.getEndOfLineSequence() !== sequence) {
    model.pushEOL(sequence)
    model.pushStackElement()
  }

  // Compared in the model's own line endings, since that is how it will hold them.
  const next = text.replace(/\r\n|\r|\n/g, model.getEOL())
  const now = model.getValue()
  if (now !== next) {
    let start = 0
    const shortest = Math.min(now.length, next.length)
    while (start < shortest && now.charCodeAt(start) === next.charCodeAt(start)) start++
    let endNow = now.length
    let endNext = next.length
    while (endNow > start && endNext > start && now.charCodeAt(endNow - 1) === next.charCodeAt(endNext - 1)) {
      endNow--
      endNext--
    }
    // Never cut between the halves of a surrogate pair: the kept and replaced
    // stretches have to be whole characters, or the join is two broken ones.
    if (start > 0 && isHighSurrogate(now.charCodeAt(start - 1))) start--
    if (endNow < now.length && isLowSurrogate(now.charCodeAt(endNow))) {
      endNow++
      endNext++
    }
    model.pushEditOperations(
      [],
      [
        {
          range: monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(endNow)),
          text: next.slice(start, endNext)
        }
      ],
      () => null
    )
    // Belt and braces: whatever the arithmetic above missed, the buffer ends up
    // holding exactly the text, still as one undo step.
    if (model.getValue() !== next) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null)
    }
  }
  model.pushStackElement()
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
