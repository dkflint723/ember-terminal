import { useCallback, useEffect, useState } from 'react'
import type { GitHubCheckState, GitHubIssue, GitHubOverview, GitHubPr } from '@shared/types'
import { useStore, workspaceRoot } from '../state/store'
import { refreshGitStatus } from '../state/git'

/**
 * Pull requests and issues for whatever repository the workspace belongs to.
 *
 * Fetched on demand rather than polled, unlike git status beside it: these are
 * network calls against a rate-limited API, and nobody needs a pull request list
 * refreshed every three seconds. It loads when the view opens and when asked.
 */
export function GitHubPanel(): React.JSX.Element {
  const treeRoot = useStore(workspaceRoot)
  const [overview, setOverview] = useState<GitHubOverview | null>(null)
  const [problem, setProblem] = useState<{ reason: string; error: string } | null>(null)
  /** An action that failed, shown above the list the user is still looking at. */
  const [actionError, setActionError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [tab, setTab] = useState<'prs' | 'issues'>('prs')

  const load = useCallback(async (): Promise<void> => {
    if (!treeRoot) return
    setLoading(true)
    const res = await window.ember.githubOverview(treeRoot)
    setLoading(false)
    if (res.ok) {
      setOverview(res.overview)
      setProblem(null)
    } else {
      setOverview(null)
      setProblem({ reason: res.reason, error: res.error })
    }
  }, [treeRoot])

  useEffect(() => {
    void load()
  }, [load])

  const checkout = async (pr: GitHubPr): Promise<void> => {
    if (!treeRoot) return
    // Checking out moves the working tree under whatever else is open, so it asks.
    if (!window.confirm(`Check out #${pr.number} (${pr.headRefName})?`)) return
    setBusy(pr.number)
    const res = await window.ember.githubCheckout(treeRoot, pr.number)
    setBusy(null)
    /*
     * A failed action is not a failed panel.
     *
     * `problem` replaces the entire view with a full-page error, which is right
     * when the panel could not load at all — no gh, not signed in — and quite wrong
     * for a checkout that hit a dirty working tree. The pull requests were still
     * there and still listed a moment earlier; throwing them away loses the user's
     * place and tells them less, not more.
     */
    if (!res.ok) setActionError(res.error ?? 'Could not check that out.')
    else setActionError(null)
    // The branch just changed, so the source-control view is now stale.
    await refreshGitStatus()
  }

  if (!treeRoot) return <div className="gh gh--empty">Open a folder to see GitHub.</div>

  if (problem) {
    return (
      <div className="gh gh--empty">
        <div className="gh__problem">{problem.error}</div>
        {problem.reason === 'no-cli' && (
          <div className="gh__hint">
            This panel drives the GitHub CLI, so it needs <code>gh</code> on your PATH.
          </div>
        )}
        {problem.reason === 'no-auth' && (
          <div className="gh__hint">
            Run <code>gh auth login</code> in a terminal pane, then reload.
          </div>
        )}
        <button className="block__action" onClick={() => void load()} disabled={loading}>
          {loading ? 'checking…' : 'retry'}
        </button>
      </div>
    )
  }

  if (!overview) return <div className="gh gh--empty">{loading ? 'Loading…' : 'No data.'}</div>

  const items = tab === 'prs' ? overview.prs : overview.issues

  return (
    <div className="gh">
      <div className="gh__head">
        <button
          className="gh__repo"
          title={overview.repo.url}
          onClick={() => window.ember.openExternal(overview.repo.url)}
        >
          {overview.repo.owner}/{overview.repo.name}
        </button>
        <button className="icon-btn" title="Reload" disabled={loading} onClick={() => void load()}>
          ↻
        </button>
      </div>

      {actionError && <div className="scm__error gh__action-error">{actionError}</div>}

      <div className="gh__switch">
        {(['prs', 'issues'] as const).map((which) => (
          <button
            key={which}
            className={`gh__switch-btn ${tab === which ? 'gh__switch-btn--on' : ''}`}
            onClick={() => setTab(which)}
          >
            {which === 'prs' ? 'Pull requests' : 'Issues'}
            <span className="scm__count">
              {which === 'prs' ? overview.prs.length : overview.issues.length}
            </span>
          </button>
        ))}
      </div>

      <div className="gh__body">
        {loading && <div className="gh__hint">Loading…</div>}
        {!loading && items.length === 0 && (
          <div className="gh__hint">Nothing open{tab === 'prs' ? '' : ' here'}.</div>
        )}

        {tab === 'prs' &&
          overview.prs.map((pr) => (
            <div key={pr.number} className="gh__row">
              <button
                className="gh__item"
                title={`${pr.title}\n${pr.headRefName} · updated ${relative(pr.updatedAt)}`}
                onClick={() => window.ember.openExternal(pr.url)}
              >
                <span className="gh__num">#{pr.number}</span>
                <span className="gh__title">{pr.title}</span>
                <span className="gh__meta">
                  {pr.isDraft && <span className="gh__draft">draft</span>}
                  <Checks state={pr.checks} />
                  {pr.reviewDecision === 'APPROVED' && <span className="gh__ok">approved</span>}
                  {pr.reviewDecision === 'CHANGES_REQUESTED' && (
                    <span className="gh__bad">changes</span>
                  )}
                  <span className="gh__author">{pr.author}</span>
                </span>
              </button>
              <button
                className="icon-btn"
                title={`Check out ${pr.headRefName}`}
                disabled={busy !== null}
                onClick={() => void checkout(pr)}
              >
                {busy === pr.number ? '…' : '↓'}
              </button>
            </div>
          ))}

        {tab === 'issues' &&
          overview.issues.map((issue: GitHubIssue) => (
            <div key={issue.number} className="gh__row">
              <button
                className="gh__item"
                title={`${issue.title}\nupdated ${relative(issue.updatedAt)}`}
                onClick={() => window.ember.openExternal(issue.url)}
              >
                <span className="gh__num">#{issue.number}</span>
                <span className="gh__title">{issue.title}</span>
                <span className="gh__meta">
                  {issue.labels.slice(0, 2).map((label) => (
                    <span key={label} className="gh__label">
                      {label}
                    </span>
                  ))}
                  <span className="gh__author">{issue.author}</span>
                </span>
              </button>
            </div>
          ))}
      </div>
    </div>
  )
}

/** Checks as a word plus a colour, so the state survives a colourblind theme. */
function Checks({ state }: { state: GitHubCheckState }): React.JSX.Element | null {
  if (state === 'none') return null
  const label = { passing: 'checks ok', failing: 'checks failed', pending: 'checks running' }[state]
  return <span className={`gh__checks gh__checks--${state}`}>{label}</span>
}

/** Coarse on purpose: the exact minute of a pull request's last update is noise. */
function relative(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  const scales: [number, string][] = [
    [86400 * 365, 'y'],
    [86400 * 30, 'mo'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm']
  ]
  for (const [size, suffix] of scales) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${suffix} ago`
  }
  return 'just now'
}
