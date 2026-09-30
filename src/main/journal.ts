import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TextEncodingName } from '../shared/encoding.js'
import type { FileStamp } from '../shared/types.js'
import type { FileService } from './files.js'
import { writeDocument } from './atomic.js'
import { hasSecret } from '../shared/secrets.js'

/**
 * The files accepted proposals wrote over, kept so the last one can be put back
 * (audit R27, SE-05).
 *
 * Accepting a proposal was final: the file's previous contents were in a diff pane
 * that closed on Accept, and nowhere else. Now the last twenty are kept in the user's
 * own data folder — whole, because a copy with its secrets taken out could not be put
 * back, and so a file holding a credential is not kept at all — and Revert last
 * accepted change restores the newest, but only if the file is still exactly what the
 * proposal wrote. Anything since is somebody's work, and is not overwritten.
 */
export interface AcceptedChange {
  path: string
  /** What was there, or null for a file the proposal created. */
  before: { content: string; encoding?: TextEncodingName } | null
  /** What the proposal wrote, as the write reported it. */
  after: FileStamp
  at: number
}

const KEEP = 20
/** A file larger than this is not kept, and so cannot be reverted: said at the time. */
const MOST_BYTES = 2 * 1024 * 1024
const TOTAL_BYTES = 12 * 1024 * 1024

export class AcceptJournal {
  private file: string
  private files: FileService

  constructor(dir: string, files: FileService) {
    this.file = join(dir, 'accepted-changes.json')
    this.files = files
  }

  private load(): AcceptedChange[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return Array.isArray(parsed) ? (parsed as AcceptedChange[]).filter((e) => typeof e?.path === 'string' && e.after) : []
    } catch {
      return []
    }
  }

  private async save(entries: AcceptedChange[]): Promise<void> {
    writeDocument(this.file, Buffer.from(JSON.stringify(entries), 'utf8'))
  }

  /**
   * Keep one, or say why not: too large, or holding a credential — a copy of a `.env`
   * sitting in the data folder is one more place a token lives, and is not made.
   */
  async record(change: AcceptedChange): Promise<'kept' | 'too-large' | 'secret' | 'invalid'> {
    if (typeof change?.path !== 'string' || !change.after) return 'invalid'
    if (change.before && Buffer.byteLength(change.before.content, 'utf8') > MOST_BYTES) return 'too-large'
    if (change.before && hasSecret(change.before.content)) return 'secret'
    let entries = [...this.load(), { ...change, at: Date.now() }].slice(-KEEP)
    while (entries.length > 1 && Buffer.byteLength(JSON.stringify(entries), 'utf8') > TOTAL_BYTES) entries = entries.slice(1)
    await this.save(entries)
    return 'kept'
  }

  /** The newest, for the command's label and its question. */
  last(): AcceptedChange | null {
    return this.load().at(-1) ?? null
  }

  /**
   * Put the newest back, if the file is still what the proposal wrote. A file the
   * proposal created goes to the Recycle Bin rather than being deleted outright.
   */
  async revert(): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const entries = this.load()
    const change = entries.at(-1)
    if (!change) return { ok: false, error: 'No accepted change is kept to revert.' }
    const now = await this.files.read(change.path)
    const unchanged = now.ok && now.stamp.size === change.after.size && now.stamp.hash === change.after.hash
    if (!unchanged) {
      return {
        ok: false,
        error: now.ok
          ? `${change.path} has changed since the proposal was accepted, so it was not put back.`
          : `${change.path} is not there as the proposal left it, so nothing was put back.`
      }
    }
    const done = change.before
      ? await this.files.write(change.path, change.before.content, { expect: now.stamp, encoding: change.before.encoding })
      : await this.files.trash(change.path)
    if (!done.ok) return { ok: false, error: done.error }
    await this.save(entries.slice(0, -1))
    return { ok: true, path: change.path }
  }
}
