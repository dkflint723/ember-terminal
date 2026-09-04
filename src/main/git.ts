import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  GitBlameLine,
  GitCommitResult,
  GitDiffResult,
  GitFileChange,
  GitLogEntry,
  GitSimpleResult,
  GitStashEntry,
  GitStatus,
  GitStatusResult
} from '../shared/types.js'

const run = promisify(execFile)

/** Long enough for a cold index on a large repo, short enough not to hang the panel. */
const TIMEOUT_MS = 20_000
/** `git show` of a whole file has to fit; anything larger is not worth diffing. */
const MAX_BUFFER = 32 * 1024 * 1024

/**
 * Git as the source-control panel needs it.
 *
 * Every call shells out to the user's own `git` rather than reimplementing the
 * format, because the working tree is shared with the terminal sitting next to it:
 * whatever the user types there and whatever this panel does have to agree, and the
 * only way to guarantee that is to be the same program reading the same index.
 *
 * Output is parsed from porcelain v2, which is the only status format git promises
 * not to change. Paths come back NUL-separated so a filename can contain anything.
 */
export class GitService {
  private async git(
    cwd: string,
    args: string[],
    options: { encoding?: 'utf8' | 'buffer'; env?: NodeJS.ProcessEnv } = {}
  ): Promise<{ stdout: string | Buffer }> {
    return run('git', args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      encoding: (options.encoding ?? 'utf8') as 'utf8',
      env: {
        ...process.env,
        ...options.env,
        // A prompt would have nowhere to appear and would hang until the timeout.
        GIT_TERMINAL_PROMPT: '0',
        // Pagers and colour codes are for humans; this output is parsed.
        GIT_PAGER: 'cat',
        GIT_CONFIG_PARAMETERS: "'color.ui=false'"
      }
    })
  }

  private static message(err: unknown): string {
    const e = err as { stderr?: string; message?: string; code?: string }
    const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : ''
    if (stderr) return stderr.split('\n')[0]
    if (e?.code === 'ENOENT') return 'git is not installed, or not on PATH.'
    return e?.message ?? 'git failed.'
  }

  /**
   * The repository containing `cwd`.
   *
   * Failures are told apart rather than all collapsing to null. Catching
   * everything meant git missing from PATH, a directory git refuses to trust, and
   * a folder that genuinely is not a repository all came out as the same sentence
   * — "not a git repository" — which sends someone looking in exactly the wrong
   * place.
   */
  private async findRoot(cwd: string): Promise<{ root: string } | { error: string }> {
    try {
      const { stdout } = await this.git(cwd, ['rev-parse', '--show-toplevel'])
      const root = (stdout as string).trim()
      return root ? { root } : { error: 'Not a git repository.' }
    } catch (err) {
      const e = err as { code?: string; stderr?: string }
      const stderr = typeof e.stderr === 'string' ? e.stderr : ''
      if (e.code === 'ENOENT') return { error: 'git is not installed, or not on PATH.' }
      if (/not a git repository/i.test(stderr)) return { error: 'Not a git repository.' }
      if (/dubious ownership/i.test(stderr)) {
        return {
          error:
            'git refuses to use this folder: it is owned by another user. Add it with git config --global --add safe.directory.'
        }
      }
      return { error: GitService.message(err) }
    }
  }

  async root(cwd: string): Promise<string | null> {
    const found = await this.findRoot(cwd)
    return 'root' in found ? found.root : null
  }

  /**
   * Whether a merge, rebase or cherry-pick is half-finished.
   *
   * A merge with every conflict resolved reports no changes at all, so the panel
   * said "No changes" and disabled Commit — which is the one action that would have
   * finished the merge. The state lives in files beside the index, so it is read
   * from there rather than inferred from the status output that does not mention
   * it.
   */
  private async pendingOperation(root: string): Promise<GitStatus['operation']> {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const gitDir = join(root, '.git')
    if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge'
    if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
    if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert'
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
      return 'rebase'
    }
    return null
  }

  /**
   * Branch, tracking position and every changed path, in one call.
   *
   * `--porcelain=v2 --branch -z` is the machine-readable form: stable across git
   * versions, and NUL-terminated so no filename needs quoting or unescaping.
   */
  async status(cwd: string): Promise<GitStatusResult> {
    const found = await this.findRoot(cwd)
    if (!('root' in found)) return { ok: false, error: found.error }
    const root = found.root

    try {
      const { stdout } = await this.git(root, [
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=all',
        '-z'
      ])
      const operation = await this.pendingOperation(root)
      const { insertions, deletions } = await this.lineStats(root)
      return {
        ok: true,
        status: { root, ...parseStatus(stdout as string), operation, insertions, deletions }
      }
    } catch (err) {
      return { ok: false, error: GitService.message(err) }
    }
  }

  /**
   * Lines added and removed, worktree and index summed.
   *
   * Two `--shortstat` calls rather than one `HEAD` diff, because HEAD does not
   * exist in a repository with no commits yet — and that is exactly the repository
   * a brand-new project is. Any failure reads as zeros: the numbers are a
   * statistic, and a statistic is never worth failing the status over.
   */
  private async lineStats(root: string): Promise<{ insertions: number; deletions: number }> {
    const read = async (args: string[]): Promise<{ ins: number; del: number }> => {
      try {
        const { stdout } = await this.git(root, args)
        const text = String(stdout)
        const ins = /(\d+) insertion/.exec(text)
        const del = /(\d+) deletion/.exec(text)
        return { ins: ins ? Number(ins[1]) : 0, del: del ? Number(del[1]) : 0 }
      } catch {
        return { ins: 0, del: 0 }
      }
    }
    const [work, index] = await Promise.all([
      read(['diff', '--shortstat']),
      read(['diff', '--cached', '--shortstat'])
    ])
    return { insertions: work.ins + index.ins, deletions: work.del + index.del }
  }

  /**
   * The two sides of a file's diff, as text for the editor to compare.
   *
   * Which two depends on what is being looked at: a staged change is HEAD against
   * the index, an unstaged one is the index against what is on disk, and an
   * untracked file has nothing on the left at all.
   */
  /**
   * The file as HEAD has it, resolved from the file's own location — the
   * gutters ask about whatever buffer is open, which need not live under the
   * workspace root. Null when there is nothing to compare against: outside any
   * repository, untracked, or binary.
   */
  async headText(filePath: string): Promise<string | null> {
    try {
      const { dirname, relative } = await import('node:path')
      const dir = dirname(filePath)
      const { stdout } = await this.git(dir, ['rev-parse', '--show-toplevel'])
      const root = (stdout as string).trim()
      if (!root) return null
      const rel = relative(root, filePath).replace(/\\/g, '/')
      if (rel.startsWith('..')) return null
      if (!(await this.tracked(root, rel))) return null
      return await this.showOrEmpty(root, `HEAD:${rel}`)
    } catch {
      return null
    }
  }

  async diff(root: string, path: string, staged: boolean): Promise<GitDiffResult> {
    try {
      /*
       * A conflicted path has no stage 0, so the ordinary `:path` lookup fails and
       * used to come back as an empty left-hand side — presenting the entire
       * conflict as if the file had just been added. Its two sides are the two
       * versions being merged, which is what someone resolving it wants to see.
       */
      if (await this.conflicted(root, path)) {
        const [ours, theirs] = await Promise.all([
          this.showOrEmpty(root, `:2:${path}`),
          this.showOrEmpty(root, `:3:${path}`)
        ])
        if (ours === null || theirs === null) return { ok: false, error: 'That file is binary.' }
        return {
          ok: true,
          path,
          original: ours,
          modified: theirs,
          originalLabel: 'Ours',
          modifiedLabel: 'Theirs'
        }
      }

      const untracked = !staged && !(await this.tracked(root, path))
      const [original, modified] = await Promise.all([
        staged
          ? this.showOrEmpty(root, `HEAD:${path}`)
          : untracked
            ? Promise.resolve('')
            : this.showOrEmpty(root, `:${path}`),
        staged ? this.showOrEmpty(root, `:${path}`) : this.readWorking(root, path)
      ])

      if (original === null || modified === null) {
        return { ok: false, error: 'That file is binary.' }
      }

      return {
        ok: true,
        path,
        original,
        modified,
        originalLabel: staged ? 'HEAD' : untracked ? 'Untracked' : 'Index',
        modifiedLabel: staged ? 'Index' : 'Working tree'
      }
    } catch (err) {
      return { ok: false, error: GitService.message(err) }
    }
  }

  /** Whether a path is mid-conflict, which is to say it has stages rather than one blob. */
  private async conflicted(root: string, path: string): Promise<boolean> {
    try {
      const { stdout } = await this.git(root, ['ls-files', '--unmerged', '--', path])
      return (stdout as string).trim().length > 0
    } catch {
      return false
    }
  }

  private async tracked(root: string, path: string): Promise<boolean> {
    try {
      const { stdout } = await this.git(root, ['ls-files', '--error-unmatch', '--', path])
      return (stdout as string).trim().length > 0
    } catch {
      return false
    }
  }

  /**
   * A blob's text, empty when the path does not exist at that revision — which is
   * the correct left-hand side for an added file — and null when it is binary.
   */
  private async showOrEmpty(root: string, spec: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(root, ['show', spec], { encoding: 'buffer' })
      return decodeText(stdout as Buffer)
    } catch {
      return ''
    }
  }

  private async readWorking(root: string, path: string): Promise<string | null> {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      return decodeText(await readFile(join(root, path)))
    } catch (err) {
      // Only "it is not there" means deleted. Any other failure — a lock, a
      // permission, a file the user cannot read — was being rendered as an empty
      // right-hand side, which is a diff saying the whole file was deleted. Staging
      // from that view would stage a deletion nobody asked for, so it is an error.
      if ((err as { code?: string }).code === 'ENOENT') return ''
      throw err
    }
  }

  async stage(root: string, paths: string[]): Promise<GitSimpleResult> {
    // `add` both stages a modification and records a deletion, which `--all` is
    // what makes true for a path that is no longer there.
    return this.simple(root, ['add', '--all', '--', ...paths])
  }

  async unstage(root: string, paths: string[]): Promise<GitSimpleResult> {
    return this.simple(root, ['restore', '--staged', '--', ...paths])
  }

  /**
   * Throw away working-tree changes. Destructive and not recoverable through git,
   * so the caller is expected to have confirmed with the user first.
   */
  async discard(root: string, paths: string[], untracked: string[]): Promise<GitSimpleResult> {
    if (paths.length) {
      const res = await this.simple(root, ['restore', '--worktree', '--', ...paths])
      if (!res.ok) return res
    }
    // An untracked file has no committed state to restore; it has to be removed.
    if (untracked.length) return this.simple(root, ['clean', '-f', '--', ...untracked])
    return { ok: true }
  }

  async commit(root: string, message: string): Promise<GitCommitResult> {
    if (!message.trim()) return { ok: false, error: 'A commit needs a message.' }
    try {
      // `--` with no pathspec commits exactly what is staged, never the working tree.
      const { stdout } = await this.git(root, ['commit', '-m', message])
      return { ok: true, summary: (stdout as string).trim().split('\n')[0] ?? '' }
    } catch (err) {
      return { ok: false, error: GitService.message(err) }
    }
  }

  /**
   * Push what the branch is ahead by. A branch with no upstream yet is
   * published as itself on origin — the same first push git itself proposes —
   * which is what makes the button meaningful on a brand-new branch.
   */
  async push(root: string, hasUpstream: boolean): Promise<GitSimpleResult> {
    return this.simple(root, hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'])
  }

  /**
   * A plain pull, merges and all: conflicts land in the working tree, and the
   * working tree is something this panel already knows how to show. Refusing
   * anything but fast-forwards would just outsource the mess to a terminal.
   */
  async pull(root: string): Promise<GitSimpleResult> {
    return this.simple(root, ['pull'])
  }

  /** The local branches, as git names them. */
  async branches(root: string): Promise<string[]> {
    try {
      const { stdout } = await this.git(root, ['branch', '--format=%(refname:short)'])
      return (stdout as string)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  async checkout(root: string, name: string): Promise<GitSimpleResult> {
    return this.simple(root, ['checkout', name])
  }

  async createBranch(root: string, name: string): Promise<GitSimpleResult> {
    return this.simple(root, ['checkout', '-b', name])
  }

  /**
   * Who last touched one line, and why.
   *
   * One line rather than the whole file, on purpose. Annotating every line means
   * blaming the entire history on every keystroke, and the question people
   * actually ask is about the line the caret is on — so that is what is asked of
   * git, which makes it cheap enough to run as the caret moves.
   *
   * `--line-porcelain` is the only format carrying the author, the time and the
   * summary together; the short formats drop the summary, which is the half that
   * says *why*.
   */
  async blameLine(root: string, filePath: string, line: number): Promise<GitBlameLine | null> {
    if (!Number.isInteger(line) || line < 1) return null
    try {
      const { stdout } = await this.git(root, [
        'blame',
        '-L',
        `${line},${line}`,
        '--line-porcelain',
        '--',
        filePath
      ])
      const raw = stdout as string
      const hash = raw.slice(0, 40)
      if (!/^[0-9a-f]{40}$/.test(hash)) return null

      const field = (name: string): string => {
        const match = raw.match(new RegExp(`^${name} (.*)$`, 'm'))
        return match ? match[1].trim() : ''
      }
      const at = Number(field('author-time'))

      /*
       * Git spells a line that is not committed yet as the all-zero hash, and
       * names its author "Not Committed Yet". Saying so plainly beats reporting a
       * commit that does not exist.
       */
      return {
        hash,
        uncommitted: /^0+$/.test(hash),
        author: field('author') || 'Unknown',
        authoredAt: Number.isFinite(at) ? at * 1000 : 0,
        summary: field('summary')
      }
    } catch {
      // A file git has never seen, or one outside the repository. Not an error
      // worth reporting: the annotation simply has nothing to say.
      return null
    }
  }

  /**
   * Recent commits, for the repository or for one file.
   *
   * The fields are NUL-separated and the records end with a record separator,
   * because a commit subject can hold anything a person can type — newlines
   * included — and those two bytes are the ones it cannot.
   */
  async log(root: string, filePath: string | null, limit: number): Promise<GitLogEntry[]> {
    const capped = Math.min(Math.max(Math.trunc(limit) || 0, 1), 500)
    try {
      const args = [
        'log',
        `--max-count=${capped}`,
        `--format=%H${NUL}%h${NUL}%an${NUL}%at${NUL}%s${NUL}%P${RS}`
      ]
      if (filePath) args.push('--', filePath)
      const { stdout } = await this.git(root, args)
      return splitRecords(stdout as string).map((record) => {
        const [hash, short, author, at, subject, parents] = record.split('\0')
        const time = Number(at)
        return {
          hash: hash ?? '',
          short: short ?? '',
          author: author ?? '',
          authoredAt: Number.isFinite(time) ? time * 1000 : 0,
          subject: subject ?? '',
          // Two parents is a merge, worth marking: its diff is not what a list of
          // subjects otherwise implies.
          merge: (parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1
        }
      })
    } catch {
      return []
    }
  }

  /** What is on the stash, newest first, as git itself names the entries. */
  async stashList(root: string): Promise<GitStashEntry[]> {
    try {
      const { stdout } = await this.git(root, [
        'stash',
        'list',
        `--format=%gd${NUL}%H${NUL}%gs${NUL}%at${RS}`
      ])
      return splitRecords(stdout as string).map((record) => {
        const [ref, hash, subject, at] = record.split('\0')
        const time = Number(at)
        return {
          ref: ref ?? '',
          hash: hash ?? '',
          // Git prefixes every entry with "WIP on <branch>: " or "On <branch>: ".
          // The branch is worth keeping; the ceremony is not.
          subject: (subject ?? '').replace(/^(WIP on|On) /, ''),
          at: Number.isFinite(time) ? time * 1000 : 0
        }
      })
    } catch {
      return []
    }
  }

  /**
   * Put the working tree away. Untracked files go too, because a stash that
   * quietly leaves new files behind is the one that loses work — the next
   * checkout carries them into a branch they were never written for.
   */
  async stashPush(root: string, message: string): Promise<GitSimpleResult> {
    const args = ['stash', 'push', '--include-untracked']
    if (message.trim()) args.push('-m', message.trim())
    return this.simple(root, args)
  }

  /** Take one back. Popping drops it; applying keeps it, for a second branch. */
  /**
   * That `stash@{n}` still names the stash the caller meant.
   *
   * Stash references are positional and shift on every push — including one made
   * in the terminal in the next pane, which is the ordinary case here rather than
   * a rare one. The panel's list is loaded once, so its rows can describe one
   * stash while their references point at another, and the confirm-twice gesture
   * then confirms a label while acting on a reference.
   */
  private async stashStillIs(root: string, ref: string, expect?: string): Promise<boolean> {
    if (!expect) return true
    try {
      const { stdout } = await this.git(root, ['rev-parse', '--verify', `${ref}^{commit}`])
      return String(stdout).trim() === expect
    } catch {
      return false
    }
  }

  private static readonly MOVED =
    'That stash has moved — something else was stashed since this list was read. Reopening it will show where it is now.'

  async stashApply(
    root: string,
    ref: string,
    drop: boolean,
    expect?: string
  ): Promise<GitSimpleResult> {
    if (!STASH_REF.test(ref)) return { ok: false, error: 'Not a stash reference.' }
    if (!(await this.stashStillIs(root, ref, expect))) {
      return { ok: false, error: GitService.MOVED }
    }
    return this.simple(root, ['stash', drop ? 'pop' : 'apply', ref])
  }

  /** Throw one away. The one operation here that nothing undoes. */
  async stashDrop(root: string, ref: string, expect?: string): Promise<GitSimpleResult> {
    if (!STASH_REF.test(ref)) return { ok: false, error: 'Not a stash reference.' }
    // Destroying the wrong one is not recoverable, so this is checked even though
    // applying the wrong one is merely confusing.
    if (!(await this.stashStillIs(root, ref, expect))) {
      return { ok: false, error: GitService.MOVED }
    }
    return this.simple(root, ['stash', 'drop', ref])
  }

  private async simple(root: string, args: string[]): Promise<GitSimpleResult> {
    try {
      await this.git(root, args)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: GitService.message(err) }
    }
  }
}

/*
 * The two separators, written as escapes rather than as the bytes themselves so
 * that this file stays text a person can open. NUL divides the fields of one
 * record; the record separator divides the records.
 */
const NUL = '%x00'
const RS = '%x1e'

/** A stash reference, and nothing that merely looks like one. */
const STASH_REF = /^stash@\{\d+\}$/

/** Records as git emitted them, with the empty tail and leading newlines gone. */
function splitRecords(stdout: string): string[] {
  return stdout
    .split('\x1e')
    .map((record) => record.replace(/^[\r\n]+/, ''))
    .filter((record) => record.length > 0)
}

/** Git writes UTF-8; a NUL means the blob was never text to begin with. */
function decodeText(buffer: Buffer): string | null {
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return null
  return buffer.toString('utf8')
}

/**
 * Parse porcelain v2.
 *
 * Records are NUL-terminated and identified by their first field, so the stream is
 * walked rather than split into lines — a rename record carries its original path
 * as a second NUL-terminated field, which is the one case where a record is not
 * self-contained.
 */
function parseStatus(raw: string): Omit<GitStatus, 'root' | 'insertions' | 'deletions'> {
  const tokens = raw.split('\0')
  let branch: string | null = null
  let detached = false
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const staged: GitFileChange[] = []
  const changes: GitFileChange[] = []
  const conflicts: GitFileChange[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue

    if (token.startsWith('# ')) {
      const [key, ...rest] = token.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.head') {
        detached = value === '(detached)'
        branch = detached ? null : value
      } else if (key === 'branch.upstream') {
        upstream = value
      } else if (key === 'branch.ab') {
        // "+1 -2": ahead of upstream by one, behind by two.
        const m = /\+(\d+) -(\d+)/.exec(value)
        if (m) {
          ahead = Number(m[1])
          behind = Number(m[2])
        }
      }
      continue
    }

    const kind = token[0]

    if (kind === '?') {
      changes.push({ path: token.slice(2), origPath: null, status: 'U', staged: false })
      continue
    }

    if (kind === 'u') {
      // <u> <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const path = token.split(' ').slice(10).join(' ')
      conflicts.push({ path, origPath: null, status: 'C', staged: false })
      continue
    }

    if (kind === '1' || kind === '2') {
      const fields = token.split(' ')
      const xy = fields[1] ?? '..'
      // A rename record has an extra <score> field before the path.
      const path = fields.slice(kind === '1' ? 8 : 9).join(' ')
      const origPath = kind === '2' ? (tokens[++i] ?? null) : null

      const index = xy[0]
      const worktree = xy[1]
      if (index && index !== '.') {
        staged.push({ path, origPath, status: index, staged: true })
      }
      if (worktree && worktree !== '.') {
        changes.push({ path, origPath, status: worktree, staged: false })
      }
    }
  }

  const byPath = (a: GitFileChange, b: GitFileChange): number => a.path.localeCompare(b.path)
  return {
    // Filled in by status(), which reads it from the files beside the index —
    // porcelain output says nothing about a half-finished merge.
    operation: null,
    branch,
    detached,
    upstream,
    ahead,
    behind,
    staged: staged.sort(byPath),
    changes: changes.sort(byPath),
    conflicts: conflicts.sort(byPath)
  }
}
