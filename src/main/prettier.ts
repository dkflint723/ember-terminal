import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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

function findPrettier(filePath: string): PrettierInstall | null {
  const startDir = dirname(filePath)
  const cached = found.get(startDir)
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
            found.set(startDir, install)
            return install
          }
        }
      } catch {
        // A broken package.json is a workspace problem; keep walking up.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** How long a format may take before the save stops waiting on it. */
const FORMAT_TIMEOUT_MS = 10_000

export function formatWithPrettier(
  filePath: string,
  content: string
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const install = findPrettier(filePath)
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
