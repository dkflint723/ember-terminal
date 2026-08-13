import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  GitHubCheckState,
  GitHubIssue,
  GitHubFailure,
  GitHubOverview,
  GitHubPr,
  GitHubResult,
  GitSimpleResult
} from '../shared/types.js'

const run = promisify(execFile)

/** Network calls behind these, so longer than a local git command deserves. */
const TIMEOUT_MS = 25_000
const MAX_BUFFER = 8 * 1024 * 1024
/** Enough to be useful in a sidebar; more is what the website is for. */
const LIMIT = 25

/**
 * GitHub through the user's own `gh`.
 *
 * Shelling out rather than talking to the API directly is the whole design: `gh`
 * already holds the credentials, refreshes them, knows about SSO and enterprise
 * hosts, and resolves which repository a directory belongs to. Reimplementing that
 * would mean owning a token, and owning a token badly.
 *
 * The cost is a hard dependency on `gh` being installed, so its absence is a
 * first-class answer rather than an error string — the panel can then say what to
 * do about it.
 */
export class GitHubService {
  private async gh(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await run('gh', args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
      // gh colours and paginates for humans; this output is parsed.
      env: { ...process.env, GH_PAGER: 'cat', NO_COLOR: '1', CLICOLOR: '0' }
    })
    return stdout
  }

  /**
   * Sort a failure into something the panel can act on. The three that matter are
   * distinguishable and each has a different remedy, so they are not collapsed into
   * one "something went wrong".
   */
  private static classify(err: unknown): { reason: GitHubFailure; error: string } {
    const e = err as { stderr?: string; message?: string; code?: string }
    const stderr = (typeof e?.stderr === 'string' ? e.stderr : '').trim()
    const text = `${stderr} ${e?.message ?? ''}`.toLowerCase()

    if (e?.code === 'ENOENT' || text.includes('is not recognized')) {
      return { reason: 'no-cli', error: 'The GitHub CLI (gh) is not installed.' }
    }
    if (text.includes('gh auth login') || text.includes('authentication')) {
      return { reason: 'no-auth', error: 'Not signed in. Run: gh auth login' }
    }
    if (text.includes('not a git repository')) {
      return { reason: 'no-repo', error: 'Not a git repository.' }
    }
    if (text.includes('no git remotes') || text.includes('none of the git remotes')) {
      return { reason: 'no-repo', error: 'No GitHub remote on this repository.' }
    }
    return { reason: 'error', error: stderr.split('\n')[0] || e?.message || 'gh failed.' }
  }

  /**
   * Everything the panel shows, in one call. Three requests rather than one, but
   * they are independent, so they go together and the slowest sets the pace.
   */
  async overview(cwd: string): Promise<GitHubResult> {
    try {
      const repoJson = await this.gh(cwd, [
        'repo',
        'view',
        '--json',
        'owner,name,url,defaultBranchRef'
      ])
      const repo = JSON.parse(repoJson) as {
        owner: { login: string }
        name: string
        url: string
        defaultBranchRef: { name: string } | null
      }

      const [prsJson, issuesJson] = await Promise.all([
        this.gh(cwd, [
          'pr',
          'list',
          '--limit',
          String(LIMIT),
          '--json',
          'number,title,author,isDraft,state,headRefName,updatedAt,url,reviewDecision,statusCheckRollup'
        ]),
        this.gh(cwd, [
          'issue',
          'list',
          '--limit',
          String(LIMIT),
          '--json',
          'number,title,author,updatedAt,url,labels'
        ])
      ])

      const overview: GitHubOverview = {
        repo: {
          owner: repo.owner.login,
          name: repo.name,
          url: repo.url,
          defaultBranch: repo.defaultBranchRef?.name ?? 'main'
        },
        prs: (JSON.parse(prsJson) as RawPr[]).map(toPr),
        issues: (JSON.parse(issuesJson) as RawIssue[]).map(toIssue)
      }
      return { ok: true, overview }
    } catch (err) {
      const { reason, error } = GitHubService.classify(err)
      return { ok: false, reason, error }
    }
  }

  /**
   * Check out a pull request's branch. This moves the working tree, so the caller
   * is expected to have confirmed, and the source-control panel beside it will
   * show the result on its next read.
   */
  async checkout(cwd: string, number: number): Promise<GitSimpleResult> {
    try {
      await this.gh(cwd, ['pr', 'checkout', String(number)])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: GitHubService.classify(err).error }
    }
  }
}

interface RawPr {
  number: number
  title: string
  author: { login: string } | null
  isDraft: boolean
  state: string
  headRefName: string
  updatedAt: string
  url: string
  reviewDecision: string | null
  statusCheckRollup: { state?: string; conclusion?: string; status?: string }[] | null
}

interface RawIssue {
  number: number
  title: string
  author: { login: string } | null
  updatedAt: string
  url: string
  labels: { name: string }[] | null
}

/**
 * Reduce a pull request's individual checks to one word.
 *
 * Anything still running wins over a pass, because "passing" next to a run that has
 * not finished would be a claim the data does not support. A single failure wins
 * outright, which is what a person scanning a list needs to see.
 */
function rollup(checks: RawPr['statusCheckRollup']): GitHubCheckState {
  if (!checks || checks.length === 0) return 'none'
  let pending = false
  for (const check of checks) {
    const verdict = (check.conclusion || check.state || '').toUpperCase()
    const status = (check.status || '').toUpperCase()
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(verdict)) {
      return 'failing'
    }
    if (!verdict || ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING'].includes(verdict)) pending = true
    if (['QUEUED', 'IN_PROGRESS', 'PENDING'].includes(status)) pending = true
  }
  return pending ? 'pending' : 'passing'
}

function toPr(raw: RawPr): GitHubPr {
  return {
    number: raw.number,
    title: raw.title,
    author: raw.author?.login ?? 'unknown',
    isDraft: raw.isDraft,
    state: raw.state,
    headRefName: raw.headRefName,
    updatedAt: raw.updatedAt,
    url: raw.url,
    reviewDecision: raw.reviewDecision,
    checks: rollup(raw.statusCheckRollup)
  }
}

function toIssue(raw: RawIssue): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    author: raw.author?.login ?? 'unknown',
    updatedAt: raw.updatedAt,
    url: raw.url,
    labels: (raw.labels ?? []).map((l) => l.name)
  }
}
