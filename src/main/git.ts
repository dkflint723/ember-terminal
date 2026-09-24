import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { decodeText as decodeBytes } from '../shared/encoding.js'
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

/** Long enough for a cold index on a large repo, short enough not to hang the panel. */
const TIMEOUT_MS = 20_000
/** `git show` of a whole file has to fit; anything larger is not worth diffing. */
const MAX_BUFFER = 32 * 1024 * 1024

/**
 * git saying the object is not in that tree, which is an answer rather than a
 * failure.
 *
 * All three shapes it uses: a file staged but never committed is "exists on disk,
 * but not in 'HEAD'"; one that was never there at all "does not exist"; and a
 * stage of a path that is not conflicted "is in the index, but not at stage 2".
 * Anything else — an invalid revision, output past the buffer, a deadline — is a
 * failure and is treated as one.
 */
/**
 * For the calls that hand git a path somebody picked.
 *
 * git reads a pathspec as a glob, and `[id]` is a character class. Next.js and
 * SvelteKit name route folders exactly that, so discarding the untracked
 * `app/[id]/page.tsx` ran `clean -f -- app/[id]/page.tsx`, which also matched
 * `app/i/page.tsx` and `app/d/page.tsx` and deleted them. Permanently: clean does
 * not use the recycle bin, and an untracked file has nothing to come back from.
 *
 * On the calls that take paths, and not on the wrapper. It was on the wrapper,
 * with the argument that nothing here ever wants the glob — which was true of
 * the arguments this file passes and false of the ones git builds for itself.
 * `stash push --include-untracked` collects the untracked files through pathspec
 * machinery, and under literal pathspecs it collected none: the stash reported
 * success, and left every new file sitting in the working tree.
 */
const LITERAL_PATHS = { GIT_LITERAL_PATHSPECS: '1' } as const

const NOT_IN_THAT_TREE =
  /does not exist|exists on disk, but not in|is in the index, but not at stage/
/**
 * How much of git's own explanation is worth carrying to the panel.
 *
 * Generous, because the useful part is often the fourth or fifth line, and git is
 * not verbose when something has gone wrong. A merge listing a hundred conflicted
 * paths is the case this exists to stop.
 */
