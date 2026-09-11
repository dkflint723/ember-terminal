import { monaco } from './monaco'
import { diffLines, linesOf, type LineHunk } from './line-diff'

/**
 * The change bars in the editor margin: what this buffer says that HEAD does
 * not, computed live against the committed text — the buffer, not the file on
 * disk, because the edit you are mid-way through is exactly what the gutter is
 * for. Green is new, blue is changed, a red wedge is where lines used to be.
 * Alt+click on a mark puts that hunk back the way HEAD has it, as one undoable
 * edit.
 *
 * The diff itself is line-diff.ts, apart from Monaco so it can be tested without
 * a window — which is how it was found to loop for ever on a deleted line.
 */

export type GutterHunk = LineHunk

const HOVER = 'Changed against HEAD — Alt+click the mark to revert this hunk.'

/**
 * HEAD's text against the buffer's lines.
 *
 * Lines, not text: the buffer's text comes in the model's own line endings, and
 * split on "\n" a CRLF buffer had a "\r" on every line HEAD's LF blob did not —
 * so on a default Git for Windows checkout every line of an untouched file was
 * marked as changed.
 */
export function computeGutters(headText: string, bufferLines: string[]): GutterHunk[] {
  return diffLines(linesOf(headText), bufferLines)
}

/** Decorations for a set of hunks, ready for deltaDecorations. */
export function gutterDecorations(hunks: GutterHunk[]): monaco.editor.IModelDeltaDecoration[] {
  return hunks.map((hunk) => {
    if (hunk.kind === 'deleted') {
      const line = Math.max(1, hunk.start)
      return {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          linesDecorationsClassName: 'gutter-deleted',
          linesDecorationsTooltip: HOVER
        }
      }
    }
    return {
      range: new monaco.Range(hunk.start, 1, hunk.start + hunk.count - 1, 1),
      options: {
        isWholeLine: false,
        linesDecorationsClassName: `gutter-${hunk.kind}`,
        linesDecorationsTooltip: HOVER
      }
    }
  })
}

/** The hunk whose mark sits on `line`, if any. */
export function hunkAtLine(hunks: GutterHunk[], line: number): GutterHunk | null {
  for (const hunk of hunks) {
    if (hunk.kind === 'deleted') {
      if (hunk.start === line) return hunk
    } else if (line >= hunk.start && line < hunk.start + hunk.count) {
      return hunk
    }
  }
  return null
}

/** Put one hunk back the way HEAD has it, as a single undoable edit. */
export function revertHunk(editor: monaco.editor.ICodeEditor, hunk: GutterHunk): void {
  const model = editor.getModel()
  if (!model) return
  const eol = model.getEOL()
  let range: InstanceType<typeof monaco.Range>
  let text: string
  if (hunk.kind === 'deleted') {
    // The lines were removed ahead of `start`; put them back in front of it.
    const insertAt = Math.min(hunk.start, model.getLineCount())
    range = new monaco.Range(insertAt, 1, insertAt, 1)
    text = hunk.before.join(eol) + eol
  } else if (hunk.before.length === 0) {
    // Pure addition: take the lines out, terminator and all.
    const lastLine = hunk.start + hunk.count - 1
    if (lastLine < model.getLineCount()) {
      range = new monaco.Range(hunk.start, 1, lastLine + 1, 1)
    } else {
      const prev = Math.max(1, hunk.start - 1)
      range = new monaco.Range(prev, model.getLineMaxColumn(prev), lastLine, model.getLineMaxColumn(lastLine))
    }
    text = ''
  } else {
    const lastLine = hunk.start + hunk.count - 1
    range = new monaco.Range(hunk.start, 1, lastLine, model.getLineMaxColumn(lastLine))
    text = hunk.before.join(eol)
  }
  editor.pushUndoStop()
  editor.executeEdits('gutter-revert', [{ range, text }])
  editor.pushUndoStop()
}
