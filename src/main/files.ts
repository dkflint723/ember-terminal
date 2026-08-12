import { dialog, type BrowserWindow } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { FileOpenResult, FileReadResult, FileWriteResult } from '../shared/types.js'

/** Refuse to load something that is not a text file into a text editor. */
const MAX_BYTES = 16 * 1024 * 1024

/**
 * A NUL byte in the first few KB is the usual heuristic for binary content; opening
 * a binary in the editor would render garbage and risk corrupting it on save.
 */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  return sample.includes(0)
}

/**
 * File paths passed on the command line, so `ember notes.md` and file associations
 * work the way any desktop editor does.
 *
 * argv holds the executable, possibly the app directory in development, and Chromium
 * switches, none of which are files to open — hence checking each entry actually
 * exists rather than trusting position.
 */
export function fileArgs(argv: string[], appPath: string): string[] {
  const out: string[] = []
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    if (arg === '.' || arg === appPath) continue
    try {
      if (existsSync(arg) && statSync(arg).isFile()) out.push(arg)
    } catch {
      // Not a path we can inspect; ignore it.
    }
  }
  return out
}

export class FileService {
  async read(filePath: string): Promise<FileReadResult> {
    try {
      const info = await stat(filePath)
      if (info.isDirectory()) return { ok: false, error: 'That is a directory.' }
      if (info.size > MAX_BYTES) {
        return { ok: false, error: `File is too large to edit (${Math.round(info.size / 1e6)} MB).` }
      }

      const buffer = await readFile(filePath)
      if (looksBinary(buffer)) return { ok: false, error: 'That looks like a binary file.' }

      return {
        ok: true,
        path: filePath,
        name: basename(filePath),
        content: buffer.toString('utf8'),
        // Detected so a save can preserve the file's existing convention.
        eol: buffer.includes('\r\n'.charCodeAt(0)) && /\r\n/.test(buffer.toString('utf8', 0, 4096))
          ? 'crlf'
          : 'lf'
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read that file.' }
    }
  }

  async write(filePath: string, content: string): Promise<FileWriteResult> {
    try {
      await writeFile(filePath, content, 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save that file.' }
    }
  }

  async openDialog(window: BrowserWindow, defaultPath?: string): Promise<FileOpenResult> {
    const picked = await dialog.showOpenDialog(window, {
      title: 'Open file',
      defaultPath,
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    return this.read(picked.filePaths[0]) as Promise<FileOpenResult>
  }

  /** Used when saving a buffer that has no path yet. */
  async saveDialog(window: BrowserWindow, defaultPath?: string): Promise<string | null> {
    const picked = await dialog.showSaveDialog(window, { title: 'Save as', defaultPath })
    return picked.canceled || !picked.filePath ? null : picked.filePath
  }
}
