import { useEffect, useMemo, useRef, useState } from 'react'

export interface QuickPickItem {
  id: string
  label: string
  /** Shown dimmed after the label — a directory, or what a command does. */
  detail?: string
  /** Right-aligned, for a keyboard shortcut. */
  hint?: string
  /** What the filter matches against, when it is more than the label. */
  haystack?: string
}

interface Props {
  placeholder: string
  items: QuickPickItem[]
  onPick: (item: QuickPickItem) => void
  onClose: () => void
  /** Shown instead of the list when there is nothing to offer. */
  empty?: string
  /**
   * An item made from the query itself, appended after the matches — how a
   * picker offers "create what you just typed" without a second dialog. Return
   * null for queries that should offer nothing.
   */
  craft?: (query: string) => QuickPickItem | null
}

/**
 * The overlay behind quick open and the command palette.
 *
 * One component for both because they are the same interaction — type, filter,
 * arrow, enter — and the differences are entirely in what fills the list. Keeping
 * them together is what stops them drifting into two subtly different behaviours.
 */
export function QuickPick({ placeholder, items, onPick, onClose, empty, craft }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [index, setIndex] = useState(0)
  const box = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    box.current?.focus()
  }, [])

  const matches = useMemo(() => {
    const scored = items
      .map((item) => ({ item, score: fuzzyScore(item.haystack ?? item.label, text) }))
      .filter((s) => s.score !== null)
    // Stable: equal scores keep the order they were given in, which for files is
    // ripgrep's walk order and for commands is the order they were registered.
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const list = scored.slice(0, 200).map((s) => s.item)
    const crafted = craft && text.trim().length > 0 ? craft(text) : null
    return crafted ? [...list, crafted] : list
  }, [items, text, craft])

  useEffect(() => {
    setIndex(0)
  }, [text])

  // Keep the highlighted row on screen when arrowing past the visible window.
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('.qp__item--on')
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const move = (delta: number): void => {
    if (matches.length === 0) return
    setIndex((i) => (i + delta + matches.length) % matches.length)
  }

  return (
    <div className="qp__scrim" onMouseDown={onClose}>
      <div className="qp" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={box}
          className="qp__box"
          placeholder={placeholder}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
              e.preventDefault()
              move(1)
            } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) {
              e.preventDefault()
              move(-1)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const chosen = matches[index]
              if (chosen) onPick(chosen)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />

        <div className="qp__list" ref={list}>
          {matches.length === 0 && <div className="qp__none">{empty ?? 'No matches'}</div>}
          {matches.map((item, i) => (
            <button
              key={item.id}
              className={`qp__item ${i === index ? 'qp__item--on' : ''}`}
              // Mouse down rather than click: the scrim closes on mousedown, and a
              // click would land after the overlay had already gone.
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(item)
              }}
              onMouseEnter={() => setIndex(i)}
            >
              <span className="qp__label">{item.label}</span>
              {item.detail && <span className="qp__detail">{item.detail}</span>}
              {item.hint && <span className="qp__hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Subsequence matching, the way every quick-open box works: `epts` finds
 * `EditorPane.tsx`. Returns null when the query does not appear at all.
 *
 * Scoring rewards matches that start a word or follow a separator, so typing
 * initials finds the file rather than whichever path happens to contain those
 * letters scattered through it.
 */
function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase().replace(/\s+/g, '')

  let score = 0
  let at = 0
  let previous = -1
  for (const char of needle) {
    const found = haystack.indexOf(char, at)
    if (found === -1) return null

    // Adjacent characters are worth more than scattered ones.
    if (found === previous + 1) score += 8
    // A match at a word boundary is what someone typing initials means.
    const before = found > 0 ? haystack[found - 1] : '/'
    if (before === '/' || before === '\\' || before === '.' || before === '-' || before === '_') {
      score += 12
    }
    score += 1
    previous = found
    at = found + 1
  }

  // Shorter targets win ties: `App.tsx` should beat `SomeOtherApp.test.tsx`.
  return score - haystack.length * 0.05
}
