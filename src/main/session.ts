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
      /*
       * Shape-checked, not just version-checked.
       *
       * The renderer walked these fields without guarding them, so a file that
       * parsed as JSON but was structurally wrong threw partway through boot. That
       * left a window with no tabs at all, and the autosave then wrote the empty
       * result back over the file — losing the workspace and any unsaved text in it
       * because one field had the wrong type.
       */
      if (!wellFormed(parsed)) return null
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
  }

  for (const pane of snapshot.panes) {
    if (typeof pane?.id !== 'string') return false
    if (pane.kind === 'editor' && !Array.isArray(pane.documents)) return false
    if (pane.kind !== 'editor' && pane.kind !== 'terminal') return false
  }
  return true
}
