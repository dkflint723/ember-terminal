import { useEffect, useState, type RefObject } from 'react'
import type { Block } from '../state/store'

interface Mark {
  id: string
  /** Where the block starts, as a share of the whole scrollable height. */
  top: number
  failed: boolean
  offset: number
}

export interface BlockGeometry {
  marks: Mark[]
  /** The visible slice, as shares of the whole — top and height. */
  viewport: { top: number; height: number }
  /** The block whose head is currently pinned, if any. */
  stuckId: string | null
}

/**
 * Where every block sits in the scroll container, measured rather than guessed.
 *
 * Two things need this and neither can work it out from the block list alone: the
 * ruler needs each block's position as a share of the whole, and the sticky head
 * needs to know *which* block is currently pinned so only that one carries the
 * shadow — a shadow under every head would put back the filled header bars that
 * flattening the list just removed.
 *
 * Measured on an animation frame and only published when something actually moved,
 * because this runs on every scroll event of a list that can hold hundreds of
 * blocks.
 */
export function useBlockGeometry(
  scroller: RefObject<HTMLElement | null>,
  blocks: Block[]
): BlockGeometry {
  const [geometry, setGeometry] = useState<BlockGeometry>({
    marks: [],
    viewport: { top: 0, height: 1 },
    stuckId: null
  })

  useEffect(() => {
    const el = scroller.current
    if (!el) return

    let frame = 0
    const measure = (): void => {
      frame = 0
      const total = el.scrollHeight
      if (total <= 0) return

      const marks: Mark[] = []
      let stuckId: string | null = null
      for (const child of Array.from(el.children)) {
        if (!(child instanceof HTMLElement)) continue
        const id = child.dataset.blockId
        if (!id) continue
        const offset = child.offsetTop
        marks.push({
          id,
          top: offset / total,
          failed: child.classList.contains('block--failed'),
          offset
        })
        // The pinned one is whichever block the top of the viewport is inside.
        if (offset <= el.scrollTop && offset + child.offsetHeight > el.scrollTop) stuckId = id
      }

      const next: BlockGeometry = {
        marks,
        viewport: { top: el.scrollTop / total, height: Math.min(1, el.clientHeight / total) },
        stuckId
      }
      setGeometry((prev) => (same(prev, next) ? prev : next))
    }

    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure)
    }

    measure()
    el.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      el.removeEventListener('scroll', schedule)
      observer.disconnect()
    }
  }, [scroller, blocks])

  return geometry
}

/** Cheap equality, to keep a scroll from re-rendering the pane for nothing. */
function same(a: BlockGeometry, b: BlockGeometry): boolean {
  if (a.stuckId !== b.stuckId) return false
  if (Math.abs(a.viewport.top - b.viewport.top) > 0.001) return false
  if (Math.abs(a.viewport.height - b.viewport.height) > 0.001) return false
  if (a.marks.length !== b.marks.length) return false
  return a.marks.every((m, i) => m.id === b.marks[i].id && Math.abs(m.top - b.marks[i].top) < 0.001)
}

/**
 * A 12px column down the right edge: one mark per block, failures picked out, and
 * the visible slice shaded.
 *
 * Monaco's idiom, borrowed for the block list — a long session is a document, and
 * the question "where were the failures" should be answerable without scrolling
 * through it. Clicking a mark sets scrollTop rather than calling scrollIntoView,
 * which would animate the whole pane and fight the sticky head.
 */
export function OverviewRuler({
  geometry,
  scroller
}: {
  geometry: BlockGeometry
  scroller: RefObject<HTMLElement | null>
}): React.JSX.Element | null {
  if (geometry.marks.length === 0) return null

  return (
    <div className="ruler" aria-hidden="true">
      <span
        className="ruler__viewport"
        style={{ top: `${geometry.viewport.top * 100}%`, height: `${geometry.viewport.height * 100}%` }}
      />
      {geometry.marks.map((m) => (
        <span
          key={m.id}
          className={`ruler__mark ${m.failed ? 'ruler__mark--failed' : ''}`}
          style={{ top: `${m.top * 100}%` }}
          onMouseDown={() => {
            if (scroller.current) scroller.current.scrollTop = m.offset
          }}
        />
      ))}
    </div>
  )
}
