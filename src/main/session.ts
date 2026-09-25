import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionSnapshot } from '../shared/types.js'

/** One window's remembered life: where it stood, and what it held. */
export interface StoredWindow {
  bounds: { x: number; y: number; width: number; height: number } | null
  maximized: boolean
  snapshot: SessionSnapshot
}

/**
 * The last windows' shapes, on disk.
 *
 * Written through a temporary file and renamed into place, because the moment this
 * is most likely to be interrupted is exactly when it matters — the app closing, or
 * the machine going down. A half-written session file would take the workspace with
 * it, and a rename is the closest thing to atomic the filesystem offers.
 *
 * The file grew from one window to a list of them. Version 1 files — one bare
 * snapshot — still load, as a single window; version 2 holds every window that was
 * open, each with its own bounds. A window closed while others live is dropped from
 * the list at that moment: closing it was the statement that it should not return.
 *
 * A snapshot that cannot be read is discarded rather than repaired. Getting a
 * slightly wrong workspace back is more confusing than getting a fresh one.
 */
export class SessionStore {
  private file = join(app.getPath('userData'), 'session.json')
  private temp = `${this.file}.tmp`

  /** Unsaved buffers live in here, so it has to be bounded somewhere. */
  private static readonly MAX_BYTES = 24 * 1024 * 1024

  /** The windows as they last reported themselves, keyed by ember window id. */
  private entries = new Map<number, StoredWindow>()

  load(): StoredWindow[] {
    try {
      if (!existsSync(this.file)) return []
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as {
        version?: number
        windows?: unknown
        tabs?: unknown
      }

      // A version-1 file is one window's bare snapshot; it comes back as a list
      // of one so nothing upstream has to know the file was ever shaped that way.
      if (parsed?.version === 1) {
        const snapshot = parsed as unknown as SessionSnapshot
        if (!Array.isArray(snapshot.tabs) || !wellFormed(snapshot)) return []
        return [{ bounds: null, maximized: false, snapshot }]
      }

      if (parsed?.version !== 2 || !Array.isArray(parsed.windows)) return []
      const out: StoredWindow[] = []
      for (const raw of parsed.windows as StoredWindow[]) {
        const snapshot = raw?.snapshot
        if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.tabs)) continue
        if (!wellFormed(snapshot)) continue
        out.push({
          bounds: validBounds(raw.bounds) ? raw.bounds : null,
          maximized: raw.maximized === true,
          snapshot
        })
      }
      return out
    } catch {
      return []
    }
  }

  /** One window's latest word about itself; the whole file is rewritten with it. */
  saveFor(windowId: number, entry: StoredWindow): Promise<{ ok: boolean; error?: string }> {
    this.entries.set(windowId, entry)
    return this.write()
  }

  /**
   * What this window last said about itself, for a renderer that came back.
   *
   * The file on disk has no window ids in it — it is a list, and order is the only
   * identity it carries — so this is the in-memory map, which survives a renderer
   * reload because main does. A crash or a reload can therefore be handed the same
   * workspace the window had a moment before, rather than nothing.
   */
  entryFor(windowId: number): StoredWindow | null {
    return this.entries.get(windowId) ?? null
  }

  /**
   * A window closed while others live chose not to come back. Called only then —
   * the last window's close is the app closing, and that one must be kept.
   */
  dropWindow(windowId: number): void {
    if (!this.entries.delete(windowId)) return
    void this.write()
  }

  /*
   * Written off the main thread, one write at a time, the latest winning.
   *
   * It was writeFileSync on the thread that also forwards every byte of pty output,
   * with a snapshot that carries every unsaved buffer — so a save of a few megabytes
   * was a pause in every terminal, and saves came every few seconds while the app
   * sat idle. Now a save that arrives while one is being written is folded into a
   * single follow-up that writes whatever is newest by then, and each caller is
   * answered with how the write that covered it went.
   *
   * The generation guards `clear()`: a write already under way when the session is
   * cleared must not rename a file back into place after it has gone.
   */
  private writing: Promise<void> | null = null
  private again = false
  private dirty = false
  private generation = 0
  private last: { ok: boolean; error?: string } = { ok: true }

  private body(): string {
    return JSON.stringify({ version: 2, windows: [...this.entries.values()] })
  }

  private write(): Promise<{ ok: boolean; error?: string }> {
    if (this.body().length > SessionStore.MAX_BYTES) {
      return Promise.resolve({ ok: false, error: 'Session is too large to store.' })
    }
    this.dirty = true
    if (this.writing) {
      this.again = true
    } else {
      this.writing = this.drain().finally(() => {
        this.writing = null
      })
    }
    return this.writing!.then(() => this.last)
  }

  private async drain(): Promise<void> {
    do {
      this.again = false
      const generation = this.generation
      const body = this.body()
      try {
        await writeFile(this.temp, body, 'utf8')
        if (generation !== this.generation) return
        await rename(this.temp, this.file)
        if (generation !== this.generation) return
        if (!this.again) this.dirty = false
        this.last = { ok: true }
      } catch (err) {
        this.last = { ok: false, error: err instanceof Error ? err.message : 'Could not save session.' }
      }
    } while (this.again)
  }

  /*
   * The last word, written before the process goes.
   *
   * A write still under way when the app quits would be cut off with it, and the
   * farewell save each window sends on its way out is exactly the one that matters.
   * So at will-quit whatever is newest is written synchronously — through its own
   * temporary file, so it cannot be interleaved with a write still in flight — and
   * the generation moves on so that write, if it finishes, does not rename an older
   * body over this one.
   */
  flush(): void {
    if (!this.dirty && !this.writing) return
    this.generation += 1
    const body = this.body()
    if (body.length > SessionStore.MAX_BYTES) return
    const temp = `${this.file}.quit.tmp`
    try {
      writeFileSync(temp, body, 'utf8')
      renameSync(temp, this.file)
      this.dirty = false
    } catch {
      // Nothing left to tell: the windows are gone. The previous file stands.
    }
  }

  clear(): void {
    this.generation += 1
    this.dirty = false
    this.entries.clear()
    try {
      rmSync(this.file, { force: true })
    } catch {
      // Nothing to do about it, and nothing worth failing for.
    }
  }
}

