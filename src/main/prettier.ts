import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isInside, samePath } from '../shared/paths.js'

/**
 * Prettier, when the workspace has it.
 *
 * Ember does not ship a formatting opinion; it borrows the project's, by
 * walking up from the file to the nearest node_modules/prettier and running
 * that copy over stdin. The project's own .prettierrc applies, because
 * prettier resolves configuration from the --stdin-filepath it is given. A
 * workspace without prettier is not an error — it is a workspace that has not
 * stated an opinion, and the caller falls back to the editor's formatter.
 */

interface PrettierInstall {
  /** The bin script, resolved from prettier's own package.json. */
  entry: string
  /** The project directory the walk found it under, used as the cwd. */
  root: string
}

/**
 * Found installs, cached by the directory the walk started from. Only hits are
 * cached: a workspace that gains prettier mid-session should be found on the
 * very next save, and thirty existsSync calls cost nothing.
 */
const found = new Map<string, PrettierInstall>()

/**
 * The nearest prettier at or above the file, without leaving the project.
 *
 * The walk used to run thirty parents whatever was open, so a file in a shallow
 * directory could find and run `C:\node_modules\prettier` — a copy belonging to
 * nobody, outside the project, run over the project's files. It stops at the
 * workspace root now, which also means the copy that runs is the one the trust
 * decision was actually about.
 */
function findPrettier(filePath: string, root: string | null): PrettierInstall | null {
  const startDir = dirname(filePath)
  // Keyed by the bound as well as by the start: the same directory searched with
  // and without a root can honestly have two different answers.
  const cacheKey = `${root ?? ''}|${startDir}`
  const cached = found.get(cacheKey)
  if (cached && existsSync(cached.entry)) return cached

  let dir = startDir
  for (let i = 0; i < 30; i++) {
    const pkgPath = join(dir, 'node_modules', 'prettier', 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          bin?: string | Record<string, string>
        }
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.prettier
        if (typeof bin === 'string') {
          const install = { entry: resolve(dirname(pkgPath), bin), root: dir }
          if (existsSync(install.entry)) {
            found.set(cacheKey, install)
            return install
          }
        }
      } catch {
        // A broken package.json is a workspace problem; keep walking up.
      }
    }
    // The project's edge. Above it is somebody else's node_modules.
    if (root && samePath(dir, root)) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * The root, but only if it really contains the file.
 *
 * A root that does not is ignored rather than obeyed: it would stop the walk at
 * the first step and quietly turn every format into "this project has none".
 */
function boundFor(filePath: string, root: string | null): string | null {
  return root && isInside(root, filePath) ? root : null
}

/**
 * Whether there is one to run at all.
 *
 * Asked when trust has already said it may not run, so that the refusal can be
 * said out loud where there was something to decline and stay quiet where there
 * was not — a project with no prettier has stated no opinion, and warning about
 * a formatter that was never going to run would be a notice on every save.
 */
export function hasPrettier(filePath: string, root: string | null): boolean {
  return findPrettier(filePath, boundFor(filePath, root)) !== null
}

/** How long a format may take before the save stops waiting on it. */
const FORMAT_TIMEOUT_MS = 10_000

export function formatWithPrettier(
  filePath: string,
  content: string,
  root: string | null = null
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const install = findPrettier(filePath, boundFor(filePath, root))
  if (!install) return Promise.resolve({ ok: false, error: 'absent' })

  return new Promise((resolvePromise) => {
    // Ember's own runtime runs the script: with ELECTRON_RUN_AS_NODE the
    // Electron binary is a plain node, so this works with no node on PATH.
    const child = spawn(process.execPath, [install.entry, '--stdin-filepath', filePath], {
      cwd: install.root,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })

    let out = ''
    let err = ''
    let settled = false
    const settle = (result: { ok: boolean; content?: string; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      settle({ ok: false, error: 'Prettier took too long; saved unformatted.' })
    }, FORMAT_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      err += chunk
    })
    child.on('error', (e) => settle({ ok: false, error: e.message }))
    child.on('close', (code) => {
      if (code === 0) settle({ ok: true, content: out })
      else settle({ ok: false, error: err.split('\n')[0] || `Prettier exited ${code}.` })
    })
    child.stdin.end(content, 'utf8')
  })
}
