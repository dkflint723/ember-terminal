import { monaco } from './monaco'

/**
 * Change this, by saying what you want.
 *
 * Select some code, press the chord, describe the change, and Claude rewrites the
 * selection in place. This is the half of the job a strong model is actually good
 * at — understanding an intent and making a coherent multi-line edit — as against
 * the suggestion ahead of the caret, which is a race a small local model wins.
 *
 * Deliberately not a diff view. A diff is the right shape for a change you did not
 * ask for and have to review; this one was asked for a second ago, is bounded to a
 * selection the user made themselves, and arrives as a single undoable edit. Esc
 * puts it back exactly, because the editor's own undo does, and that is a promise
 * this file does not have to keep by hand.
 */

/** Long enough to say a sentence, short enough that it never covers the code. */
const WIDGET_WIDTH = 460

export interface InlineEditHost {
  /** Asks Claude, and comes back with the replacement or a reason it could not. */
  rewrite(selection: string, instruction: string, language: string): Promise<Result>
}

export type Result = { ok: true; text: string } | { ok: false; error: string }

export function attachInlineEdit(
  editor: monaco.editor.IStandaloneCodeEditor,
  host: InlineEditHost
): { dispose(): void } {
  let widget: monaco.editor.IContentWidget | null = null
  let root: HTMLDivElement | null = null

  const close = (): void => {
    if (widget) editor.removeContentWidget(widget)
    widget = null
    root = null
    editor.focus()
  }

  const open = (): void => {
    const selection = editor.getSelection()
    const model = editor.getModel()
    if (!model || !selection || selection.isEmpty()) return
    if (widget) close()

    const selected = model.getValueInRange(selection)

    root = document.createElement('div')
    root.className = 'inline-edit'
    root.style.width = `${WIDGET_WIDTH}px`

    const input = document.createElement('input')
    input.className = 'inline-edit__input'
    input.placeholder = 'Describe the change…'
    input.spellcheck = false

    const hint = document.createElement('div')
    hint.className = 'inline-edit__hint'
    hint.textContent = `${selection.endLineNumber - selection.startLineNumber + 1} lines · Enter to ask · Esc to close`

    root.append(input, hint)

    widget = {
      getId: () => 'ember.inlineEdit',
      getDomNode: () => root as HTMLElement,
      /* Free of the editor's own clipping, so a prompt opened on the first line
         is not cut in half by the top of the viewport. */
      allowEditorOverflow: true,
      suppressMouseDown: true,
      getPosition: () => ({
        position: { lineNumber: selection.startLineNumber, column: 1 },
        preference: [
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
          monaco.editor.ContentWidgetPositionPreference.BELOW
        ]
      })
    }
    editor.addContentWidget(widget)
    /*
     * Focused on the next frame rather than now. A content widget is not in the
     * document until Monaco has laid it out, so focusing it immediately does
     * nothing — and the editor keeps the keyboard, which means the first thing
     * typed replaces the very selection the prompt is about. Found exactly that
     * way: the instruction ended up in the file.
     */
    requestAnimationFrame(() => input.focus())

    const ask = async (): Promise<void> => {
      const instruction = input.value.trim()
      if (!instruction || !root) return

      input.disabled = true
      hint.textContent = 'Asking Claude…'

      const res = await host.rewrite(selected, instruction, model.getLanguageId())
      if (!root) return // Closed while it was thinking.

      if (!res.ok) {
        hint.textContent = res.error
        hint.classList.add('inline-edit__hint--bad')
        input.disabled = false
        return
      }

      close()
      /*
       * One edit, so one undo. `pushEditOperations` puts it on the editor's own
       * stack, which is what makes Esc-to-put-it-back a promise this file does not
       * have to keep itself.
       */
      /*
       * Closed on both sides, and pushed through the model rather than the editor.
       * `executeEdits` alone let Monaco fold the rewrite into whatever the user had
       * just been typing, so one undo took the machine's change and the tail of
       * their own sentence with it — measured, by typing a comment and then asking
       * for a rewrite: the undo left `//` where `// mine` had been.
       */
      editor.pushUndoStop()
      model.pushStackElement()
      model.pushEditOperations(
        [selection],
        [{ range: selection, text: res.text, forceMoveMarkers: true }],
        () => null
      )
      model.pushStackElement()
      editor.pushUndoStop()

      // Leave the new text selected: it is what to look at, and what to undo.
      const lines = res.text.split('\n')
      editor.setSelection(
        new monaco.Range(
          selection.startLineNumber,
          selection.startColumn,
          selection.startLineNumber + lines.length - 1,
          lines.length === 1 ? selection.startColumn + res.text.length : lines[lines.length - 1].length + 1
        )
      )
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        void ask()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    })
  }

  const action = editor.addAction({
    id: 'ember.inlineEdit',
    label: 'Edit with Claude',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
    contextMenuGroupId: 'modification',
    contextMenuOrder: 1,
    run: () => open()
  })

  return {
    dispose(): void {
      close()
      action.dispose()
    }
  }
}
