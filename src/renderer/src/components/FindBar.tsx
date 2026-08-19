import { useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  /** The scroller whose text is searched, and which is scrolled to a match. */
  scroller: React.RefObject<HTMLDivElement | null>
  /** Re-run the search when the blocks underneath change. */
  revision: number
  onClose: () => void
}

/** Every text node under a root, in document order. */
function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const out: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

/**
 * Find in the output of one terminal.
 *
 * Blocks are the history — everything this shell has run, still on screen and still
 * growing — and there was no way to look through them for a path or an error but to
 * scroll. Ctrl+F is what everyone reaches for and it did nothing at all.
 *
 * Matches are drawn with the CSS custom highlight API rather than by wrapping them
 * in elements. Blocks hold serialized output whose markup carries the colours a
 * program chose, and rewriting that markup to insert marks would mean rebuilding it
 * to take them out again — with the selection, the copy button and the ruler's
 * measurements all reading whatever was left behind. A highlight paints over the
 * text and owns nothing.
 */
export function FindBar({ scroller, revision, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  // Recomputed when the query changes, and when the pane does: a command that
  // finishes while the bar is open adds text that should be searchable too.
  const ranges = useMemo(() => {
    const root = scroller.current
    const needle = query.toLowerCase()
    if (!root || needle.length === 0) return [] as Range[]

    const found: Range[] = []
    for (const node of textNodes(root)) {
      const hay = (node.textContent ?? '').toLowerCase()
      let at = hay.indexOf(needle)
      while (at !== -1) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        found.push(range)
        at = hay.indexOf(needle, at + needle.length)
        // A pane holding a long build log can match thousands of times; past a few
        // hundred the count stops being useful and the paint starts costing.
        if (found.length >= 2000) return found
      }
    }
    return found
  }, [query, revision, scroller])

  // Clamp rather than reset: typing another character usually keeps you near the
  // match you were reading.
  const current = ranges.length === 0 ? 0 : Math.min(index, ranges.length - 1)

  useEffect(() => {
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (!highlights || !Ctor) return

    highlights.set('ember-find', new Ctor(...ranges))
    const here = ranges[current]
    highlights.set('ember-find-current', here ? new Ctor(here) : new Ctor())
    here?.startContainer.parentElement?.scrollIntoView({ block: 'center' })

    return () => {
      highlights.delete('ember-find')
      highlights.delete('ember-find-current')
    }
  }, [ranges, current])

  const step = (by: number): void => {
    if (ranges.length === 0) return
    setIndex((i) => (i + by + ranges.length) % ranges.length)
  }

  return (
    <div className="find" role="search">
      <input
        ref={input}
        className="find__input"
        placeholder="Find in output…"
        aria-label="Find in this terminal's output"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setIndex(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="find__count">
        {query.length === 0 ? '' : ranges.length === 0 ? 'no matches' : `${current + 1} of ${ranges.length}`}
      </span>
      <button className="find__step" aria-label="Previous match" onClick={() => step(-1)}>
        ▲
      </button>
      <button className="find__step" aria-label="Next match" onClick={() => step(1)}>
        ▼
      </button>
      <button className="find__step" aria-label="Close find" onClick={onClose}>
        ✕
      </button>
    </div>
  )
}
