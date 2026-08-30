import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { textFromHtml } from '../terminal/serialize'

interface Props {
  /** The pane being searched — the bar reads its blocks to see into folded ones. */
  paneId: string
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
export function FindBar({ paneId, scroller, revision, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const pane = useStore((s) => s.terminalPane(paneId))
  const setBlockCollapsed = useStore((s) => s.setBlockCollapsed)

  useEffect(() => input.current?.focus(), [])

  /*
   * A folded block's text is not in the DOM — its body is unmounted — so walking
   * the scroller silently skipped it, and "no matches" while the match sat in a
   * collapsed build log was a wrong answer wearing a truthful face. The block
   * data can always be read: any folded block whose text holds the query is
   * unfolded so the walk below can see it, and the bar remembers which ones it
   * opened so closing it folds them back the way they were.
   *
   * The plain text of each block is extracted once and cached against the size
   * of its output, through the serializer's own inverse — `innerText` on a
   * detached node silently drops every line break, which ran adjacent lines
   * together and let a query match across a boundary that was never there.
   */
  const textCache = useRef(new Map<string, { size: number; text: string }>())
  const opened = useRef(new Set<string>())
  useEffect(() => {
    const needle = query.toLowerCase()
    if (!pane || needle.length === 0) return
    for (const block of pane.blocks) {
      if (!block.collapsed) continue
      const raw = block.kind === 'command' ? block.output : block.answer
      const key = block.id
      const cached = textCache.current.get(key)
      let text: string
      if (cached && cached.size === raw.length) {
        text = cached.text
      } else {
        text =
          `${block.kind === 'command' ? block.command : ''}\n${textFromHtml(raw)}`.toLowerCase()
        textCache.current.set(key, { size: raw.length, text })
      }
      if (text.includes(needle)) {
        setBlockCollapsed(paneId, block.id, false)
        opened.current.add(block.id)
      }
    }
  }, [query, revision, pane, paneId, setBlockCollapsed])

  /** Close the bar and fold back what it unfolded — only what it unfolded. */
  const close = (): void => {
    for (const id of opened.current) setBlockCollapsed(paneId, id, true)
    opened.current.clear()
    onClose()
  }

  /*
   * State rather than a memo, deliberately: unfolding a block above mounts its
   * body on the NEXT commit, and a memo computed during render walks the DOM as
   * it was. An effect runs after the commit and sees the newly mounted text.
   */
  const [ranges, setRanges] = useState<Range[]>([])
  const collapsedKey = pane ? pane.blocks.filter((b) => b.collapsed).length : 0
  useEffect(() => {
    const root = scroller.current
    const needle = query.toLowerCase()
    if (!root || needle.length === 0) {
      setRanges([])
      return
    }

    const found: Range[] = []
    outer: for (const node of textNodes(root)) {
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
        if (found.length >= 2000) break outer
      }
    }
    setRanges(found)
  }, [query, revision, scroller, collapsedKey])

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
          if (e.key === 'Escape') close()
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
      <button className="find__step" aria-label="Close find" onClick={close}>
        ✕
      </button>
    </div>
  )
}
