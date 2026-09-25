import { useEffect, useId, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { useStore } from '../state/store'
import { useDialog } from './useDialog'

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
  const dialogRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  useDialog(dialogRef, open, () => toggle(false))

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

  /**
   * Take one command out of history for good.
   *
   * The patterns that keep credentials out of the database are a net rather than a
   * proof, and until now a command that slipped through one of them could only be
   * removed by clearing the lot. The row goes from the list as it goes from the
   * file, so the answer to "is it gone" is on screen rather than at the next search.
   *
   * By its text, because that is what main deletes by. The same line run twice is
   * two rows, and forgetting one takes both out of the file; filtering the list by
   * the id that was clicked left the twin on screen, naming a command that was no
   * longer anywhere on disk. The list said less had been forgotten than had been.
   */
  const forget = async (entry: HistoryEntry): Promise<void> => {
    await window.ember.forgetCommand(entry.id)
    setEntries((rows) => rows.filter((r) => r.command !== entry.command))
    setIndex(0)
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
      return
    }
    // Shift+Delete, which is what every shell and browser history uses for this,
    // and which leaves Delete itself doing its ordinary job in the search box.
    if (e.shiftKey && e.key === 'Delete' && entries[index]) {
      e.preventDefault()
      void forget(entries[index])
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={() => toggle(false)}>
      <div
        ref={dialogRef}
        className="hist"
        role="dialog"
        aria-modal="true"
        aria-label="Command history"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="hist__head">
          <span className="composer__sigil">⌕</span>
          <input
            ref={inputRef}
            className="hist__input"
            placeholder="search commands and their output…"
            spellCheck={false}
            value={text}
            role="combobox"
            aria-label="Search command history"
            aria-expanded={entries.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={entries[index] ? `${listId}-${index}` : undefined}
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
          <span className="hist__count" role="status">
            {entries.length} results
          </span>
        </div>

        {entries.length === 0 && (
          <div className="hist__empty">
            {text.trim().length > 0 ? 'No matching commands.' : 'No history yet.'}
          </div>
        )}
        <div
          className="hist__list"
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Commands"
          hidden={entries.length === 0}
        >
          {entries.map((entry, i) => (
            <div className="hist__row" key={entry.id} role="presentation">
            <button
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              tabIndex={-1}
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
            {/* The pointer's way to do what Shift+Delete does on the chosen row, so
                it is kept out of the listbox a screen reader walks and out of the
                tab order the dialog cycles through. */}
            <button
              className="hist__forget"
              data-forget={entry.id}
              tabIndex={-1}
              aria-hidden="true"
              title="Forget this command (Shift+Delete)"
              aria-label={`Forget ${entry.command}`}
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void forget(entry)
              }}
            >
              ×
            </button>
            </div>
          ))}
        </div>

        <div className="complete__foot">
          <span>Enter puts the command in the input — it does not run it</span>
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Shift</kbd> <kbd>Del</kbd> forget ·{' '}
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
