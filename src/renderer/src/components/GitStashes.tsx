import { useCallback, useEffect, useState } from 'react'
import type { GitStashEntry, GitSimpleResult } from '@shared/types'
import { ago } from '../util/relative-time'

interface Props {
  root: string | null
  busy: boolean
  /** Runs a mutation and re-reads the repository. Returns whether it worked. */
  act: (fn: () => Promise<GitSimpleResult>) => Promise<boolean>
}

/**
 * The stash: somewhere to put the working tree down.
 *
 * The standard escape hatch when a branch has to change under a half-finished
 * thought, and the last of the everyday git operations this panel could not do.
 *
 * Untracked files go in with the rest — see stashPush — because the alternative
 * is a stash that looks complete and silently leaves new files behind, to be
 * carried into whatever branch is checked out next.
 */
export function GitStashes({ root, busy, act }: Props): React.JSX.Element | null {
  const [entries, setEntries] = useState<GitStashEntry[]>([])
  const [open, setOpen] = useState(true)
  /*
   * Dropping is the one thing here nothing undoes, so it asks twice. A second
   * click within a few seconds is the confirmation; anything else disarms it.
   * A modal would be heavier than the action deserves, and a modal people learn
   * to dismiss is not a confirmation at all.
   */
  const [armed, setArmed] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    if (!root) {
      setEntries([])
      return
    }
    setEntries(await window.ember.gitStashList(root).catch(() => []))
  }, [root])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(null), 4000)
    return () => window.clearTimeout(t)
  }, [armed])

  if (!root) return null

  const run = async (fn: () => Promise<GitSimpleResult>): Promise<void> => {
    await act(fn)
    await reload()
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
          <span className="scm__chevron">{open ? '▾' : '▸'}</span> Stashes
        </button>
        <span className="scm__count">{entries.length}</span>
        <button
          className="icon-btn"
          title="Stash all changes, including untracked files"
          disabled={busy}
          onClick={() => void run(() => window.ember.gitStashPush(root, ''))}
        >
          ↧
        </button>
      </div>

      {open &&
        (entries.length === 0 ? (
          <div className="scm__clean">Nothing stashed</div>
        ) : (
          entries.map((entry) => (
            <div key={entry.ref} className="scm__row stash__row">
              <span className="stash__text" title={`${entry.ref} — ${entry.subject}`}>
                <span className="stash__subject">{entry.subject}</span>
                <span className="stash__when">{ago(entry.at)}</span>
              </span>
              <span className="scm__actions">
                <button
                  className="icon-btn"
                  title="Apply and remove from the stash"
                  disabled={busy}
                  onClick={() => void run(() => window.ember.gitStashApply(root, entry.ref, true))}
                >
                  ↥
                </button>
                <button
                  className="icon-btn"
                  title="Apply but keep it stashed"
                  disabled={busy}
                  onClick={() => void run(() => window.ember.gitStashApply(root, entry.ref, false))}
                >
                  ⎘
                </button>
                <button
                  className={`icon-btn ${armed === entry.ref ? 'icon-btn--armed' : ''}`}
                  title={
                    armed === entry.ref
                      ? 'Press again to discard this stash for good'
                      : 'Discard this stash'
                  }
                  disabled={busy}
                  onClick={() => {
                    if (armed !== entry.ref) {
                      setArmed(entry.ref)
                      return
                    }
                    setArmed(null)
                    void run(() => window.ember.gitStashDrop(root, entry.ref))
                  }}
                >
                  {armed === entry.ref ? 'sure?' : '✕'}
                </button>
              </span>
            </div>
          ))
        ))}
    </div>
  )
}
