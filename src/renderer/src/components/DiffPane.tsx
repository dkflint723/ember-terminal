import { useEffect, useRef } from 'react'
import { useStore, type DiffPaneState } from '../state/store'
import { monaco } from '../editor/monaco'
import { applyMonacoTheme, MONACO_THEME_ID } from '../editor/theme'
import { resolveProposal } from '../state/ide'

interface Props {
  pane: DiffPaneState
  active: boolean
  onFocus: () => void
}

/**
 * Two revisions of a file side by side, in Monaco's diff editor.
 *
 * Both sides are read-only. The left is a blob out of the object database, which
 * cannot be written back, and the right is a snapshot rather than a live buffer —
 * editing it here would silently diverge from the same file open in an editor pane.
 * Editing is what the editor pane is for; this is for reading what changed.
 */
export function DiffPane({ pane, active, onFocus }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null)
  const theme = useStore((s) => s.theme)
  const fontFamily = useStore((s) => s.settings.fontFamily)
  const fontSize = useStore((s) => s.settings.fontSize)

  const close = (): void => {
    const state = useStore.getState()
    const owner = state.tabIdForPane(pane.id)
    if (owner) state.closePane(owner, pane.id)
  }

  useEffect(() => {
    if (!host.current || editorRef.current) return

    applyMonacoTheme(theme)
    const editor = monaco.editor.createDiffEditor(host.current, {
      theme: MONACO_THEME_ID,
      fontFamily,
      fontSize,
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      // Matching the editor pane: the same file should not look different depending
      // on which kind of pane it happens to be in.
      guides: { indentation: true, highlightActiveIndentation: true, bracketPairs: false }
    })
    editorRef.current = editor

    return () => {
      editor.dispose()
      // Unlike an editor pane's model, these are not keyed by file URI and nothing
      // else can be showing them, so they are disposed with the pane rather than
      // left to accumulate one pair per diff opened.
      modelsRef.current?.original.dispose()
      modelsRef.current?.modified.dispose()
      modelsRef.current = null
      editorRef.current = null
    }
    // Created once per pane; content changes are pushed in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id])

  // Re-opening the same diff refreshes this pane rather than making another, so the
  // content is an effect rather than something set once at construction.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    modelsRef.current?.original.dispose()
    modelsRef.current?.modified.dispose()

    const original = monaco.editor.createModel(pane.original, pane.language)
    const modified = monaco.editor.createModel(pane.modified, pane.language)
    modelsRef.current = { original, modified }
    editor.setModel({ original, modified })
  }, [pane.original, pane.modified, pane.language])

  useEffect(() => {
    if (editorRef.current) applyMonacoTheme(theme)
  }, [theme])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontFamily, fontSize })
  }, [fontFamily, fontSize])

  return (
    <div
      className={`pane editor diff ${active ? 'pane--active' : ''}`}
      onMouseDown={onFocus}
      data-diff-path={pane.filePath}
      data-diff-staged={pane.staged ? 'true' : 'false'}
    >
      <div className="editor__bar">
        <span className="editor__name" title={pane.filePath}>
          <span className="editor__label">{pane.title}</span>
        </span>
        <span className="editor__lang">
          {pane.originalLabel} ↔ {pane.modifiedLabel}
        </span>
        {pane.proposal && (
          <>
            {/* Claude Code is blocked on this answer, so the pane says so rather
                than looking like an ordinary read-only diff. */}
            <span className="diff__waiting">waiting on you</span>
            <button
              className="block__action diff__reject"
              onClick={() => void resolveProposal(pane.proposal!.tabName, 'reject')}
            >
              reject
            </button>
            <button
              className="block__action diff__accept"
              onClick={() => void resolveProposal(pane.proposal!.tabName, 'accept')}
            >
              accept
            </button>
          </>
        )}
        {/*
          A diff opened from the source control panel had no way to be dismissed:
          the pane carries no tab strip, and unlike an editor its bar held nothing
          at all unless Claude was waiting on an answer. Closing it needed a
          keyboard shortcut nobody would guess at. A proposal keeps its accept and
          reject, which are how that one is meant to end.
        */}
        {!pane.proposal && (
          <button className="block__action" title="Close this diff" onClick={close}>
            close
          </button>
        )}
      </div>
      <div className="editor__host" ref={host} />
    </div>
  )
}
