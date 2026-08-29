import { monaco } from './monaco'
import { breakpointsFor, toggleBreakpoint, useDebugStore } from '../state/debug'

/**
 * What debugging looks like inside an editor: dots in the glyph margin where
 * breakpoints stand — filled once an adapter has verified them, hollow while
 * they are only a wish — and the line the program is stopped on, painted and
 * pointed at. A click in the margin is the toggle; everything else is state.
 */

export function wireDebugging(editor: monaco.editor.IStandaloneCodeEditor): () => void {
  let decorationIds: string[] = []

  const paint = (): void => {
    const model = editor.getModel()
    if (!model || model.uri.scheme !== 'file') {
      decorationIds = editor.deltaDecorations(decorationIds, [])
      return
    }
    const filePath = model.uri.fsPath
    const decorations: monaco.editor.IModelDeltaDecoration[] = []

    const file = breakpointsFor(filePath)
    for (const bp of file?.lines ?? []) {
      if (bp.line > model.getLineCount()) continue
      decorations.push({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: bp.verified ? 'dbg-breakpoint' : 'dbg-breakpoint dbg-breakpoint--wish',
          glyphMarginHoverMessage: {
            value: bp.verified ? 'Breakpoint' : 'Breakpoint — not yet verified by the adapter'
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
  }

  const click = editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
    const line = e.target.position?.lineNumber
    const model = editor.getModel()
    if (!line || !model || model.uri.scheme !== 'file') return
    e.event.preventDefault()
    toggleBreakpoint(model.uri.fsPath, line)
  })

  const modelSub = editor.onDidChangeModel(paint)
  const unsubscribe = useDebugStore.subscribe(paint)
  paint()

  return () => {
    click.dispose()
    modelSub.dispose()
    unsubscribe()
    decorationIds = editor.deltaDecorations(decorationIds, [])
  }
}
