import { monaco } from './monaco'

/**
 * Formatting, in the order of who has standing to have an opinion: the
 * workspace's own prettier first — a project that installed a formatter has
 * stated how its code should look — then whatever formatter the editor knows,
 * which is the language server's, or the bundled TypeScript worker's.
 *
 * Applied as a minimal middle-replace rather than a whole-buffer swap, so the
 * caret and the scroll survive a format that only touched distant lines.
 */

/** The families prettier speaks; everything else goes straight to the editor's formatter. */
const PRETTIER_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.jsonc', '.css', '.scss', '.less', '.html', '.vue',
  '.md', '.markdown', '.yaml', '.yml', '.graphql'
])

function extOf(filePath: string): string {
  const at = filePath.lastIndexOf('.')
  return at === -1 ? '' : filePath.slice(at).toLowerCase()
}

/** Replace only the middle that changed, keeping the eye where it was. */
function applyFormatted(
  editor: monaco.editor.ICodeEditor,
  model: monaco.editor.ITextModel,
  next: string
): void {
  const current = model.getValue()
  if (current === next) return
  let prefix = 0
  const shorter = Math.min(current.length, next.length)
  while (prefix < shorter && current[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < shorter - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++
  }
  const from = model.getPositionAt(prefix)
  const to = model.getPositionAt(current.length - suffix)
  editor.pushUndoStop()
  editor.executeEdits('format', [
    {
      range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
      text: next.slice(prefix, next.length - suffix)
    }
  ])
  editor.pushUndoStop()
}

/**
 * Format the model the editor is showing. Returns quietly on failure — a
 * format that cannot happen must never block a save that can.
 */
export async function formatDocument(
  editor: monaco.editor.ICodeEditor,
  filePath: string | null
): Promise<void> {
  const model = editor.getModel()
  if (!model) return

  if (filePath && PRETTIER_EXTS.has(extOf(filePath))) {
    try {
      const res = await window.ember.formatWithPrettier(filePath, model.getValue())
      if (res.ok && typeof res.content === 'string') {
        // The editor may have moved to another model during the round trip;
        // the answer belongs to this one and is applied only if it still shows.
        if (editor.getModel() === model) applyFormatted(editor, model, res.content)
        return
      }
      // 'absent' is a workspace with no opinion; anything else was a real
      // attempt that failed, and falling through to a second formatter with
      // different taste would make saves nondeterministic.
      if (res.error !== 'absent') return
    } catch {
      return
    }
  }

  const action = editor.getAction('editor.action.formatDocument')
  if (!action) return
  try {
    await action.run()
  } catch {
    // No formatter for this language; the save proceeds as typed.
  }
}

/** The focused editor, or the one showing the active document — for the chord. */
export async function formatActiveEditor(activeFilePath: string | null): Promise<void> {
  const editors = monaco.editor.getEditors()
  const focused = editors.find((e) => e.hasTextFocus())
  const target =
    focused ??
    editors.find((e) => {
      const model = e.getModel()
      return (
        !!activeFilePath &&
        model?.uri.scheme === 'file' &&
        model.uri.fsPath.toLowerCase() === activeFilePath.toLowerCase()
      )
    })
  if (!target) return
  const model = target.getModel()
  const filePath = model?.uri.scheme === 'file' ? model.uri.fsPath : null
  await formatDocument(target, filePath)
}