function validBounds(b: StoredWindow['bounds']): b is NonNullable<StoredWindow['bounds']> {
  return (
    !!b &&
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height) &&
    b.width >= 200 &&
    b.height >= 120
  )
}

/** A layout node the renderer's walk can survive: leaves and splits, all the way down. */
function validNode(node: unknown, depth = 0): boolean {
  if (typeof node !== 'object' || node === null || depth > 32) return false
  const n = node as { type?: unknown; paneId?: unknown; children?: unknown }
  if (n.type === 'leaf') return typeof n.paneId === 'string'
  if (n.type !== 'split' || !Array.isArray(n.children) || n.children.length === 0) return false
  return n.children.every((child) => validNode(child, depth + 1))
}

/**
 * Whether a parsed session is shaped the way the renderer assumes.
 *
 * Checked here rather than there because main is the only place that can decline to
 * hand it over at all. Anything short of a full match is treated as no session,
 * which costs a restored layout and saves the window.
 */
function wellFormed(snapshot: SessionSnapshot): boolean {
  if (!Array.isArray(snapshot.panes)) return false
  if (snapshot.treeRoot !== null && typeof snapshot.treeRoot !== 'string') return false

  for (const tab of snapshot.tabs) {
    if (typeof tab?.id !== 'string' || typeof tab?.activePaneId !== 'string') return false
    if (!validNode(tab.root)) return false
    // Absent in older files and in tabs where nothing has been opened; present it
    // must still be a layout, or the renderer would walk a malformed tree.
    if (tab.editors !== undefined && tab.editors !== null && !validNode(tab.editors)) return false
    // Absent in every session written before a session had a project of its own.
    if (tab.workspace !== undefined && typeof tab.workspace !== 'string') return false
  }

  for (const pane of snapshot.panes) {
    if (typeof pane?.id !== 'string') return false
    if (pane.kind === 'editor' && !Array.isArray(pane.documents)) return false
    if (pane.kind !== 'editor' && pane.kind !== 'terminal') return false
  }
  return true
}
