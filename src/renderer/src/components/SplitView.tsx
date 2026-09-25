import { Fragment, lazy, Suspense, useRef } from 'react'
import { useStore, type LayoutNode } from '../state/store'
import { TerminalPane } from './TerminalPane'

/*
 * The two panes that are Monaco, loaded the first time one is drawn.
 *
 * Imported statically they put the whole editor in the startup bundle, and a
 * session that is a terminal and nothing else paid for it on every launch. The
 * preload after the first prompt usually has them ready before anyone asks.
 */
const EditorPane = lazy(() => import('./EditorPane').then((m) => ({ default: m.EditorPane })))
const DiffPane = lazy(() => import('./DiffPane').then((m) => ({ default: m.DiffPane })))

/** What stands in a pane's place for the moment its editor is loading. */
function Loading(): React.JSX.Element {
  return <div className="pane pane--loading" aria-busy="true" />
}

interface Props {
  tabId: string
  /** Which of the tab's two layouts this tree belongs to, for resizing. */
  region: 'shells' | 'editors'
  node: LayoutNode
  path: number[]
  activePaneId: string
}

/** Recursively renders the pane tree, with draggable dividers between children. */
export function SplitView({ tabId, region, node, path, activePaneId }: Props): React.JSX.Element | null {
  const panes = useStore((s) => s.panes)
  const setActivePane = useStore((s) => s.setActivePane)
  const setSizes = useStore((s) => s.setSizes)
  const container = useRef<HTMLDivElement>(null)

  if (node.type === 'leaf') {
    const pane = panes[node.paneId]
    if (!pane) return null
    if (pane.kind === 'editor') {
      return (
        <Suspense fallback={<Loading />}>
          <EditorPane
            pane={pane}
            tabId={tabId}
            active={pane.id === activePaneId}
            onFocus={() => setActivePane(tabId, pane.id)}
          />
        </Suspense>
      )
    }
    if (pane.kind === 'diff') {
      return (
        <Suspense fallback={<Loading />}>
          <DiffPane
            pane={pane}
            active={pane.id === activePaneId}
            onFocus={() => setActivePane(tabId, pane.id)}
          />
        </Suspense>
      )
    }
    /*
     * Keyed by the pane, because a leaf is not a position.
     *
     * A session with one pane renders its leaf here rather than in the keyed list
     * below, so switching sessions gave React the same element type in the same
     * place: it kept the mounted TerminalPane and changed its prop. The host div
     * survived with it, and every session visited added its terminal to that one
     * div. Keyed, a different pane is a different component, and the one going away
     * is unmounted — which is what hands its terminal back.
     */
    return (
      <TerminalPane
        key={pane.id}
        pane={pane}
        active={pane.id === activePaneId}
        onFocus={() => setActivePane(tabId, pane.id)}
      />
    )
  }

  const row = node.direction === 'row'

  const startDrag = (index: number, e: React.MouseEvent): void => {
    e.preventDefault()
    const box = container.current?.getBoundingClientRect()
    if (!box) return

    const total = row ? box.width : box.height
    const startPos = row ? e.clientX : e.clientY
    const startSizes = [...node.sizes]
    const target = e.currentTarget as HTMLElement
    target.classList.add('divider--dragging')

    const onMove = (ev: MouseEvent): void => {
      const delta = ((row ? ev.clientX : ev.clientY) - startPos) / total
      const next = [...startSizes]
      // Move the boundary between index and index+1, keeping both usable.
      const min = 0.1
      const pair = startSizes[index] + startSizes[index + 1]
      next[index] = Math.min(Math.max(startSizes[index] + delta, min), pair - min)
      next[index + 1] = pair - next[index]
      setSizes(tabId, region, path, next)
    }

    const onUp = (): void => {
      target.classList.remove('divider--dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div ref={container} className={`split split--${node.direction}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.type === 'leaf' ? child.paneId : `split-${i}`}>
          <div
            className="split__child"
            style={{ flex: `${node.sizes[i] ?? 1} 1 0`, minWidth: 0, minHeight: 0 }}
          >
            <SplitView
              tabId={tabId}
              region={region}
              node={child}
              path={[...path, i]}
              activePaneId={activePaneId}
            />
          </div>
          {i < node.children.length - 1 && (
            <div
              className={`divider divider--${node.direction}`}
              onMouseDown={(e) => startDrag(i, e)}
            />
          )}
        </Fragment>
      ))}
    </div>
  )
}
