import { useEffect, useRef, useState } from 'react'
import { activeDocument, useStore, type EditorPaneState } from '../state/store'
import { modelUri, monaco } from '../editor/monaco'
import { applyMonacoTheme, MONACO_THEME_ID } from '../editor/theme'
import { ensureLanguageServer, findDefinition } from '../editor/lsp'
import { ensureSnippets } from '../editor/snippets'
import { openAt } from '../editor/navigate'
import { lastSynced, noteSynced } from '../editor/synced'
import { recordSelection } from '../state/ide'
import { pendingUnsaved, setBufferReader } from '../state/session'
import { samePath } from '@shared/paths'

interface Props {
  pane: EditorPaneState
  active: boolean
  onFocus: () => void
  tabId: string
}

/**
 * Where a file sits, relative to the workspace, without its own name on the end.
 * Empty for a file at the root or outside the workspace entirely — in both cases
 * there is nothing useful to add beyond the tab's label.
 */
function locate(filePath: string | null, root: string | null): string {
  if (!filePath) return ''
  const parts = filePath.replace(/\\/g, '/').split('/')
  parts.pop()
  const dir = parts.join('/')
  if (!root) return ''
  const base = root.replace(/\\/g, '/')
  if (!dir.toLowerCase().startsWith(base.toLowerCase())) return ''
  return dir.slice(base.length).replace(/^\//, '')
}

/** A document's line endings, as Monaco names them. */
function eolOf(eol: 'crlf' | 'lf'): monaco.editor.EndOfLineSequence {
  return eol === 'crlf'
    ? monaco.editor.EndOfLineSequence.CRLF
    : monaco.editor.EndOfLineSequence.LF
}

/**
 * A Monaco editor in a pane, holding one or more open files.
 *
 * There is a single editor instance and one model per document, which is what makes
 * the tab strip cheap: switching tabs swaps the model rather than rebuilding an
 * editor, so each file keeps its own undo history, folds and scroll position for
 * free. Models are keyed by file URI and deliberately outlive the pane — a language
 * server still considers those documents open, and reopening a file should not
 * throw away what the user did to it.
 */
export function EditorPane({ pane, active, onFocus, tabId }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const theme = useStore((s) => s.theme)
  const fontFamily = useStore((s) => s.settings.fontFamily)
  const fontSize = useStore((s) => s.settings.fontSize)
  const patchDocument = useStore((s) => s.patchDocument)
  const setActiveDocument = useStore((s) => s.setActiveDocument)
  const closeDocument = useStore((s) => s.closeDocument)
  const moveDocument = useStore((s) => s.moveDocument)
  /** Which tab is being dragged, and which one it is currently over. */
  const dragFrom = useRef<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const document = activeDocument(pane)

  /*
   * Auto-save state, held in refs.
   *
   * The content-change subscription is created once per pane, so anything it reads
   * directly would be frozen at the value it had when the pane opened — the setting
   * could be changed and the editor would go on using the old one. A ref updated
   * every render is read at the moment the callback runs instead.
   */
  const autoSaveAfter = useStore((s) => s.settings.autoSaveAfterSeconds)
  const autoSaveRef = useRef(autoSaveAfter)
  autoSaveRef.current = autoSaveAfter
  const autoSaveFn = useRef<(filePath: string) => Promise<void>>(async () => {})
  // Keyed by file, not one timer for the pane: a pending save belongs to the
  // document that was edited, and switching tabs while it is pending must not
  // redirect it to whatever is on screen when it fires.
  const autoSaveTimers = useRef(new Map<string, number>())

  /**
   * The model for a document, created on first use. A real `file://` URI, not
   * Monaco's generated inmemory one: a language server identifies documents by URI
   * and resolves imports relative to them.
   */
  const modelFor = (doc: typeof document): monaco.editor.ITextModel => {
    const uri = doc.filePath ? modelUri(doc.filePath) : undefined
    const existing = uri ? monaco.editor.getModel(uri) : null
    if (existing) {
      /*
       * A retained model can be older than the file.
       *
       * Models outlive their tabs deliberately, so reopening a file that changed on
       * disk in the meantime handed back the text as it was — and saving wrote that
       * back over the newer file. `lastSynced` is what separates "the user edited
       * this" from "the file moved on underneath it": a buffer still holding what it
       * held when it last agreed with disk is brought up to date, and one with edits
       * of the user's own is left alone, to be read as unsaved against the new
       * content by the reconciliation below.
       */
      const synced = lastSynced(doc.filePath)
      if (synced !== undefined && synced !== doc.savedContent && existing.getValue() === synced) {
        // The line endings can have changed with the content, and the model's are
        // what a save writes back — without this, reopening a file someone had
        // converted to CRLF would rewrite every line of it on the next Ctrl+S.
        existing.setEOL(eolOf(doc.eol))
        existing.setValue(doc.savedContent)
        noteSynced(doc.filePath, existing.getValue())
      }
      return existing
    }

    // Text carried over from the last session, if this document had unsaved edits
    // when it was written down. Consumed once: after this the model is the truth.
    const carried = doc.filePath ? pendingUnsaved.get(doc.filePath) : undefined
    if (doc.filePath) pendingUnsaved.delete(doc.filePath)

    const model = monaco.editor.createModel(carried ?? doc.savedContent, doc.language, uri)
    model.setEOL(eolOf(doc.eol))
    // Read back off the model rather than recorded as handed in: Monaco normalises
    // line endings, and what has to match later is the buffer's own text. Carried
    // text is unsaved by definition, so it is recorded as agreeing with nothing.
    if (carried === undefined) noteSynced(doc.filePath, model.getValue())
    return model
  }

  // Lets the session snapshot read any document's live text, including tabs that
  // are not on screen — their models hold the edits whether they are shown or not.
  useEffect(() => {
    setBufferReader((filePath) => monaco.editor.getModel(modelUri(filePath))?.getValue() ?? null)
  }, [])

  // Created once per pane; the model is swapped underneath it as tabs change.
  useEffect(() => {
    if (!host.current || editorRef.current) return
    applyMonacoTheme(theme)

    const editor = monaco.editor.create(host.current, {
      model: modelFor(document),
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

    // Reported as it changes rather than read on demand: a tool call arrives from
    // a socket, and by then the editor may not be the focused thing on screen.
    const selectionSub = editor.onDidChangeCursorSelection((e) => {
      const model = editor.getModel()
      if (!model) return
      recordSelection({
        filePath: activeDocument(useStore.getState().editorPane(pane.id) ?? pane).filePath,
        text: model.getValueInRange(e.selection),
        start: { line: e.selection.startLineNumber - 1, character: e.selection.startColumn - 1 },
        end: { line: e.selection.endLineNumber - 1, character: e.selection.endColumn - 1 }
      })
    })

    // Dirtiness is per document, and the edit always belongs to whichever one is on
    // screen — so the index is read at the time of the edit, not captured here.
    const sub = editor.onDidChangeModelContent(() => {
      const current = useStore.getState().editorPane(pane.id)
      if (!current) return
      const index = current.activeIndex
      const doc = current.documents[index]
      if (!doc) return
      const dirty = editor.getValue() !== doc.savedContent
      if (dirty !== doc.dirty) patchDocument(pane.id, { dirty }, index)

      // Auto-save, when it is switched on. Restarted on every edit so it saves
      // once after typing stops rather than repeatedly in the middle of a word,
      // and only for a document that has somewhere on disk to go.
      const target = doc.filePath
      if (!target) return
      const pending = autoSaveTimers.current.get(target)
      if (pending) window.clearTimeout(pending)
      if (autoSaveRef.current > 0 && dirty) {
        autoSaveTimers.current.set(
          target,
          window.setTimeout(() => {
            autoSaveTimers.current.delete(target)
            void autoSaveFn.current(target)
          }, autoSaveRef.current * 1000)
        )
      }
    })

    // Ctrl+S is handled here rather than in the global handler so it reaches the
    // focused editor and nothing else.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())

    // Format Document, on the binding VS Code uses. Added explicitly rather than
    // relied on: the formatting itself comes from the language server, and the
    // standalone editor does not ship every workbench binding.
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
      void editor.getAction('editor.action.formatDocument')?.run()
    })

    /*
     * Go to Definition, answered by the server rather than by Monaco's client.
     *
     * The client resolves definitions only against files it is already managing and
     * throws for anything else, so F12 worked into an open file and did nothing at
     * all into any other — which is most of the times anyone presses it. Asking the
     * server directly gives back a path, which the app already knows how to open.
     */
    editor.addAction({
      id: 'ember.goToDefinition',
      label: 'Go to Definition',
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: async (ed) => {
        const model = ed.getModel()
        const position = ed.getPosition()
        const current = useStore.getState().editorPane(pane.id)
        const doc = current ? activeDocument(current) : null
        if (!model || !position || !doc?.filePath) return

        const target = await findDefinition(doc.language, doc.filePath, position.lineNumber, position.column)
        if (!target) {
          setMessage('no definition found')
          window.setTimeout(() => setMessage(null), 1500)
          return
        }
        openAt(target.filePath, target.line, target.column)
      }
    })

    // Claiming Ctrl+K stops Monaco starting one of its chords, which would eat the
    // next keystroke and look like a freeze. The global handler does the rest, so
    // this only has to prevent the chord.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      const s = useStore.getState()
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      if (!tab) return
      const target = Object.values(s.panes).find((p) => p.kind === 'terminal')?.id
      if (target) s.requestAsk(target)
    })

    return () => {
      selectionSub.dispose()
      sub.dispose()
      // Pending auto-saves would fire into a pane that no longer exists.
      for (const timer of autoSaveTimers.current.values()) window.clearTimeout(timer)
      autoSaveTimers.current.clear()
      // Models are deliberately kept: they are keyed by file URI and shared, so
      // disposing them here would discard undo history on reopen and desync the
      // language server, which still considers the document open.
      editor.dispose()
      editorRef.current = null
    }
    // Intentionally created once per pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id])

  // Swap the model when the active tab changes. Guarded so an unrelated re-render
  // does not reset the editor and lose the cursor.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = modelFor(document)
    if (editor.getModel() !== model) editor.setModel(model)

    /*
     * Reconcile the tab with the model it just attached to.
     *
     * A model outlives its tab on purpose — that is what keeps undo history and the
     * language server's view of the document intact — so reopening a file can hand
     * back one that still holds edits the store has no record of. Left alone the
     * editor showed that unsaved text with no unsaved marker, which is the one state
     * where someone reasonably believes their work is on disk when it is not.
     */
    const dirty = model.getValue() !== document.savedContent
    if (dirty !== document.dirty) patchDocument(pane.id, { dirty }, pane.activeIndex)

    const treeRoot = useStore.getState().treeRoot
    const fileDir = document.filePath?.replace(/[\\/][^\\/]*$/, '')
    void ensureLanguageServer(document.language, treeRoot ?? fileDir ?? undefined)
    void ensureSnippets(document.language)
    // savedContent is in here because it moving is how this pane hears that the file
    // changed underneath it — opening an already-open file re-reads it, and without
    // this the tab went on showing the old text with no unsaved marker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.activeIndex, document.filePath, document.language, document.savedContent])

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
    const current = useStore.getState().editorPane(pane.id)
    if (!editor || !current) return
    const index = current.activeIndex
    const from = current.documents[index]?.filePath ?? null
    // The buffer, held directly rather than through the editor: a tab switch during
    // the write moves the editor to another model, and what is being saved is this
    // document's text wherever it ends up on screen.
    const buffer = editor.getModel()
    const content = buffer?.getValue() ?? editor.getValue()

    let target = from
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
    // What was written, not what the buffer holds now: typing during the write
    // leaves the two different, and the buffer is then genuinely ahead of disk.
    noteSynced(target, content)

    /*
     * Both the document and its dirtiness are settled after the write, not before.
     *
     * `content` was read before an await, and a keystroke landing inside that window
     * used to be marked as saved: the store took `dirty: false` on trust, the change
     * handler had already seen dirty as true and so patched nothing, and from then on
     * nothing knew those characters existed. Closing the tab did not ask, Save All
     * skipped it, and the session snapshot dropped it — the edit was gone at the next
     * launch. The index is re-found for the same reason a save is not the only thing
     * that can happen while a file is being written.
     */
    const after = useStore.getState().editorPane(pane.id)
    const at = from
      ? (after?.documents.findIndex((d) => samePath(d.filePath, from)) ?? -1)
      : index
    if (!after || at === -1 || !after.documents[at]) return
    patchDocument(
      pane.id,
      {
        filePath: target,
        savedContent: content,
        dirty: (buffer?.getValue() ?? content) !== content,
        title: target.split(/[\\/]/).pop()
      },
      at
    )
    // And in any other pane showing the same file, which would otherwise go on
    // reporting unsaved changes for a file that now matches disk.
    useStore.getState().settleSaved(target, content, (buffer?.getValue() ?? content) !== content)
    setMessage('saved')
    window.setTimeout(() => setMessage(null), 1500)
  }

  /*
   * Save one named document, without reference to what is on screen.
   *
   * Separate from `save` because that one saves the active tab and will open a
   * file dialog for a document that has never been saved — neither of which an
   * auto-save should do. It writes the model's text rather than the editor's, so a
   * document edited and then left behind another tab is still saved correctly.
   *
   * Held in a ref: the subscription that schedules it is created once per pane and
   * cannot see this function directly.
   */
  autoSaveFn.current = async (filePath: string) => {
    const current = useStore.getState().editorPane(pane.id)
    const index = current?.documents.findIndex((d) => samePath(d.filePath, filePath)) ?? -1
    if (!current || index === -1 || !current.documents[index].dirty) return

    const buffer = monaco.editor.getModel(modelUri(filePath))
    if (!buffer) return
    const content = buffer.getValue()

    const res = await window.ember.writeFile(filePath, content)
    if (!res.ok) {
      setMessage(res.error)
      return
    }
    noteSynced(filePath, content)
    // Re-found after the write, and dirtiness read off the buffer rather than
    // assumed, for the reasons spelled out in save().
    const after = useStore.getState().editorPane(pane.id)
    const at = after?.documents.findIndex((d) => samePath(d.filePath, filePath)) ?? -1
    if (!after || at === -1) return
    patchDocument(pane.id, { savedContent: content, dirty: buffer.getValue() !== content }, at)
    useStore.getState().settleSaved(filePath, content, buffer.getValue() !== content)
  }

  /**
   * Close a tab, asking first when it holds unsaved work.
   *
   * The text is not actually destroyed — the model keeps it, and reopening the file
   * now shows it and marks it unsaved — but closing is still the moment someone
   * expects to be asked, and being asked is what tells them the work exists.
   */
  const requestClose = (index: number): void => {
    const doc = pane.documents[index]
    if (doc?.dirty && !window.confirm(`${doc.title} has unsaved changes. Close it anyway?`)) return
    closeDocument(tabId, pane.id, index)
  }

  const revert = async (): Promise<void> => {
    const path = document.filePath
    if (!path) return
    // Throwing away edits and the undo history with them, so it gets asked.
    if (
      document.dirty &&
      !window.confirm(`Discard unsaved changes to ${document.title} and reload it from disk?`)
    ) {
      return
    }
    const res = await window.ember.readFile(path)
    if (!res.ok) {
      setMessage(res.error)
      return
    }
    /*
     * Both the buffer and the tab are found by path, never taken from the editor.
     *
     * The editor is whatever is on screen when the read comes back, and the default
     * patch target is whichever tab is active by then — so switching tabs during the
     * read poured this file's text into a different file's buffer, marked that one
     * saved, and left the next Ctrl+S ready to write one file's contents into the
     * other's path. The reverted file is a fixed thing; it is looked up as one.
     */
    const model = monaco.editor.getModel(modelUri(path))
    const current = useStore.getState().editorPane(pane.id)
    const at = current?.documents.findIndex((d) => samePath(d.filePath, path)) ?? -1
    if (!current || at === -1) return

    model?.setEOL(eolOf(res.eol))
    model?.setValue(res.content)
    patchDocument(pane.id, { savedContent: res.content, dirty: false, eol: res.eol }, at)
    // A revert throws away the edit everywhere, not only in the pane it was asked
    // from — the buffer they share has already gone back to what disk holds.
    useStore.getState().settleSaved(path, res.content, false)
    if (model) noteSynced(path, model.getValue())
  }

  return (
    <div
      className={`pane editor ${active ? 'pane--active' : ''}`}
      onMouseDown={onFocus}
      data-editor-path={document.filePath ?? ''}
      data-dirty={document.dirty ? 'true' : 'false'}
      data-editor-tabs={pane.documents.length}
    >
      {/* One tab per open file. Shown even when there is only one, so opening a
          second does not shift the editor down under the pointer. */}
      <div className="etabs" role="tablist">
        {pane.documents.map((doc, i) => (
          <div
            key={doc.filePath ?? `untitled-${i}`}
            role="tab"
            aria-selected={i === pane.activeIndex}
            className={`etab ${i === pane.activeIndex ? 'etab--active' : ''} ${
              doc.dirty ? 'etab--dirty' : ''
            } ${dragOver === i ? 'etab--drop' : ''}`}
            title={doc.filePath ?? doc.title}
            draggable
            onDragStart={(e) => {
              dragFrom.current = i
              // Needed for the drop to be allowed at all in Chromium, even though
              // the index travels in a ref rather than the payload.
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', String(i))
            }}
            onDragOver={(e) => {
              if (dragFrom.current === null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dragOver !== i) setDragOver(i)
            }}
            onDrop={(e) => {
              e.preventDefault()
              const from = dragFrom.current
              dragFrom.current = null
              setDragOver(null)
              if (from !== null) moveDocument(pane.id, from, i)
            }}
            onDragEnd={() => {
              dragFrom.current = null
              setDragOver(null)
            }}
            onMouseDown={(e) => {
              // Middle-click closes, as everywhere else that has tabs.
              if (e.button === 1) {
                e.preventDefault()
                requestClose(i)
              } else if (e.button === 0) {
                setActiveDocument(pane.id, i)
              }
            }}
          >
            <span className="etab__label">{doc.title}</span>
            <button
              className="etab__close"
              aria-label={`Close ${doc.title}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                requestClose(i)
              }}
            >
              {doc.dirty ? '●' : '×'}
            </button>
          </div>
        ))}
      </div>

      <div className="editor__bar">
        {/* The tab above already names the file, so this shows where it sits —
            which is the thing you cannot tell from a name alone when two
            directories both contain an index.ts. */}
        <span className="editor__name" title={document.filePath ?? document.title}>
          <span className="editor__label">
            {locate(document.filePath, useStore.getState().treeRoot) || document.title}
          </span>
          {document.dirty && <span className="editor__dot" title="Unsaved changes" />}
        </span>
        <span className="editor__lang">{document.language}</span>
        <button className="block__action" onClick={() => void save()} disabled={saving}>
          {saving ? 'saving…' : 'save'}
        </button>
        <button className="block__action" onClick={() => void revert()} disabled={!document.dirty}>
          revert
        </button>
        {message && <span className="editor__msg">{message}</span>}
      </div>
      <div className="editor__host" ref={host} />
    </div>
  )
}
