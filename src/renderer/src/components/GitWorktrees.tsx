import { useCallback, useEffect, useState } from 'react'
import type { GitSimpleResult } from '@shared/types'
import { pathKey } from '@shared/paths'
import { terminalPaneIdFor, useStore } from '../state/store'

interface Props {
  root: string | null
  busy: boolean
  act: (fn: () => Promise<GitSimpleResult>) => Promise<boolean>
}

type Worktree = { path: string; branch: string | null; main: boolean; locked: boolean }

/**
 * Worktrees, as sessions beside each other (audit R33).
 *
 * Parallel work on another branch meant a second clone, or stashing and switching
 * the one checkout back and forth. A worktree is a second checkout of the same
 * repository, and each one is opened here as a session of its own — its own shells,
 * its own agent, its own project. Made beside the repository as `repo-branch`;
 * removed only after asking, and refused while it holds anything removing it would
 * lose.
 */
export function GitWorktrees({ root, busy, act }: Props): React.JSX.Element | null {
  const [list, setList] = useState<Worktree[]>([])
  const [open, setOpen] = useState(true)
  const [draft, setDraft] = useState('')
  const [making, setMaking] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    setList(root ? await window.ember.gitWorktrees(root).catch(() => []) : [])
  }, [root])

  useEffect(() => {
    void reload()
  }, [reload])

  // Asked from the palette: open this section and put the caret in its field.
  useEffect(() => {
    const focus = (): void => {
      setOpen(true)
      window.setTimeout(() => document.querySelector<HTMLInputElement>('.worktree__new')?.focus(), 50)
    }
    window.addEventListener('ember:new-worktree', focus)
    return () => window.removeEventListener('ember:new-worktree', focus)
  }, [])

  if (!root) return null

  /** As a session of its own: a new tab whose project and shell are the worktree. */
  const openAsSession = (path: string): void => {
    const s = useStore.getState()
    const existing = s.tabs.find((t) => t.workspace && pathKey(t.workspace) === pathKey(path))
    if (existing) {
      s.setActiveTab(existing.id)
      return
    }
    // The same shell as the terminal in front, or the first there is.
    const paneId = terminalPaneIdFor(s)
    const profile = (paneId ? s.terminalPane(paneId)?.profileId : undefined) ?? s.profiles[0]?.id
    if (profile) s.newTab(profile, path, path)
  }

  const make = async (): Promise<void> => {
    const branch = draft.trim()
    if (!branch || making) return
    setMaking(true)
    const made = await window.ember.gitWorktreeAdd(root, branch)
    setMaking(false)
    if (!made.ok) {
      useStore.getState().setNotice(`The worktree was not made: ${made.error}`, 'error')
      return
    }
    setDraft('')
    await reload()
    openAsSession(made.path)
  }

  const remove = async (w: Worktree): Promise<void> => {
    /*
     * Sessions open in it are closed first: a shell whose folder it is holds the folder,
     * and Windows will not delete a folder a process is standing in. Said in the
     * question, so closing them is part of what is agreed to.
     */
    const s = useStore.getState()
    const inside = s.tabs.filter((t) => t.workspace && (pathKey(t.workspace) === pathKey(w.path) || pathKey(t.workspace).startsWith(`${pathKey(w.path)}/`)))
    const sessions = inside.length > 0 ? ` Its ${inside.length === 1 ? 'session' : `${inside.length} sessions`} here will be closed.` : ''
    if (!window.confirm(`Remove the worktree at ${w.path}${w.branch ? ` (${w.branch})` : ''}? Its folder is deleted; the branch stays.${sessions}`)) return
    // Checked before anything is closed: a worktree with work in it is refused anyway.
    const changed = await act(() => window.ember.gitWorktreeRemove(root, w.path, { dryRun: true }))
    if (!changed) return
    for (const tab of inside) useStore.getState().closeTab(tab.id, true)
    // A moment for the shells to end and let go of the folder.
    if (inside.length > 0) await new Promise((r) => window.setTimeout(r, 1500))
    await act(() => window.ember.gitWorktreeRemove(root, w.path))
    await reload()
  }

  return (
    <div className="scm__section">
      <div className="scm__section-head">
        <button type="button" className="scm__section-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="scm__chevron">{open ? '▾' : '▸'}</span> Worktrees
        </button>
        <span className="scm__count">{list.length}</span>
      </div>
      {open && (
        <>
          {list.map((w) => (
            <div key={w.path} className="scm__row worktree__row">
              <span className="stash__text" title={w.path}>
                <span className="stash__subject">{w.branch ?? '(detached)'}</span>
                <span className="stash__when">{w.main ? 'this repository' : w.path.split(/[\\/]/).pop()}</span>
              </span>
              <span className="scm__actions">
                <button className="icon-btn" title={`Open ${w.path} as a session`} aria-label={`Open ${w.branch ?? w.path} as a session`} onClick={() => openAsSession(w.path)}>
                  ⧉
                </button>
                {!w.main && (
                  <button
                    className="icon-btn"
                    title="Remove this worktree"
                    aria-label={`Remove the worktree ${w.branch ?? w.path}`}
                    disabled={busy || w.locked}
                    onClick={() => void remove(w)}
                  >
                    ✕
                  </button>
                )}
              </span>
            </div>
          ))}
          <form
            className="scm__row worktree__form"
            onSubmit={(e) => {
              e.preventDefault()
              void make()
            }}
          >
            <input
              className="worktree__new"
              aria-label="Branch for a new worktree"
              placeholder="New branch, in a worktree of its own"
              spellCheck={false}
              value={draft}
              disabled={busy || making}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className="btn" type="submit" disabled={busy || making || !draft.trim()}>
              {making ? 'Making…' : 'Make'}
            </button>
          </form>
        </>
      )}
    </div>
  )
}
