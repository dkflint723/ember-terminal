import { dialog, shell, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, statSync, type Stats } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  DirEntry,
  DirReadResult,
  FileMark,
  FileOpenResult,
  FileReadResult,
  FileSaveResult,
  FileStamp,
  FileWriteOptions,
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

      /*
       * The byte-order mark is taken off here and put back on write.
       *
       * Monaco strips a leading U+FEFF when it builds a model, so leaving it in the
       * text had two consequences: the stored copy never matched the buffer, which
       * marked every file with a BOM as unsaved the moment it opened, and saving
       * wrote the stripped version back — quietly removing a mark that changes how
       * other Windows tools read the file.
       */
      return {
        ok: true,
        path: filePath,
        name: basename(filePath),
        content: stripBom(buffer.toString('utf8')),
        // Detected so a save can preserve the file's existing convention.
        eol: buffer.includes('\r\n'.charCodeAt(0)) && /\r\n/.test(buffer.toString('utf8', 0, 4096))
          ? 'crlf'
          : 'lf',
        stamp: stampOf(buffer, info.mtimeMs)
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read that file.' }
    }
  }

  /**
   * Create an empty file, or a directory.
   *
   * Refuses to overwrite. A "new file" that silently truncated an existing one
   * would be a data-loss bug wearing the costume of a convenience.
   */
  async create(target: string, kind: 'file' | 'directory'): Promise<FileWriteResult> {
    try {
      if (existsSync(target)) return { ok: false, error: 'That name is already taken.' }
      if (kind === 'directory') {
        await mkdir(target, { recursive: true })
      } else {
        await mkdir(dirname(target), { recursive: true })
        // `wx` fails rather than truncates if something appeared in between.
        await writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not create that.' }
    }
  }

  async rename(from: string, to: string): Promise<FileWriteResult> {
    try {
      if (from === to) return { ok: true }
      // On Windows a rename that differs only in case is the same path, and has to
      // be allowed through — but anything else already there must not be clobbered.
      if (existsSync(to) && from.toLowerCase() !== to.toLowerCase()) {
        return { ok: false, error: 'That name is already taken.' }
      }
      await rename(from, to)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not rename that.' }
    }
  }

  /**
   * Delete to the recycle bin rather than unlinking.
   *
   * A tree with a delete key in it will eventually delete something the user
   * wanted, and the difference between "restore it" and "restore from backup" is
   * the whole reason to prefer the shell's own trash.
   */
  async trash(target: string): Promise<FileWriteResult> {
    try {
      await shell.trashItem(target)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not delete that.' }
    }
  }

  /**
   * Size and time for each of these files, so an editor can notice one changing.
   *
   * Polled, rather than watched. A watch on the folder of every open file is the
   * obvious design and on Windows it is a trap: the handle it holds stops the
   * folder above from being renamed — measured, EPERM from both Node and Explorer's
   * own rename — so it would break renaming a project folder, or any folder in
   * Ember's own tree that holds an open file. A stat opens and closes, holds
   * nothing, and costs next to nothing for the handful of files an editor has open.
   */
  async marks(paths: string[]): Promise<FileMark[]> {
    return Promise.all(
      paths.map(async (p): Promise<FileMark> => {
        try {
          const info = await statIfThere(p)
          if (!info || !info.isFile()) return 'missing'
          return { mtimeMs: info.mtimeMs, size: info.size }
        } catch {
          return 'unreadable'
        }
      })
    )
  }

  /** Show a path in the OS file manager, for "reveal in Explorer". */
  reveal(target: string): void {
    shell.showItemInFolder(target)
  }

  /**
   * Write editor text to a file, unless the file has moved on from the version the
   * text was based on.
   *
   * Every save used to write without looking. Claude Code in the next pane, a
   * `git checkout` in the terminal below, Ember's own Pull button or a second window
   * could change a file, and the next Ctrl+S — or an auto-save a second later — put
   * the old version back with the one new keystroke on top, and reported the tab
   * cleanly saved. The check is made here, beside the write, so the gap between
   * looking and writing is as short as it can be, and no path that saves can forget
   * to make it.
   */
  async write(filePath: string, content: string, opts: FileWriteOptions = {}): Promise<FileSaveResult> {
    try {
      const expect = opts.expect
      if (expect !== undefined && opts.force !== true) {
        const onDisk = await statIfThere(filePath)
        const name = basename(filePath)
        if (expect === null) {
          if (onDisk) {
            return { ok: false, conflict: 'changed', error: `${name} already exists on disk, so it was not saved over.` }
          }
        } else if (!onDisk) {
          return { ok: false, conflict: 'deleted', error: `${name} was deleted on disk, so it was not saved.` }
        } else if (onDisk.size !== expect.size || hashOf(await readFile(filePath)) !== expect.hash) {
          // A different size settles it without reading a byte. The same size
          // settles nothing, and neither does the time: git sets it to now, and
          // tools that restore a file can set it to anything at all.
          return { ok: false, conflict: 'changed', error: `${name} changed on disk since it was opened, so it was not saved.` }
        }
      }

      /*
       * A file that had a byte-order mark keeps it.
       *
       * Read from the file being overwritten rather than carried through the
       * editor, for the same reason the line endings are: it is a property of the
       * file, and every path that writes one — save, auto-save, Save All, the
       * write Claude Code makes when a diff is accepted — would otherwise have to
       * remember to pass it along, and one of them would not.
       *
       * The cost is that a BOM cannot be removed by editing in Ember. Preserving
       * one nobody meant to keep is a far smaller harm than silently deleting one
       * that other tools rely on to detect the encoding.
       */
      const data = Buffer.from((await hadBom(filePath)) ? `${BOM}${stripBom(content)}` : content, 'utf8')
      // Saving a deleted file anyway can mean its folder went with it — a branch
      // switch removes both — and the person has already said to put it back.
      if (opts.force === true) await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, data)
      // The stamp of what was written, so the next save knows its own work when it
      // sees it and only somebody else's as a change.
      return { ok: true, stamp: stampOf(data, (await stat(filePath)).mtimeMs) }
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

  /**
   * Pick a folder to work in, which is what makes the explorer, search and quick
   * open point somewhere. Without this the workspace could only ever be set from a
   * command-line argument or inherited from the terminal's directory.
   */
  async openFolderDialog(window: BrowserWindow, defaultPath?: string): Promise<string | null> {
    const picked = await dialog.showOpenDialog(window, {
      title: 'Open folder',
      defaultPath,
      properties: ['openDirectory']
    })
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
  }

  /** Used when saving a buffer that has no path yet. */
  async saveDialog(window: BrowserWindow, defaultPath?: string): Promise<string | null> {
    const picked = await dialog.showSaveDialog(window, { title: 'Save as', defaultPath })
    return picked.canceled || !picked.filePath ? null : picked.filePath
  }
}

/** The UTF-8 byte-order mark, as the single character it decodes to. */
const BOM = '\uFEFF'

function hashOf(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex')
}

/** The version these bytes are, as a later save will compare it. */
function stampOf(bytes: Buffer, mtimeMs: number): FileStamp {
  return { mtimeMs, size: bytes.length, hash: hashOf(bytes) }
}

/** Whether a value that came over IPC is a stamp, rather than trusting that it is. */
export function isStamp(value: unknown): value is FileStamp {
  const v = value as FileStamp | null | undefined
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.hash === 'string' &&
    Number.isFinite(v.size) &&
    Number.isFinite(v.mtimeMs)
  )
}

/** A path's details, or null when nothing is there. Any other failure is a real one. */
async function statIfThere(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text
}

/** Whether the file currently on disk starts with a byte-order mark. */
async function hadBom(filePath: string): Promise<boolean> {
  try {
    const { open } = await import('node:fs/promises')
    const handle = await open(filePath, 'r')
    try {
      const head = Buffer.alloc(3)
      const { bytesRead } = await handle.read(head, 0, 3, 0)
      return bytesRead === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
    } finally {
      await handle.close()
    }
  } catch {
    // A file that is not there yet has no convention to keep.
    return false
  }
}
