import { useEffect, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { useStore } from '../state/store'

function timeAgo(ms: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(ms).toLocaleDateString()
}

/** Shorten a path for a narrow column, keeping the tail that identifies it. */
function shortPath(cwd: string, home: string): string {
  const path = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : `…\\${parts.slice(-2).join('\\')}`
}

/**
 * Search across every command ever run. The block model already captures the
 * command, its directory, exit status and output, so history can answer questions
 * a scrollback cannot — including matching on what a command *printed*.
 */
export function HistorySearch(): React.JSX.Element | null {
  const open = useStore((s) => s.historyOpen)
  const toggle = useStore((s) => s.toggleHistory)
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)

  const [text, setText] = useState('')
  const [scopeToCwd, setScopeToCwd] = useState(false)
  const [onlyFailures, setOnlyFailures] = useState(false)
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activePane = activeTab ? panes[activeTab.activePaneId] : undefined
  const cwd = activePane?.kind === 'terminal' ? activePane.cwd : ''

  useEffect(() => {
    if (open) {
      setText('')
      setIndex(0)
      inputRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.ember
      .searchHistory({
        text: text.trim() || undefined,
        cwd: scopeToCwd && cwd ? cwd : undefined,
        onlyFailures,
        limit: 200
      })
      .then((rows) => {
        if (cancelled) return
        setEntries(rows)
        setIndex(0)
      })
    return () => {
      cancelled = true
    }
  }, [open, text, scopeToCwd, onlyFailures, cwd])

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('.hist__item--on')?.scrollIntoView({ block: 'nearest' })
  }, [index, entries])

  if (!open) return null

  /**
   * Put the command in the input rather than running it. A history entry can be
   * destructive, and its original directory may not be the current one.
   */
  const insert = (entry: HistoryEntry): void => {
    if (!activeTab) return
    useStore.getState().setPendingInput(activeTab.activePaneId, entry.command)
    toggle(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      toggle(false)
      return
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
      e.preventDefault()
      setIndex((i) => (entries.length === 0 ? 0 : (i + 1) % entries.length))
      return
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) {
      e.preventDefault()
      setIndex((i) => (entries.length === 0 ? 0 : (i - 1 + entries.length) % entries.length))
      return
    }
    if (e.key === 'Enter' && entries[index]) {
      e.preventDefault()
      insert(entries[index])
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={() => toggle(false)}>
      <div className="hist" onMouseDown={(e) => e.stopPropagation()}>
        <div className="hist__head">
          <span className="composer__sigil">⌕</span>
          <input
            ref={inputRef}
            className="hist__input"
            placeholder="search commands and their output…"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        {/*
          Two independent booleans, so both can be on at once — which is why
          neither of them may be the accent fill. That fill means "the one
          important action here", and two of them lit side by side means nothing.
          .btn--on is the quiet selected state instead: the same treatment the
          active panel tab uses, an edge and full-strength text.
        */}
        <div className="hist__filters">
          <button
            className={`btn ${scopeToCwd ? 'btn--on' : ''}`}
            aria-pressed={scopeToCwd}
            onClick={() => setScopeToCwd((v) => !v)}
            disabled={!cwd}
            title={cwd || 'No directory'}
          >
            this directory
          </button>
          <button
            className={`btn ${onlyFailures ? 'btn--on' : ''}`}
            aria-pressed={onlyFailures}
            onClick={() => setOnlyFailures((v) => !v)}
          >
            failures only
          </button>
          <span className="hist__count">{entries.length} results</span>
        </div>

        <div className="hist__list" ref={listRef}>
          {entries.length === 0 && (
            <div className="hist__empty">
              {text.trim().length > 0 ? 'No matching commands.' : 'No history yet.'}
            </div>
          )}
          {entries.map((entry, i) => (
            <button
              key={entry.id}
              className={`hist__item ${i === index ? 'hist__item--on' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                insert(entry)
              }}
            >
              <span
                className={`block__status block__status--${
                  entry.exitCode === null ? 'running' : entry.exitCode === 0 ? 'done' : 'failed'
                }`}
              >
                {entry.exitCode === null ? '·' : entry.exitCode === 0 ? '✓' : '✕'}
              </span>
              <span className="hist__cmd">{entry.command}</span>
              <span className="hist__meta">
                {shortPath(entry.cwd, window.ember.homeDir)} · {timeAgo(entry.startedAt)}
              </span>
            </button>
          ))}
        </div>

        <div className="complete__foot">
          <span>Enter puts the command in the input — it does not run it</span>
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
