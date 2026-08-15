import { useState } from 'react'
import type { GitFileChange } from '@shared/types'
import { useStore } from '../state/store'
import { refreshGitStatus, statusClass } from '../state/git'

/**
 * The source-control panel: what has changed, what is staged, and a commit box.
 *
 * Nothing here caches state of its own. Every action runs git and then re-reads the
 * status, because the terminal in the next pane shares this working tree — a panel
 * that trusted its own model of the index would be wrong the moment someone typed
 * `git add` themselves.
 */
/** What to call a half-finished operation, in the words git itself uses. */
const OPERATION_NAME = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert'
} as const

export function SourceControl(): React.JSX.Element {
  const status = useStore((s) => s.gitStatus)
  const treeRoot = useStore((s) => s.treeRoot)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const openDiff = useStore((s) => s.openDiffInSplit)
  const reloadFromDisk = useStore((s) => s.reloadFromDisk)
  const notePathDeleted = useStore((s) => s.notePathDeleted)

  const gitError = useStore((s) => s.gitError)
  const message = useStore((s) => s.commitDraft)
  const setMessage = useStore((s) => s.setCommitDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const root = status?.root ?? null

  /** Run a mutation, then re-read: git is the state, this component is a view of it. */
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    const res = await fn()
    if (!res.ok) setError(res.error ?? 'git failed.')
    await refreshGitStatus()
    if (res.ok) await refreshOpenDiffs()
    setBusy(false)
    return res.ok
  }

  /**
   * Bring open diff panes back in line with the index.
   *
   * The status was re-read after every action but the diffs already on screen were
   * not, so a pane went on showing an unstaged change after it had been staged —
   * two panes side by side, one saying the file had changed and the other saying it
   * had not. The pane is refreshed where the change still exists, and closed where
   * git no longer reports one, because a diff of nothing is not worth a pane.
   */
  const refreshOpenDiffs = async (): Promise<void> => {
    const state = useStore.getState()
    if (!root) return

    for (const pane of Object.values(state.panes)) {
      if (pane.kind !== 'diff' || pane.proposal) continue
      const fresh = await window.ember.gitDiff(root, pane.filePath, pane.staged)
      const owner = state.tabIdForPane(pane.id)
      if (!fresh.ok || fresh.original === fresh.modified) {
        if (owner) state.closePane(owner, pane.id)
        continue
      }
      state.patchDiffPane(pane.id, {
        original: fresh.original,
        modified: fresh.modified,
        originalLabel: fresh.originalLabel,
        modifiedLabel: fresh.modifiedLabel
      })
    }
  }

  const show = async (change: GitFileChange, staged: boolean): Promise<void> => {
    if (!root) return
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return

    const res = await window.ember.gitDiff(root, change.path, staged)
    if (!res.ok) {
      setError(res.error)
      return
    }
    const { languageForPath } = await import('../editor/monaco')
    openDiff(tab.id, {
      filePath: res.path,
      title: res.path.split('/').pop() ?? res.path,
      original: res.original,
      modified: res.modified,
      originalLabel: res.originalLabel,
      modifiedLabel: res.modifiedLabel,
      language: languageForPath(res.path),
      staged
    })
  }

  const discard = async (change: GitFileChange): Promise<void> => {
    if (!root) return
    const untracked = change.status === 'U'
    /*
     * The full path, not the repository-relative one.
     *
     * git reports paths relative to the repository root, which is not necessarily
     * the folder that is open — so with the workspace rooted in a subdirectory the
     * panel can offer to discard a file somewhere else entirely, named only by a
     * path that does not resolve from where the user thinks they are.
     */
    const full = `${root}/${change.path}`
    const ok = window.confirm(
      untracked
        ? `Delete ${full}? It is untracked, so this cannot be undone.`
        : `Discard changes to ${full}? This cannot be undone.`
    )
    if (!ok) return
    const done = await act(() =>
      window.ember.gitDiscard(root, untracked ? [] : [change.path], untracked ? [change.path] : [])
    )
    if (!done) return

    /*
     * Tell the editors, or the discard undoes itself.
     *
     * git rewrites the working tree, and a tab showing that file kept its old buffer,
     * kept believing it matched disk, and stayed unmarked — so the next Ctrl+S wrote
     * the discarded changes straight back. This was the one thing in the app that
     * changed a file without anything telling the editor. Reloading leaves a buffer
     * with unsaved edits of the user's own alone, as it does everywhere else.
     */
    if (untracked) notePathDeleted(full)
    else await reloadFromDisk([full])
  }

  const commit = async (): Promise<void> => {
    if (!root) return
    setBusy(true)
    setError(null)
    const res = await window.ember.gitCommit(root, message)
    if (res.ok) {
      setMessage('')
      setNote(res.summary)
      window.setTimeout(() => setNote(null), 4000)
    } else {
      setError(res.error)
    }
    await refreshGitStatus()
    setBusy(false)
  }

  if (!treeRoot) {
    return <div className="scm scm--empty">Open a folder to see source control.</div>
  }
  if (!status) {
    // The reason, when there is one worth giving. Every git failure used to be
    // rendered as "not a git repository", including git not being installed.
    return (
      <div className="scm scm--empty">
        {gitError ?? `${treeRoot} is not a git repository.`}
      </div>
    )
  }

  /*
   * What stops a commit, and why, in one place.
   *
   * Ctrl+Enter in the message box used to commit regardless of any of this, so it
   * could make a merge commit the button beside it was refusing to make.
   */
  const commitBlockedWhy = !message.trim()
    ? 'Write a message first'
    : status.conflicts.length > 0
      ? 'Resolve and stage the conflicts first'
      : status.staged.length === 0 && !status.operation
        ? 'Stage something first'
        : null
  const commitBlocked = commitBlockedWhy !== null

  const section = (
    label: string,
    items: GitFileChange[],
    staged: boolean,
    actions: (c: GitFileChange) => React.JSX.Element
  ): React.JSX.Element | null => {
    if (items.length === 0) return null
    return (
      <div className="scm__section">
        <div className="scm__section-head">
          <span>{label}</span>
          <span className="scm__count">{items.length}</span>
        </div>
        {items.map((change) => (
          <div key={`${label}:${change.path}`} className="scm__row">
            <button
              className={`scm__file ${statusClass(change.status)}`}
              title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
              onClick={() => void show(change, staged)}
            >
              <span className="scm__name">{change.path.split('/').pop()}</span>
              <span className="scm__dir">{change.path.split('/').slice(0, -1).join('/')}</span>
            </button>
            <span className="scm__actions">{actions(change)}</span>
            <span className={`scm__status ${statusClass(change.status)}`}>{change.status}</span>
          </div>
        ))}
      </div>
    )
  }

  const ahead = status.ahead > 0 ? `↑${status.ahead}` : ''
  const behind = status.behind > 0 ? `↓${status.behind}` : ''

  return (
    <div className="scm">
      <div className="scm__head">
        <span className="scm__branch" title={status.upstream ?? 'No upstream'}>
          {/* Drawn rather than typed: the obvious branch characters are missing from
              the monospace fonts this app ships with and render as a blank box. */}
          <svg viewBox="0 0 16 16" className="scm__branch-icon" aria-hidden="true">
            <circle cx="4.5" cy="3.5" r="1.8" />
            <circle cx="4.5" cy="12.5" r="1.8" />
            <circle cx="11.5" cy="3.5" r="1.8" />
            <path d="M4.5 5.3v5.4M11.5 5.3v1.2a3 3 0 0 1-3 3H4.5" />
          </svg>
          {/* In a box of its own so a long branch name has something to be
              truncated in: a bare text node beside the glyph is an anonymous flex
              item, and an ellipsis has nowhere to be drawn on one. */}
          <span className="scm__branch-name">
            {status.detached ? 'detached' : status.branch}
          </span>
        </span>
        {(ahead || behind) && (
          <span className="scm__track" title={`${status.ahead} ahead, ${status.behind} behind`}>
            {ahead}
            {behind}
          </span>
        )}
        <button className="icon-btn" title="Refresh" disabled={busy} onClick={() => void refreshGitStatus()}>
          ↻
        </button>
      </div>

      {/* A half-finished merge shows nothing in the change lists once its conflicts
          are resolved, so without this the panel said "No changes" and disabled the
          one button that would have finished it. */}
      {status.operation && (
        <div className="scm__operation">
          {status.conflicts.length > 0
            ? `${OPERATION_NAME[status.operation]} in progress — resolve the conflicts below, then stage them.`
            : `${OPERATION_NAME[status.operation]} in progress — commit to finish it.`}
        </div>
      )}

      <div className="scm__commit">
        <textarea
          className="scm__message"
          placeholder="Message (Ctrl+Enter to commit)"
          rows={2}
          value={message}
          disabled={busy}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              e.preventDefault()
              // The same conditions the button enforces. Bypassing them here could
              // make a commit the button was refusing to make.
              if (!commitBlocked) void commit()
            }
          }}
        />
        <button
          className="scm__commit-btn"
          disabled={busy || commitBlocked}
          title={commitBlockedWhy ?? 'Commit staged changes'}
          onClick={() => void commit()}
        >
          ✓ Commit
        </button>
      </div>

      {error && <div className="scm__error">{error}</div>}
      {note && <div className="scm__note">{note}</div>}

      <div className="scm__body">
        {/* Staging a conflicted path is exactly how git is told it is resolved, so
            the same + that stages anything else finishes a conflict. Without it a
            merge could be started here and never completed. */}
        {section('Merge conflicts', status.conflicts, false, (change) => (
          <button
            className="icon-btn"
            title="Mark resolved and stage"
            disabled={busy}
            onClick={() => void act(() => window.ember.gitStage(root!, [change.path]))}
          >
            ＋
          </button>
        ))}

        {section('Staged changes', status.staged, true, (change) => (
          <button
            className="icon-btn"
            title="Unstage"
            disabled={busy}
            /* Both halves of a rename. Git stages one as a deletion of the old path
               and an addition of the new one, so unstaging only the new name left
               the deletion staged — and the next commit deleted the file. */
            onClick={() =>
              void act(() =>
                window.ember.gitUnstage(
                  root!,
                  change.origPath ? [change.path, change.origPath] : [change.path]
                )
              )
            }
          >
            −
          </button>
        ))}

        {section('Changes', status.changes, false, (change) => (
          <>
            <button
              className="icon-btn"
              title="Discard changes"
              disabled={busy}
              onClick={() => void discard(change)}
            >
              ↺
            </button>
            <button
              className="icon-btn"
              title="Stage"
              disabled={busy}
              onClick={() => void act(() => window.ember.gitStage(root!, [change.path]))}
            >
              +
            </button>
          </>
        ))}

        {status.staged.length === 0 &&
          status.changes.length === 0 &&
          status.conflicts.length === 0 && <div className="scm__clean">No changes</div>}
      </div>
    </div>
  )
}