const MAX_ERROR_CHARS = 2000

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
  /**
   * Everything git is doing right now, by repository, so Cancel can reach it.
   *
   * Only calls with no deadline go in here. A status that hangs is already dealt
   * with by its own timeout; a push waiting on a credential prompt in a browser
   * is not, and is the reason this exists.
   */
  private running = new Map<string, Set<{ child: ChildProcess; cancelled: boolean }>>()

  /**
   * Stop whatever git is doing in this repository, and everything it started.
   *
   * The whole tree rather than git.exe alone: a commit is usually waiting on a
   * hook and a push on Git Credential Manager, both of which are children.
   * Killing the parent by itself leaves them running and holding the index, which
   * is the state this is meant to get out of rather than into.
   */
  async cancel(root: string): Promise<{ ok: boolean; stopped: number; lock: boolean }> {
    const live = this.running.get(root)
    let stopped = 0
    for (const entry of live ?? []) {
      entry.cancelled = true
      const pid = entry.child.pid
      if (pid === undefined) continue
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        stopped++
      } catch {
        // Gone between deciding to stop it and saying so. Nothing left to do.
      }
    }
    return { ok: true, stopped, lock: await this.indexLockExists(root) }
  }

  /**
   * Where this working tree keeps its git state.
   *
   * `.git` is a directory in an ordinary clone and a file everywhere else: a
   * linked worktree and a submodule both put a `gitdir:` pointer there instead,
   * and the state that pointer names is somewhere else entirely. Reading the
   * pointer rather than asking `git rev-parse --git-path` keeps this free — the
   * status poll runs every three seconds and does not need another process to
   * learn something a single file already says.
   */
  private async gitDirOf(root: string): Promise<string | null> {
    try {
      const { existsSync, readFileSync, statSync } = await import('node:fs')
      const { join, resolve, dirname } = await import('node:path')
      const dotGit = join(root, '.git')
      if (!existsSync(dotGit)) return null
      if (statSync(dotGit).isDirectory()) return dotGit
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]
      return pointer ? resolve(dirname(dotGit), pointer.trim()) : null
    } catch {
      return null
    }
  }

  /**
   * Whether git left its index lock behind.
   *
   * Worth saying after a cancel: git refuses to touch the index while it is
   * there. Removing it is not something the panel should do unasked — the
   * terminal in the next pane shares this repository, and the lock may be its.
   */
  private async indexLockExists(root: string): Promise<boolean> {
    const gitDir = await this.gitDirOf(root)
    if (!gitDir) return false
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    return existsSync(join(gitDir, 'index.lock'))
  }

  /**
   * One git call.
   *
   * The deadline is a decision rather than a constant now. Twenty seconds applied
   * to everything, including the operations that legitimately take longer: a
   * commit runs the repository's hooks, and a push or pull can be waiting on Git
   * Credential Manager to finish a sign-in in a browser. git was killed
   * mid-operation in all of those — a lint-staged hook taking twenty-five seconds
   * could not commit at all — and whatever the hook had started carried on
   * running without it.
   *
   * The callback form rather than the promisified one, because what that hands
   * back is the child, and Cancel needs something to kill.
   */
  private git(
    cwd: string,
    args: string[],
    options: {
      encoding?: 'utf8' | 'buffer'
      env?: NodeJS.ProcessEnv
      /** `null` for a call allowed to take as long as it takes. */
      timeout?: number | null
      /** The repository, when Cancel should be able to stop this. */
      cancelKey?: string
      /** Written to the child's stdin, for the calls that read one. */
      stdin?: string
    } = {}
  ): Promise<{ stdout: string | Buffer }> {
    const spawnOptions = {
      cwd,
      // Node reads 0 as "no deadline", which is what a null timeout asks for.
      timeout: options.timeout === null ? 0 : (options.timeout ?? TIMEOUT_MS),
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
        GIT_CONFIG_PARAMETERS: "'color.ui=false'",
        /*
         * Reading the working tree does not get to interrupt working in it.
         *
         * `git status` takes the index lock to write back what it learned while
         * stat-ing the tree — an optimisation for the next caller, and optional.
         * The panel polls every three seconds, and the terminal in the next pane
         * shares that index, so a `git add` typed there landed on a lock held by
         * a poll nobody asked for and died: `fatal: Unable to create
         * .git/index.lock: File exists.` Measured on a repository of fifteen
         * hundred files, a poll running continuously against an add loop: 35 of
         * 317 adds refused, and none once this was set.
         *
         * Safe on every call rather than only the reads, because this suppresses
         * the lock where it is optional and nowhere else — add, commit, stash and
         * restore take it because they need it, and go on taking it. Checked, not
         * assumed.
         */
        GIT_OPTIONAL_LOCKS: '0'
      }
    }

    return new Promise((resolve, reject) => {
      const entry = { child: undefined as unknown as ChildProcess, cancelled: false }
      const child = execFile('git', args, spawnOptions, (err, stdout, stderr) => {
        if (options.cancelKey) this.running.get(options.cancelKey)?.delete(entry)
        if (!err) {
          resolve({ stdout })
          return
        }
        // Node hands stderr to the callback rather than hanging it on the error,
        // and message() looks for it on the error.
        reject(Object.assign(err, { stderr: String(stderr ?? ''), cancelled: entry.cancelled }))
      })
      /*
       * Fed and closed at once. git waits on stdin for as long as it is open, so
       * forgetting the end() would hang the call until its deadline rather than
       * failing — the worst shape of bug to go looking for later.
       */
      if (options.stdin !== undefined) child.stdin?.end(options.stdin)
      entry.child = child
      if (options.cancelKey) {
        const live = this.running.get(options.cancelKey) ?? new Set()
        live.add(entry)
        this.running.set(options.cancelKey, live)
      }
    })
  }

  /**
   * What git said, rather than the first line of it.
   *
   * This returned `stderr.split('\n')[0]`, and git's first line is almost never
   * the one that explains anything. A rejected push opens with the remote's URL —
   * so the panel showed a path and nothing else, while the four lines under it
   * said `! [rejected] main -> main (fetch first)`, `error: failed to push some
   * refs`, and a hint naming `git pull` as the way out. A pull blocked by local
   * changes was the same shape: the branch it fetched from, and no mention of the
   * files standing in the way.
   *
   * Kept whole and capped, in git's own order. Reordering to put the explanation
   * first was the other option and it is worse: the lines refer to each other, and
   * a reader who knows git is looking for the shape they already recognise.
   */
  private static message(err: unknown): string {
    const e = err as {
      stderr?: string
      message?: string
      code?: string
      killed?: boolean
      cancelled?: boolean
    }
    if (e?.cancelled) return 'Stopped.'
    const stderr = typeof e?.stderr === 'string' ? e.stderr.replace(/\r\n/g, '\n').trim() : ''
    const capped =
      stderr.length > MAX_ERROR_CHARS
        ? `${stderr.slice(0, MAX_ERROR_CHARS).trimEnd()}\n…`
        : stderr
    /*
     * Said plainly, because Node does not. A killed child comes back as "Command
     * failed: git commit -m …" with nothing about the deadline in it, which reads
     * like git refused rather than like Ember stopped waiting.
     */
    // Node's own words for this are "stdout maxBuffer length exceeded", which
    // says nothing about which file or why it matters.
    if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return 'That file is too large to show a diff of.'
    }
    if (e?.killed) {
      const seconds = Math.round(TIMEOUT_MS / 1000)
      const timedOut = `git took longer than ${seconds} seconds, so it was stopped.`
      return capped ? `${timedOut}\n${capped}` : timedOut
    }
    if (capped) return capped
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
    /*
     * Through the pointer, because `.git` is only a directory in an ordinary
     * clone. In a linked worktree it is a file, so `<root>/.git/MERGE_HEAD` is a
     * path inside a file and can never exist — a conflicted merge there was
     * invisible to this panel. Worse than invisible: with the conflicts resolved
     * the lists come back empty, so it said "No changes" and disabled Commit,
     * which was the one button that would have finished the merge.
     */
    const gitDir = await this.gitDirOf(root)
    if (!gitDir) return null
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
      const { basename, dirname } = await import('node:path')
      const dir = dirname(filePath)
      /*
       * Where the file sits in the repository is asked of git, not worked out by
       * comparing git's root with the path the editor holds.
       *
       * The two need not be spelled alike. Git writes the root the way the
       * filesystem finally names it, so a buffer opened as
       * C:\Users\RUNNER~1\... was measured against C:/Users/runneradmin/...,
       * came out as somewhere above the repository, and was treated as outside it:
       * no gutter marks at all, on any line, however much was edited. That is
       * what a Windows profile with a long user name looks like whenever something
       * hands over its short form — a TEMP variable set that way, a tool on the
       * command line. `--show-prefix` is the directory's place inside the
       * repository in git's own terms, so the spelling never has to match.
       */
      const { stdout } = await this.git(dir, ['rev-parse', '--show-toplevel', '--show-prefix'])
      const [top = '', prefix = ''] = (stdout as string).split('\n').map((l) => l.replace(/\r$/, ''))
      const root = top.trim()
      if (!root) return null
      const rel = `${prefix}${basename(filePath)}`
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
      const { stdout } = await this.git(root, ['ls-files', '--unmerged', '--', path], {
        env: LITERAL_PATHS
      })
      return (stdout as string).trim().length > 0
    } catch {
      return false
    }
  }

  private async tracked(root: string, path: string): Promise<boolean> {
    try {
      const { stdout } = await this.git(root, ['ls-files', '--error-unmatch', '--', path], {
        env: LITERAL_PATHS
      })
      return (stdout as string).trim().length > 0
    } catch {
      return false
    }
  }

  /**
   * A blob's text, empty when the path does not exist at that revision — which is
   * the correct left-hand side for an added file — and null when it is binary.
   */
  /**
   * A file as one tree has it, or an empty string when that tree has no such file.
   *
   * Empty is a real answer: a file staged but never committed has no HEAD version,
   * and the left-hand side of its diff is genuinely nothing. It was also what came
   * back from every other failure — a call that ran out of time, output past the
   * buffer cap, a git that is not on PATH — and an empty left-hand side is drawn
   * by the editor as the whole file having just been added. So a `git show` that
   * was killed at twenty seconds presented a file that had barely changed as one
   * that was entirely new, with nothing anywhere saying so.
   *
   * A diff that fails is a nuisance. A diff that quietly says the opposite of the
   * truth is worse than no diff at all, and this one was reached by opening a file
   * in a large repository at a bad moment.
   */
  private async showOrEmpty(root: string, spec: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(root, ['show', spec], { encoding: 'buffer' })
      return decodeText(stdout as Buffer)
    } catch (err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? '')
      if (NOT_IN_THAT_TREE.test(stderr)) return ''
      throw err
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
    return this.simple(root, ['add', '--all', '--', ...paths], { env: LITERAL_PATHS })
  }

  async unstage(root: string, paths: string[]): Promise<GitSimpleResult> {
    return this.simple(root, ['restore', '--staged', '--', ...paths], { env: LITERAL_PATHS })
  }

  /**
   * Throw away working-tree changes. Destructive and not recoverable through git,
   * so the caller is expected to have confirmed with the user first.
   */
  async discard(root: string, paths: string[], untracked: string[]): Promise<GitSimpleResult> {
    if (paths.length) {
      const res = await this.simple(root, ['restore', '--worktree', '--', ...paths], {
        env: LITERAL_PATHS
      })
      if (!res.ok) return res
    }
    // An untracked file has no committed state to restore; it has to be removed.
    if (untracked.length) {
      return this.simple(root, ['clean', '-f', '--', ...untracked], { env: LITERAL_PATHS })
    }
    return { ok: true }
  }

  async commit(root: string, message: string): Promise<GitCommitResult> {
    if (!message.trim()) return { ok: false, error: 'A commit needs a message.' }
    try {
      // `--` with no pathspec commits exactly what is staged, never the working tree.
      const { stdout } = await this.git(root, ['commit', '-m', message], {
        timeout: null,
        cancelKey: root
      })
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
    return this.simple(root, hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], {
      timeout: null,
      cancelKey: root
    })
  }

  /**
   * A plain pull, merges and all: conflicts land in the working tree, and the
   * working tree is something this panel already knows how to show. Refusing
   * anything but fast-forwards would just outsource the mess to a terminal.
   */
  async pull(root: string): Promise<GitSimpleResult> {
    return this.simple(root, ['pull'], { timeout: null, cancelKey: root })
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

  /**
   * Carry on with a half-finished operation, step over it, or give it up.
   *
   * There was no way to do any of these from the panel. A rebase that stopped on
   * a conflict could only be finished from the terminal, and the panel's advice —
   * "commit to finish it" — was wrong for a rebase, where committing makes an
   * extra commit rather than continuing the one that stopped.
   *
   * No deadline, for the same reason a commit has none: `--continue` runs the
   * hooks. `GIT_EDITOR=true` takes the message git already prepared rather than
   * waiting for an editor that has nowhere to open.
   */
  async operationAction(
    root: string,
    operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert',
    action: 'continue' | 'abort' | 'skip'
  ): Promise<GitSimpleResult> {
    // Both come from the renderer, so both are checked against what git accepts
    // rather than passed through.
    const known = ['merge', 'rebase', 'cherry-pick', 'revert']
    const doable = ['continue', 'abort', 'skip']
    if (!known.includes(operation) || !doable.includes(action)) {
      return { ok: false, error: 'Not something that can be done to this operation.' }
    }
    if (action === 'skip' && operation === 'merge') {
      return { ok: false, error: 'A merge has nothing to skip.' }
    }
    return this.simple(root, [operation, `--${action}`], {
      timeout: null,
      cancelKey: root,
      env: { GIT_EDITOR: 'true' }
    })
  }

  // Checking out a large tree is slow on its own, and can run hooks besides.
  async checkout(root: string, name: string): Promise<GitSimpleResult> {
    return this.simple(root, ['checkout', name], { timeout: null, cancelKey: root })
  }

  async createBranch(root: string, name: string): Promise<GitSimpleResult> {
    return this.simple(root, ['checkout', '-b', name], { timeout: null, cancelKey: root })
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
  /**
   * Who last touched one line — of the buffer, when the buffer has been edited.
   *
   * The line number comes from the editor and the answer came from the file on
   * disk, which are the same thing only until something is typed. Insert a line
   * at the top of a file and every annotation below it is off by one: git is
   * asked about the caret's line number in a file that no longer has the caret's
   * line there. It does not go blank, which would at least look like an absence.
   * It names a real commit and a real author, neither of which touched the line
   * being pointed at.
   *
   * `--contents -` hands git the buffer to count lines in. Only sent when the
   * document is actually dirty: a saved file is already the same on both sides,
   * and this runs as the caret moves.
   */
  async blameLine(
    root: string,
    filePath: string,
    line: number,
    contents?: string
  ): Promise<GitBlameLine | null> {
    if (!Number.isInteger(line) || line < 1) return null
    try {
      const { stdout } = await this.git(
        root,
        [
          'blame',
          '-L',
          `${line},${line}`,
          '--line-porcelain',
          ...(contents === undefined ? [] : ['--contents', '-']),
          '--',
          filePath
        ],
        contents === undefined
          ? { env: LITERAL_PATHS }
          : { stdin: contents, env: LITERAL_PATHS }
      )
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
        `--format=%H${NUL}%h${NUL}%an${NUL}%at${NUL}%s${NUL}%P${NUL}`
      ]
      if (filePath) args.push('--', filePath)
      const { stdout } = await this.git(root, args)
      return fixedRecords(stdout as string, 6).map((record) => {
        const [hash, short, author, at, subject, parents] = record
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
        `--format=%gd${NUL}%H${NUL}%gs${NUL}%at${NUL}`
      ])
      return fixedRecords(stdout as string, 4).map((record) => {
        const [ref, hash, subject, at] = record
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

  private async simple(
    root: string,
    args: string[],
    options: { timeout?: number | null; cancelKey?: string; env?: NodeJS.ProcessEnv } = {}
  ): Promise<GitSimpleResult> {
    try {
      await this.git(root, args, options)
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

/** A stash reference, and nothing that merely looks like one. */
const STASH_REF = /^stash@\{\d+\}$/

/** Records as git emitted them, with the empty tail and leading newlines gone. */
/**
 * Records of a fixed number of NUL-separated fields.
 *
 * These were separated by U+001E and split on it, which any field able to hold
 * that byte could end early. A commit subject containing one truncated its own
 * entry and turned the remainder into a second, phantom commit — one whose hash
 * was the tail of the subject and whose short hash was the parent list, rendered
 * in the history as a real row with a blank message, and which typed a string of
 * parent hashes into the user's terminal when clicked. Ember can make such a
 * commit itself: `commit()` passes whatever message it is given straight through.
 *
 * Git forbids NUL inside the fields of a commit object, so counting them is exact
 * where splitting on a printable byte was a guess. The newline git puts between
 * entries lands at the head of the next record's first field.
 */
function fixedRecords(stdout: string, fields: number): string[][] {
  const parts = stdout.split('\0')
  const out: string[][] = []
  for (let i = 0; i + fields <= parts.length; i += fields) {
    const record = parts.slice(i, i + fields)
    record[0] = record[0].replace(/^[\r\n]+/, '')
    if (record[0].length > 0) out.push(record)
  }
  return out
}

/**
 * A blob, or a working file, as text — and null when it is binary.
 *
 * Read the way the editor reads the file itself, rather than as UTF-8 whatever it
 * is. Both sides of a comparison have to be decoded the same way or they differ
 * wherever the encoding does: with the editor showing a Windows-1252 file as its
 * own text and HEAD still coming back as replacement characters, every line with
 * an é in it would be reported as a change that was never made.
 */
function decodeText(buffer: Buffer): string | null {
  const decoded = decodeBytes(buffer)
  return 'binary' in decoded ? null : decoded.text
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
