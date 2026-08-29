import { monaco } from './monaco'
import {
  breakpointsFor,
  syncBreakpointLines,
  toggleBreakpoint,
  useDebugStore
} from '../state/debug'
import { useStore } from '../state/store'

/**
 * What debugging looks like inside an editor: dots in the glyph margin where
 * breakpoints stand — filled once an adapter has verified them, hollow while
 * they are only a wish, diamond when conditional, info-coloured when they log
 * instead of stopping — and the line the program is stopped on, painted and
 * pointed at. A click in the margin is the toggle; a right-click on a mark
 * opens the Debug view, where its condition can be written. While the program
 * is stopped, hovering a name asks the adapter what it holds.
 */

export function wireDebugging(editor: monaco.editor.IStandaloneCodeEditor): () => void {
  registerDebugHover()
  let decorationIds: string[] = []
  /** Which decorations are breakpoints, and which store entry each one paints. */
  let breakpointDecorationIds: string[] = []
  let paintedStoreIndices: number[] = []

  const paint = (): void => {
    const model = editor.getModel()
    if (!model || model.uri.scheme !== 'file') {
      decorationIds = editor.deltaDecorations(decorationIds, [])
      breakpointDecorationIds = []
      paintedStoreIndices = []
      return
    }
    const filePath = model.uri.fsPath
    const decorations: monaco.editor.IModelDeltaDecoration[] = []
    const file = breakpointsFor(filePath)
    const indices: number[] = []

    for (const [index, bp] of (file?.lines ?? []).entries()) {
      // A mark beyond the end of the buffer — a stale restore — stays in the
      // store but cannot be painted; the index list keeps the mapping honest.
      if (bp.line > model.getLineCount()) continue
      indices.push(index)
      const flavor = bp.logMessage
        ? ' dbg-breakpoint--log'
        : bp.condition
          ? ' dbg-breakpoint--conditional'
          : ''
      decorations.push({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: `dbg-breakpoint${bp.verified ? '' : ' dbg-breakpoint--wish'}${flavor}`,
          glyphMarginHoverMessage: {
            value: bp.logMessage
              ? `Logpoint: ${bp.logMessage}`
              : bp.condition
                ? `Breakpoint when: ${bp.condition}`
                : bp.verified
                  ? 'Breakpoint'
                  : 'Breakpoint — not yet verified by the adapter'
          },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        }
      })
    }

    const s = useDebugStore.getState()
    const frame = s.frames.find((f) => f.id === s.activeFrameId)
    if (
      s.status === 'stopped' &&
      frame?.path &&
      frame.path.replace(/\\/g, '/').toLowerCase() === filePath.replace(/\\/g, '/').toLowerCase() &&
      frame.line <= model.getLineCount()
    ) {
      decorations.push({
        range: new monaco.Range(frame.line, 1, frame.line, 1),
        options: {
          isWholeLine: true,
          className: 'dbg-stopped-line',
          glyphMarginClassName: 'dbg-stopped-arrow'
        }
      })
    }

    decorationIds = editor.deltaDecorations(decorationIds, decorations)
    // The breakpoint decorations were pushed first, in painted order.
    breakpointDecorationIds = decorationIds.slice(0, indices.length)
    paintedStoreIndices = indices
  }

  /*
   * The marks ride the buffer. Monaco moves decorations with edits; the store
   * holds plain line numbers. After each edit the decorations say where the
   * marks now stand, and the store follows — read before repaint, because
   * repainting replaces the very ids being read. Unpainted entries keep their
   * stored lines.
   */
  const contentSub = editor.onDidChangeModelContent((e) => {
    const model = editor.getModel()
    if (!model || model.uri.scheme !== 'file') return
    /*
     * A flush — revert, reload from disk — destroys every decoration on the
     * model, so the ids in hand describe nothing. Reading them would sync
     * garbage; repainting from the store is the only honest move.
     */
    if (e.isFlush) {
      decorationIds = []
      breakpointDecorationIds = []
      paintedStoreIndices = []
      paint()
      return
    }
    const held = breakpointsFor(model.uri.fsPath)
    if (!held) return
    if (breakpointDecorationIds.length > 0) {
      const lines = held.lines.map((l) => l.line)
      breakpointDecorationIds.forEach((id, i) => {
        const storeIndex = paintedStoreIndices[i]
        const at = model.getDecorationRange(id)?.startLineNumber
        if (storeIndex !== undefined && at !== undefined) lines[storeIndex] = at
      })
      syncBreakpointLines(model.uri.fsPath, lines)
    }
    // A mark past the old end of the buffer paints nothing — until the buffer
    // grows back under it, which no store change announces.
    if (paintedStoreIndices.length < held.lines.length) paint()
  })

  const click = editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
    const line = e.target.position?.lineNumber
    const model = editor.getModel()
    if (!line || !model || model.uri.scheme !== 'file') return
    e.event.preventDefault()
    if (e.event.rightButton) {
      // The dot's affairs — condition, log message — are managed in the Debug
      // view; a right-click on the margin walks there.
      if (breakpointsFor(model.uri.fsPath)?.lines.some((l) => l.line === line)) {
        useStore.getState().showSidebarView('debug')
      }
      return
    }
    // Middle-click is autoscroll, the side buttons are history — only the
    // left button means "put a mark here".
    if (!e.event.leftButton) return
    toggleBreakpoint(model.uri.fsPath, line)
  })

  const modelSub = editor.onDidChangeModel(() => {
    // Ids minted on the previous model must not be handed to the new one —
    // decoration ids can collide across models and hijack a stranger's marks.
    decorationIds = []
    breakpointDecorationIds = []
    paintedStoreIndices = []
    paint()
  })
  const unsubscribe = useDebugStore.subscribe(paint)
  paint()

  return () => {
    click.dispose()
    contentSub.dispose()
    modelSub.dispose()
    unsubscribe()
    decorationIds = editor.deltaDecorations(decorationIds, [])
  }
}

/**
 * While the program is stopped, a hover is a question the adapter can answer.
 * Registered once for every language; when nothing is stopped it declines
 * instantly and the language server's own hover speaks instead.
 */
let hoverRegistered = false

function registerDebugHover(): void {
  if (hoverRegistered) return
  hoverRegistered = true
  monaco.languages.registerHoverProvider('*', {
    provideHover: async (model, position) => {
      const s = useDebugStore.getState()
      if (s.status !== 'stopped' || !s.stoppedSessionId || s.activeFrameId === null) return null
      const word = model.getWordAtPosition(position)
      if (!word) return null
      const res = await window.ember.dapRequest(s.stoppedSessionId, 'evaluate', {
        expression: word.word,
        frameId: s.activeFrameId,
        context: 'hover'
      })
      if (!res.ok) return null
      const value = (res.body as { result?: unknown })?.result
      if (value === undefined || value === null) return null
      return {
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn
        ),
        contents: [{ value: `**${word.word}** = \`${String(value).slice(0, 300)}\`` }]
      }
    }
  })
}
