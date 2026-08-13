import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionSnapshot } from '../shared/types.js'

/**
 * The last window's shape, on disk.
 *
 * Written through a temporary file and renamed into place, because the moment this
 * is most likely to be interrupted is exactly when it matters — the app closing, or
 * the machine going down. A half-written session file would take the workspace with
 * it, and a rename is the closest thing to atomic the filesystem offers.
 *
 * A snapshot that cannot be read is discarded rather than repaired. Getting a
 * slightly wrong workspace back is more confusing than getting a fresh one.
 */
export class SessionStore {
  private file = join(app.getPath('userData'), 'session.json')
  private temp = `${this.file}.tmp`

  /** Unsaved buffers live in here, so it has to be bounded somewhere. */
  private static readonly MAX_BYTES = 24 * 1024 * 1024

  load(): SessionSnapshot | null {
    try {
      if (!existsSync(this.file)) return null
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as SessionSnapshot
      // Version is the only compatibility promise made; anything else is a file
      // from a future or broken build and is not worth guessing at.
      if (parsed?.version !== 1 || !Array.isArray(parsed.tabs)) return null
      return parsed
    } catch {
      return null
    }
  }

  save(snapshot: SessionSnapshot): { ok: boolean; error?: string } {
    try {
      const body = JSON.stringify(snapshot)
      if (body.length > SessionStore.MAX_BYTES) {
        return { ok: false, error: 'Session is too large to store.' }
      }
      writeFileSync(this.temp, body, 'utf8')
      renameSync(this.temp, this.file)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save session.' }
    }
  }

  clear(): void {
    try {
      rmSync(this.file, { force: true })
    } catch {
      // Nothing to do about it, and nothing worth failing for.
    }
  }
}
