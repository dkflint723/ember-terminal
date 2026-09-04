import { useEffect } from 'react'
import type { GitFileChange } from '@shared/types'
import { isInside } from '@shared/paths'
import { useStore, workspaceRoot } from './store'

/**
 * Keeps the shared git status current.
 *
 * The working tree is not owned by this app — the terminal in the next pane is
 * changing it constantly — so the status has to be re-read rather than deduced from
 * what the panel itself did. Polling is the honest mechanism: a filesystem watcher
 * over a repository means watching `.git` and every tracked directory, and would
 * still miss an index change that touches no file the watcher was told about.
 *
 * Every mutation refreshes immediately, so the poll only covers changes made
 * elsewhere, and it stops entirely while the window is hidden.
 */
const POLL_MS = 3000

/**
 * Read the repository once and publish it. Reads the root from the store rather
 * than taking it as an argument, so a caller reacting to a button press does not
 * have to hold a subscription just to refresh.
 */
/** True while a status call is in flight, so a slow repo does not stack them up. */
let polling = false

export async function refreshGitStatus(): Promise<void> {
  const { setGitStatus, setGitError } = useStore.getState()
  const treeRoot = workspaceRoot(useStore.getState())
  if (!treeRoot) {
    setGitStatus(null)
    setGitError(null)
    return
  }
  // A repository slow enough to outlast the poll interval had two or three
  // `git status` processes running against it at once, forever.
  if (polling) return
  polling = true
  try {
    const res = await window.ember.gitStatus(treeRoot)
    setGitStatus(res.ok ? res.status : null)
    /*
     * The reason is kept rather than dropped.
     *
     * Every failure — git missing from PATH, a folder git will not trust, a
     * timeout — arrived here and was rendered as "not a git repository", which is
     * the one explanation guaranteed to send someone looking in the wrong place.
     * "Not a git repository" is still not worth shouting about, so it stays the
     * panel's own quiet wording; anything else is shown.
     */
    setGitError(res.ok || /not a git repository/i.test(res.error) ? null : res.error)
  } finally {
    polling = false
  }
}

/**
 * The repository a shell is standing in, which is not always the workspace.
 *
 * The composer's branch and change count came from the workspace status alone, so
 * they appeared only when a folder had been opened and the pane happened to sit
 * inside it. That is exactly backwards for a terminal: someone who cds into a
 * repository wants to see the branch they are about to commit to, and in a plain
 * terminal there is no workspace root at all, so the chips simply never appeared.
 *
 * Read per directory and cached by it, because several panes in one project are the
 * normal case and they can share the answer.
 */
let pollingCwd = false

export async function refreshGitForCwd(cwd: string): Promise<void> {
  const { setCwdGit } = useStore.getState()
  const treeRoot = workspaceRoot(useStore.getState())
  if (!cwd) return
  // Inside the workspace the polled status already describes this directory, and
  // asking git the same question twice per tick is the kind of waste that shows up
  // as a fan spinning on a large repository.
  if (treeRoot && isInside(treeRoot, cwd)) return
  if (pollingCwd) return

  pollingCwd = true
  try {
    const res = await window.ember.gitStatus(cwd)
    // The pane may have been cd'd elsewhere while git was answering; the reply
    // describes the directory it was asked about, so it is filed under that one.
    setCwdGit(cwd, res.ok ? res.status : null)
  } finally {
    pollingCwd = false
  }
}

/**
 * Drive the polling. Mounted once, at the app root, because the explorer's
 * decorations need the status whether or not the source-control view is open — and
 * because two components each running their own interval would double the work and
 * still not agree on when they had done it.
 */
export function useGitStatusPolling(): void {
  const treeRoot = useStore(workspaceRoot)

  useEffect(() => {
    void refreshGitStatus()

    const tick = (): void => {
      if (document.visibilityState !== 'visible') return
      void refreshGitStatus()
      // Only the pane in front of the user: a window of eight shells should not
      // mean eight git processes every three seconds.
      const s = useStore.getState()
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      const pane = tab ? s.panes[tab.activePaneId] : undefined
      if (pane?.kind === 'terminal') void refreshGitForCwd(pane.cwd)
    }
    const timer = window.setInterval(tick, POLL_MS)

    // A hidden window comes back arbitrarily stale, so it reads on return rather
    // than waiting out the remainder of the interval.
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [treeRoot])
}

/**
 * One spelling for a path, so a map built from git's output can be looked up with a
 * path the file tree built.
 *
 * They disagree twice over: git always reports forward slashes even on Windows,
 * where `path.join` produces backslashes, and Windows itself does not distinguish
 * case. Neither difference means the paths are different files, so both are removed
 * before comparing — the lowercasing only where the filesystem agrees it is safe.
 */
function canonical(p: string): string {
  const forward = p.replace(/\\/g, '/')
  return window.ember.platform === 'win32' ? forward.toLowerCase() : forward
}

/**
 * Status letters keyed by absolute path, for decorating a tree whose rows are
 * absolute. Where a path is both staged and modified again the working-tree letter
 * wins, because that is the change the user has not yet accounted for.
 */
export function decorationsByPath(
  root: string | null,
  staged: GitFileChange[],
  changes: GitFileChange[],
  conflicts: GitFileChange[]
): Map<string, string> {
  const out = new Map<string, string>()
  if (!root) return out

  for (const change of [...staged, ...changes, ...conflicts]) {
    out.set(canonical(`${root}/${change.path}`), change.status)
  }
  return out
}

/** Look a tree row's absolute path up in that map. */
export function decorationFor(
  decorations: Map<string, string>,
  absolutePath: string
): string | undefined {
  return decorations.get(canonical(absolutePath))
}

/** The colour class a status letter earns, matching the source-control list. */
export function statusClass(status: string): string {
  if (status === 'U') return 'git--untracked'
  if (status === 'A') return 'git--added'
  if (status === 'D') return 'git--deleted'
  if (status === 'C') return 'git--conflict'
  return 'git--modified'
}
