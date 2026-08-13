import { useEffect, useRef, useState } from 'react'
import { useStore, type EditorPaneState } from '../state/store'
import { monaco } from '../editor/monaco'
import { applyMonacoTheme, MONACO_THEME_ID } from '../editor/theme'
import { ensureLanguageServer } from '../editor/lsp'
import { recordSelection } from '../state/ide'

interface Props {
  pane: EditorPaneState
  active: boolean
  onFocus: () => void
}

/**
 * A Monaco editor in a pane. Monaco holds its own model and undo history, so the
 * instance is created once per pane and kept out of React state — the same reason
 * terminal controllers live in a registry.
 */
export function EditorPane({ pane, active, onFocus }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const theme = useStore((s) => s.theme)
  const fontFamily = useStore((s) => s.settings.fontFamily)
  const fontSize = useStore((s) => s.settings.fontSize)
  const patch = useStore((s) => s.patchEditorPane)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Create the editor once. Later prop changes are pushed in through the effects
  // below rather than by recreating it, which would lose undo history.
  useEffect(() => {
    if (!host.current || editorRef.current) return

    applyMonacoTheme(theme)

    // The model needs a real file:// URI, not Monaco's generated inmemory one: a
    // language server identifies documents by URI, and resolves imports relative
    // to them. Reuse an existing model so reopening a file keeps its history.
    const uri = pane.filePath ? monaco.Uri.file(pane.filePath) : undefined
    const model =
      (uri && monaco.editor.getModel(uri)) ||
      monaco.editor.createModel(pane.savedContent, pane.language, uri)

    // The tree root when there is one, else the file's own directory: a server that
    // indexes a project needs somewhere to start. The separator class has to include
    // the backslash — without it a Windows path never matches and the "directory" is
    // the file itself, which pyright accepts and then indexes as an empty project.
    const treeRoot = useStore.getState().treeRoot
    const fileDir = pane.filePath?.replace(/[\\/][^\\/]*$/, '')
    void ensureLanguageServer(pane.language, treeRoot ?? fileDir ?? undefined)

    const editor = monaco.editor.create(host.current, {
      model,
      theme: MONACO_THEME_ID,
      fontFamily,
      fontSize,
      automaticLayout: true,
      minimap: { enabled: true, size: 'proportional' },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      // Indentation lines, with the level the cursor is inside picked out. Nesting
      // in a narrow pane beside a terminal is otherwise hard to follow.
      guides: { indentation: true, highlightActiveIndentation: true, bracketPairs: false },
      smoothScrolling: true,
      tabSize: 2,
      // The pane is narrow by design; a ruler would mostly be noise.
      rulers: []
    })
    editorRef.current = editor

    editor.getModel()?.setEOL(
      pane.eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF
    )

    // Reported as it changes rather than read on demand: a tool call arrives from
    // a socket, and by then the editor may not be the focused thing on screen.
    const selectionSub = editor.onDidChangeCursorSelection((e) => {
      const model = editor.getModel()
      if (!model) return
      recordSelection({
        filePath: pane.filePath,
        text: model.getValueInRange(e.selection),
        start: {
          line: e.selection.startLineNumber - 1,
          character: e.selection.startColumn - 1
        },
        end: { line: e.selection.endLineNumber - 1, character: e.selection.endColumn - 1 }
      })
    })

    const sub = editor.onDidChangeModelContent(() => {
      const current = editor.getValue()
      const dirty = current !== useStore.getState().editorPane(pane.id)?.savedContent
      if (dirty !== useStore.getState().editorPane(pane.id)?.dirty) patch(pane.id, { dirty })
    })

    // Ctrl+S is handled here rather than in the global handler so it reaches the
    // focused editor and nothing else.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())

    return () => {
      selectionSub.dispose()
      sub.dispose()
      // The model is deliberately kept: it is keyed by file URI and shared, so
      // disposing it here would discard undo history on reopen and desync the
      // language server, which still considers the document open.
      editor.dispose()
      editorRef.current = null
    }
    // Intentionally created once per pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id])

  // Theme and font follow the app without touching the model.
  useEffect(() => {
    if (editorRef.current) applyMonacoTheme(theme)
  }, [theme])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontFamily, fontSize })
  }, [fontFamily, fontSize])

  useEffect(() => {
    if (active) editorRef.current?.focus()
  }, [active])

  const save = async (): Promise<void> => {
    const editor = editorRef.current
    if (!editor) return
    const content = editor.getValue()

    let target = useStore.getState().editorPane(pane.id)?.filePath ?? null
    if (!target) {
      target = await window.ember.saveFileDialog()
      if (!target) return
    }

    setSaving(true)
    const res = await window.ember.writeFile(target, content)
    setSaving(false)

    if (!res.ok) {
      setMessage(res.error)
      return
    }
    // Dirtiness is derived by comparing against what is on disk, so the saved
    // content has to move with it.
    patch(pane.id, { filePath: target, savedContent: content, dirty: false, error: null })
    setMessage('saved')
    window.setTimeout(() => setMessage(null), 1500)
  }

  const revert = async (): Promise<void> => {
    const path = pane.filePath
    if (!path) return
    const res = await window.ember.readFile(path)
    if (!res.ok) {
      setMessage(res.error)
      return
    }
    editorRef.current?.setValue(res.content)
    patch(pane.id, { savedContent: res.content, dirty: false })
  }

  return (
    <div
      className={`pane editor ${active ? 'pane--active' : ''}`}
      onMouseDown={onFocus}
      data-editor-path={pane.filePath ?? ''}
      data-dirty={pane.dirty ? 'true' : 'false'}
    >
      <div className="editor__bar">
        <span className="editor__name">
          {pane.title}
          {pane.dirty && <span className="editor__dot" title="Unsaved changes" />}
        </span>
        <span className="editor__lang">{pane.language}</span>
        <button className="block__action" onClick={() => void save()} disabled={saving}>
          {saving ? 'saving…' : 'save'}
        </button>
        <button className="block__action" onClick={() => void revert()} disabled={!pane.dirty}>
          revert
        </button>
        {message && <span className="editor__msg">{message}</span>}
      </div>
      <div className="editor__host" ref={host} />
    </div>
  )
}
