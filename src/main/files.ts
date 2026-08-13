import { dialog, type BrowserWindow } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type {
  DirEntry,
  DirReadResult,
  FileOpenResult,
  FileReadResult,
  FileWriteResult
} from '../shared/types.js'

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
  return pathArgs(argv, appPath).files
}

/**
 * Paths on the command line, split into files to open and folders to work in.
 *
 * A folder argument is what Explorer's "Open in Ember" passes, and it means
 * something different from a file: not "show me this" but "start here", so the
 * shell opens in it and the sidebar is rooted there.
 */
export function pathArgs(argv: string[], appPath: string): { files: string[]; folders: string[] } {
  const files: string[] = []
  const folders: string[] = []
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    if (arg === appPath) continue
    // `.` is meaningful from a shell but is also what Chromium and packagers pass
    // around; resolved against the working directory it is an ordinary folder.
    const candidate = arg === '.' ? process.cwd() : arg
    try {
      if (!existsSync(candidate)) continue
      const info = statSync(candidate)
      if (info.isFile()) files.push(candidate)
      else if (info.isDirectory()) folders.push(resolve(candidate))
    } catch {
      // Not a path we can inspect; ignore it.
    }
  }
  return { files, folders }
}

export class FileService {
  /**
   * Whether a directory is still there. Used when putting a session back: a
   * workspace root or a shell's directory can be a temp folder that has since been
   * cleaned up, a renamed project, or a drive that is no longer plugged in.
   */
  async directoryExists(dirPath: string): Promise<boolean> {
    try {
      return (await stat(dirPath)).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * One directory level. The tree reads lazily on expand rather than walking
   * recursively — a root like a home directory or a repo with node_modules would
   * otherwise take seconds and pull tens of thousands of entries into memory.
   */
  async readDir(dirPath: string): Promise<DirReadResult> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      const items: DirEntry[] = []

      for (const entry of entries) {
        let isDirectory = entry.isDirectory()
        // A symlink reports its own type, so resolve it to place the entry
        // correctly; an unresolvable link is treated as a file.
        if (entry.isSymbolicLink()) {
          try {
            isDirectory = (await stat(join(dirPath, entry.name))).isDirectory()
          } catch {
            isDirectory = false
          }
        }
        items.push({
          name: entry.name,
          path: join(dirPath, entry.name),
          isDirectory,
          hidden: entry.name.startsWith('.')
        })
      }

      // Directories first, then case-insensitive by name, which is what every
      // file browser does and what makes a tree scannable.
      items.sort(
        (a, b) =>
          Number(b.isDirectory) - Number(a.isDirectory) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      )
      return { ok: true, path: dirPath, entries: items }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read directory.' }
    }
  }

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
