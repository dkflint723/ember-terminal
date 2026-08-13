import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * "Open in Ember" on the Windows Explorer context menu.
 *
 * Three keys, because Explorer offers three different right-clicks that all mean
 * the same thing to a person: on a folder, on the empty space inside one, and on a
 * drive. Missing any of them makes the entry feel unreliable.
 *
 * Everything goes under HKCU, never HKLM: this is a per-user preference, and
 * writing to the machine hive would need elevation and would impose the entry on
 * everyone with an account.
 *
 * Registration is deliberately something the user turns on rather than something
 * installing the app does silently — it modifies the shell, and it should be as
 * easy to take back as it was to add.
 */
const KEYS = [
  'HKCU\\Software\\Classes\\Directory\\shell\\Ember',
  'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Ember',
  'HKCU\\Software\\Classes\\Drive\\shell\\Ember'
]

const LABEL = 'Open in Ember'

export class ExplorerMenu {
  /** Whether this platform can have the entry at all. */
  get supported(): boolean {
    return process.platform === 'win32'
  }

  /**
   * What Explorer should run. Packaged this is just the executable; from source it
   * is Electron plus the app directory, so the entry works during development
   * instead of launching an empty Electron.
   *
   * `%V` is the folder that was clicked. It is the one that works for all three
   * keys — `%1` is empty for a background click, which is the most natural of the
   * three to use.
   */
  private command(): string {
    const exe = process.execPath
    return app.isPackaged
      ? `"${exe}" "%V"`
      : `"${exe}" "${app.getAppPath()}" "%V"`
  }

  async isRegistered(): Promise<boolean> {
    if (!this.supported) return false
    try {
      const { stdout } = await run('reg', ['query', KEYS[0]], { windowsHide: true })
      return stdout.includes('Ember')
    } catch {
      // `reg query` exits non-zero when the key is absent, which is the answer.
      return false
    }
  }

  async register(): Promise<{ ok: boolean; error?: string }> {
    if (!this.supported) return { ok: false, error: 'Only available on Windows.' }
    try {
      for (const key of KEYS) {
        await run('reg', ['add', key, '/ve', '/d', LABEL, '/f'], { windowsHide: true })
        // The icon is read from the executable, so the entry carries the app's own
        // icon rather than a blank square.
        await run('reg', ['add', key, '/v', 'Icon', '/d', process.execPath, '/f'], {
          windowsHide: true
        })
        await run('reg', ['add', `${key}\\command`, '/ve', '/d', this.command(), '/f'], {
          windowsHide: true
        })
      }
      return { ok: true }
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      return { ok: false, error: (e.stderr || e.message || 'Could not write to the registry.').trim() }
    }
  }

  async unregister(): Promise<{ ok: boolean; error?: string }> {
    if (!this.supported) return { ok: false, error: 'Only available on Windows.' }
    let failure: string | null = null
    for (const key of KEYS) {
      try {
        await run('reg', ['delete', key, '/f'], { windowsHide: true })
      } catch (err) {
        // A key that is already gone is a success for the purpose of removing it;
        // anything else is worth reporting once at the end.
        const e = err as { stderr?: string }
        if (!(e.stderr ?? '').toLowerCase().includes('unable to find')) {
          failure = (e.stderr ?? 'Could not remove the entry.').trim()
        }
      }
    }
    return failure ? { ok: false, error: failure } : { ok: true }
  }
}
