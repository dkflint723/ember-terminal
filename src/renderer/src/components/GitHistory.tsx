import { useCallback, useEffect, useState } from 'react'
import type { GitLogEntry } from '@shared/types'
import { useStore } from '../state/store'
import { existingController } from '../terminal/controller'
import { ago } from '../util/relative-time'

interface Props {
  root: string | null
}

/** Enough to cover "what happened lately" without paying for a whole history. */
const COUNT = 30

/**
 * What changed before now.
 *
 * The panel could already show a diff of the working tree and nothing at all of
 * the past, which is half of what people open a source-control view for.
 *
 * Pressing a commit runs `git show` for it in the terminal, rather than opening a
 * viewer of its own. That is not a shortcut taken to avoid building one — it is
 * the better answer in this app specifically: the result arrives as a block with
 * its own scrollback and search, next to every other command, and it is a real
 * command the user can then edit, re-run, or pipe somewhere.
 */
export function GitHistory({ root }: Props): React.JSX.Element | null {
  const [entries, setEntries] = useState<GitLogEntry[]>([])
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    if (!root) {
      setEntries([])
      return
    }
    setEntries(await window.ember.gitLog(root, null, COUNT).catch(() => []))
    setLoaded(true)
  }, [root])

  // Read only once opened: a log is a process, and the section starts collapsed
  // because the changes above it are what the panel is for.
  useEffect(() => {
    if (open && !loaded) void reload()
  }, [open, loaded, reload])

  // A new commit invalidates it, and the root changing replaces it entirely.
  useEffect(() => {
    setLoaded(false)
    setEntries([])
  }, [root])

  if (!root) return null

  const show = (entry: GitLogEntry): void => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return
    const active = s.panes[tab.activePaneId]
    const pane =
      active?.kind === 'terminal'
        ? active
        : Object.values(s.panes).find((p) => p.kind === 'terminal')
    if (pane?.kind !== 'terminal') return
    existingController(pane.id)?.runCommand(`git show ${entry.short}`)
  }

  return (
    <div className="scm__section">
      <div className="scm__section-head">
        <button
          type="button"
          className="scm__section-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="scm__chevron">{open ? '▾' : '▸'}</span> History
        </button>
        {open && (
          <button className="icon-btn" title="Re-read the log" onClick={() => void reload()}>
            ↻
          </button>
        )}
      </div>

      {open &&
        (entries.length === 0 ? (
          <div className="scm__clean">{loaded ? 'No commits yet' : 'Reading…'}</div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.hash}
              type="button"
              className="log__row"
              title={`git show ${entry.short}\n\n${entry.subject}\n${entry.author}`}
              onClick={() => show(entry)}
            >
              <span className="log__hash">{entry.short}</span>
              <span className="log__subject">
                {/* A merge's diff is not what its subject implies, so it says so. */}
                {entry.merge && <span className="log__merge">merge</span>}
                {entry.subject}
              </span>
              <span className="log__when">{ago(entry.authoredAt)}</span>
            </button>
          ))
        ))}
    </div>
  )
}
