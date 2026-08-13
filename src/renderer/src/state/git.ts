import { useEffect } from 'react'
import type { GitFileChange } from '@shared/types'
import { useStore } from './store'

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
export async function refreshGitStatus(): Promise<void> {
  const { treeRoot, setGitStatus } = useStore.getState()
  if (!treeRoot) {
    setGitStatus(null)
    return
  }
  const res = await window.ember.gitStatus(treeRoot)
  // A directory that is not a repository is not an error worth raising; the panel
  // says so in its own words.
  setGitStatus(res.ok ? res.status : null)
}

/**
 * Drive the polling. Mounted once, at the app root, because the explorer's
 * decorations need the status whether or not the source-control view is open — and
 * because two components each running their own interval would double the work and
 * still not agree on when they had done it.
 */
export function useGitStatusPolling(): void {
  const treeRoot = useStore((s) => s.treeRoot)

  useEffect(() => {
    void refreshGitStatus()

    const tick = (): void => {
      if (document.visibilityState === 'visible') void refreshGitStatus()
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
