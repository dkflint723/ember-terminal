import { monaco } from './monaco'
import { useStore, workspaceRoot } from '../state/store'
import { explainRestricted } from '../state/trust'
import { abandonRequests } from './lsp'

/*
 * How long a formatter is waited for. A save waits briefly and then saves what was
 * typed: format-on-save asked the language server and waited for it with no limit,
 * so a server that was busy, wedged or slow held the save for as long as it stayed
 * that way. Asked for by hand, a format may take longer, but not forever either.
 */
const ON_SAVE_MS = 1500
const BY_HAND_MS = 10_000

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
  filePath: string | null,
  { onSave = false }: { onSave?: boolean } = {}
): Promise<void> {
  const model = editor.getModel()
  if (!model) return

  if (filePath && PRETTIER_EXTS.has(extOf(filePath))) {
    /*
     * What the buffer held when the question was asked.
     *
     * The answer comes back a round trip later and describes *this* version of
     * the document. Applying it over anything typed since overwrites those
     * keystrokes with the formatter's copy of a file that no longer exists — and
     * then saves that, because this runs as part of the save. An answer about
     * the past is not an answer, so a stale one is dropped rather than applied.
     */
    const asked = model.getVersionId()
    try {
      const res = await window.ember.formatWithPrettier(
        filePath,
        model.getValue(),
        workspaceRoot(useStore.getState())
      )
      if (res.ok && typeof res.content === 'string') {
        // The editor may also have moved to another model during the round trip;
        // the answer belongs to this one, and only while it still says what it said.
        if (editor.getModel() === model && model.getVersionId() === asked) {
          applyFormatted(editor, model, res.content)
        }
        return
      }
      if (res.error === 'restricted') {
        /*
         * There was a prettier and Ember declined to run it, because a project's
         * prettier is the project's code. Said once, with the way to allow it
         * attached — then the editor's own formatter answers below, since that
         * one is Ember's code rather than the folder's.
         */
        explainRestricted('Ember did not format with this project’s prettier.')
      } else if (res.error !== 'absent') {
        // 'absent' is a workspace with no opinion; anything else was a real
        // attempt that failed, and falling through to a second formatter with
        // different taste would make saves nondeterministic.
        return
      }
    } catch {
      return
    }
  }

  const action = editor.getAction('editor.action.formatDocument')
  if (!action) return
  const limit = onSave ? ON_SAVE_MS : BY_HAND_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), limit)
  })
  try {
    const running = action.run().then(() => 'done' as const)
    const outcome = await Promise.race([running, late])
    if (outcome === 'late') {
      // Given up on, so its answer cannot land after the save and undo it.
      const abandoned = abandonRequests(model, ['textDocument/formatting', 'textDocument/rangeFormatting'])
      if (abandoned === 0 && onSave) {
        /*
         * Nothing of a language server's to give up on: the formatter is Monaco's
         * own — the bundled TypeScript worker, starting cold. It cannot be stopped,
         * and it cannot wedge the way a server can, so the save waits for it, to the
         * limit a format asked for by hand gets. Saving without it put the text as
         * typed on disk, and then its edits landed in the buffer: formatted, unsaved,
         * and different from the file.
         */
        await Promise.race([running, new Promise((resolve) => setTimeout(resolve, BY_HAND_MS - ON_SAVE_MS))])
      } else if (abandoned > 0) {
        useStore
          .getState()
          .setNotice(
            onSave
              ? `The ${model.getLanguageId()} language server did not format this file within ${limit / 1000} s, so it was saved as typed.`
              : `The ${model.getLanguageId()} language server did not format this file within ${limit / 1000} s.`,
            'info'
          )
      }
    }
  } catch {
    // No formatter for this language; the save proceeds as typed.
  } finally {
    clearTimeout(timer)
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
