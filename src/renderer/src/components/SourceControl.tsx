import { useState } from 'react'
import { GitStashes } from './GitStashes'
import { GitHistory } from './GitHistory'
import type { GitFileChange } from '@shared/types'
import { useStore, workspaceRoot } from '../state/store'
import { refreshGitStatus, statusClass } from '../state/git'
import { checkDisk } from '../state/disk'
import { QuickPick, type QuickPickItem } from './QuickPick'

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

/**
 * The prefixes git uses for the part of an error that is about the error.
 *
 * ` ! [rejected]` has no colon and is the one that matters most on a push, so it
 * is matched on its own rather than folded into the list.
 */
const GIT_EXPLAINS = /^(?:error|fatal|hint|remote|warning):|^\s*!\s/

export function SourceControl(): React.JSX.Element {
  const status = useStore((s) => s.gitStatus)
  const treeRoot = useStore(workspaceRoot)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const openDiff = useStore((s) => s.openDiffInSplit)

  const gitError = useStore((s) => s.gitError)
  const message = useStore((s) => s.commitDraft)
  const setMessage = useStore((s) => s.setCommitDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** Which way the remote conversation is going, while it is going. */
  const [syncing, setSyncing] = useState<'push' | 'pull' | null>(null)
  /**
   * What git is doing that has no deadline, so it can be stopped.
   *
   * Commit, push, pull and checkout are allowed to take as long as they take —
   * hooks and credential prompts legitimately do — which means the only thing
   * that ends them is the user deciding to.
   */
  const [stoppable, setStoppable] = useState<string | null>(null)

  const stop = async (): Promise<void> => {
    if (!root) return
    const res = await window.ember.gitCancel(root)
    setStoppable(null)
    if (res.lock) {
      setError(
        'Stopped. git left .git/index.lock behind — remove it if nothing else is using this repository.'
      )
    }
  }
  /** The branch picker's items, when it is open. */
  const [branchPick, setBranchPick] = useState<QuickPickItem[] | null>(null)

  const root = status?.root ?? null

  /** Run a mutation, then re-read: git is the state, this component is a view of it. */
  const act = async (
    fn: () => Promise<{ ok: boolean; error?: string }>,
    label?: string
  ): Promise<boolean> => {
    setBusy(true)
    setError(null)
    if (label) setStoppable(label)
    const res = await fn()
    if (!res.ok) setError(res.error ?? 'git failed.')
    await refreshGitStatus()
    if (res.ok) await refreshOpenDiffs()
    // Discards and stashes rewrite the working tree under the open editors. Every
    // open file is read rather than stat'ed: git can finish inside the same tick of
    // the clock it read the file in, and this is not the moment to trust a time.
    if (res.ok) await checkDisk(undefined, { thorough: true })
    setStoppable(null)
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
    /*
     * The editors are told by `act`, or the discard would undo itself.
     *
     * git rewrites the working tree, and a tab showing that file kept its old buffer,
     * kept believing it matched disk, and stayed unmarked — so the next Ctrl+S wrote
     * the discarded changes straight back. `act` now looks at every open file after
     * any git action: a clean tab takes the restored text, an edited one is told the
     * file moved on, and a tab on a deleted untracked file keeps its text as the only
     * copy, marked as such.
     */
    await act(() =>
      window.ember.gitDiscard(root, untracked ? [] : [change.path], untracked ? [change.path] : [])
    )
  }

  /**
   * Finish, step over, or give up whatever is half-done.
   *
   * Abort is the one that throws work away, so it asks first — it is the only
   * action here that cannot be undone by doing it again.
   */
  const operation = async (action: 'continue' | 'abort' | 'skip'): Promise<void> => {
    const pending = status?.operation
    if (!root || !pending) return
    const name = OPERATION_NAME[pending].toLowerCase()
    if (action === 'abort' && !window.confirm(`Give up this ${name}? Anything resolved so far is lost.`)) {
      return
    }
    await act(
      () => window.ember.gitOperation(root, pending, action),
      action === 'abort' ? 'Aborting' : action === 'skip' ? 'Skipping' : 'Continuing'
    )
  }

  const commit = async (): Promise<void> => {
    if (!root) return
    setBusy(true)
    setError(null)
    // Hooks run here, and a slow one used to be killed at twenty seconds.
    setStoppable('Committing')
    const res = await window.ember.gitCommit(root, message)
    setStoppable(null)
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

  const sync = async (kind: 'push' | 'pull'): Promise<void> => {
    if (!root || syncing) return
    setSyncing(kind)
    setError(null)
    setNote(null)
    setStoppable(kind === 'push' ? 'Pushing' : 'Pulling')
    const res =
      kind === 'push'
        ? await window.ember.gitPush(root, status.upstream !== null)
        : await window.ember.gitPull(root)
    setStoppable(null)
    if (!res.ok) setError(res.error)
    else setNote(kind === 'push' ? 'Pushed.' : 'Pulled.')
    await refreshGitStatus()
    // A pull that did anything changed files under the open editors — and one that
    // failed half way through may have too, so it is looked at either way.
    if (kind === 'pull') await checkDisk(undefined, { thorough: true })
    setSyncing(null)
  }

  const openBranchPick = async (): Promise<void> => {
    if (!root) return
    const locals = await window.ember.gitBranches(root)
    setBranchPick(
      locals.map((name) => ({
        id: `co:${name}`,
        label: name,
        detail: name === status.branch ? 'current' : '',
        hint: name === status.branch ? '✓' : undefined
      }))
    )
  }

  const pickBranch = async (item: QuickPickItem): Promise<void> => {
    setBranchPick(null)
    if (!root) return
    const create = item.id.startsWith('new:')
    const name = item.id.slice(create ? 4 : 3)
    if (!create && name === status.branch) return
    setError(null)
    setNote(null)
    setStoppable(create ? 'Creating the branch' : 'Switching branch')
    const res = await window.ember.gitCheckout(root, name, create)
    setStoppable(null)
    if (!res.ok) setError(res.error)
    else setNote(create ? `On new branch ${name}.` : `On ${name}.`)
    await refreshGitStatus()
    // Another branch is other versions of the open files, and some of them gone.
    if (res.ok && !create) await checkDisk(undefined, { thorough: true })
  }

  const ahead = status.ahead > 0 ? `↑${status.ahead}` : ''
  const behind = status.behind > 0 ? `↓${status.behind}` : ''

  return (
    <div className="scm">
      {branchPick && (
        <QuickPick
          placeholder="Switch branch, or type a new name…"
          items={branchPick}
          craft={(query) => {
            const name = query.trim()
            if (!name || branchPick.some((b) => b.id === `co:${name}`)) return null
            return { id: `new:${name}`, label: `Create branch "${name}"`, detail: 'from the current one' }
          }}
          onPick={(item) => void pickBranch(item)}
          onClose={() => setBranchPick(null)}
          empty="No branches — type a name to create one"
        />
      )}
      <div className="scm__head">
        <button
          type="button"
          className="scm__branch"
          title={`${status.upstream ?? 'No upstream'} — click to switch branches`}
          aria-label="Switch branch"
          onClick={() => void openBranchPick()}
        >
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
        </button>
        {(ahead || behind) && (
          <span className="scm__track" title={`${status.ahead} ahead, ${status.behind} behind`}>
            {ahead}
            {behind}
          </span>
        )}
        <button
          className="icon-btn"
          title={status.upstream ? 'Push' : 'Publish this branch to origin'}
          aria-label="Push"
          disabled={busy || syncing !== null}
          onClick={() => void sync('push')}
        >
          {syncing === 'push' ? '…' : '↑'}
        </button>
        <button
          className="icon-btn"
          title={status.upstream ? 'Pull' : 'No upstream to pull from'}
          aria-label="Pull"
          disabled={busy || syncing !== null || status.upstream === null}
          onClick={() => void sync('pull')}
        >
          {syncing === 'pull' ? '…' : '↓'}
        </button>
        <button className="icon-btn" title="Refresh" disabled={busy} onClick={() => void refreshGitStatus()}>
          ↻
        </button>
        {/*
          Only while something is running that nothing else will end. A commit
          waiting on a hook, or a push waiting on a browser sign-in, used to be
          killed at twenty seconds; now it waits, so this is the way out.
        */}
        {stoppable && (
          <button
            className="icon-btn scm__stop"
            title={`${stoppable} — stop it`}
            aria-label="Stop"
            onClick={() => void stop()}
          >
            ✕
          </button>
        )}
      </div>

      {/* A half-finished merge shows nothing in the change lists once its conflicts
          are resolved, so without this the panel said "No changes" and disabled the
          one button that would have finished it. */}
      {status.operation && (
        <div className="scm__operation">
          <span>
            {/*
              What finishes it depends on which it is. "Commit to finish it" is
              true of a merge, a cherry-pick and a revert, and wrong for a rebase:
              committing there makes an extra commit rather than continuing the
              one that stopped, which leaves the rebase exactly where it was.
            */}
            {status.conflicts.length > 0
              ? `${OPERATION_NAME[status.operation]} in progress — resolve the conflicts below, then stage them.`
              : status.operation === 'rebase'
                ? 'Rebase in progress — continue it to carry on.'
                : `${OPERATION_NAME[status.operation]} in progress — commit to finish it.`}
          </span>
          {/*
            None of this could be done from the panel before. A rebase that
            stopped on a conflict could only be finished from the terminal.
          */}
          <span className="scm__operation-acts">
            <button
              className="btn"
              disabled={busy || status.conflicts.length > 0}
              title={
                status.conflicts.length > 0
                  ? 'Resolve and stage the conflicts first'
                  : `Carry on with the ${OPERATION_NAME[status.operation].toLowerCase()}`
              }
              onClick={() => void operation('continue')}
            >
              Continue
            </button>
            {status.operation !== 'merge' && (
              <button
                className="btn"
                disabled={busy}
                title="Leave this commit out and carry on"
                onClick={() => void operation('skip')}
              >
                Skip
              </button>
            )}
            <button
              className="btn"
              disabled={busy}
              title={`Give up the ${OPERATION_NAME[status.operation].toLowerCase()} and put the branch back`}
              onClick={() => void operation('abort')}
            >
              Abort
            </button>
          </span>
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

      {/*
        Every line git wrote, with the ones that explain picked out.

        git leads with the remote or the branch and puts the reason underneath, so
        a one-line error box showed a URL and threw away the sentence naming what
        to do next. The lines it prefixes itself — `error:`, `fatal:`, `hint:`,
        `remote:`, and the ` ! [rejected]` form — are the ones worth the weight.
      */}
      {error && (
        <div className="scm__error">
          {error.split('\n').map((line, i) => (
            <div
              key={i}
              className={`scm__error-line${GIT_EXPLAINS.test(line) ? ' scm__error-line--says' : ''}`}
            >
              {line}
            </div>
          ))}
        </div>
      )}
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

        {/* The two halves of git this panel could not reach: what is put aside,
            and what happened before now. */}
        <GitStashes root={root} busy={busy} act={act} />
        <GitHistory root={root} />
      </div>
    </div>
  )
}
