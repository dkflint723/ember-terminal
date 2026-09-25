import * as fs from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Writing a file so that a crash, a full disk or a pulled plug leaves either the
 * old bytes or the new ones — never half of each.
 *
 * Every file Ember keeps was written in place or through a temporary file that was
 * renamed before it had reached the disk. The first leaves a truncated file behind
 * if anything goes wrong mid-write; the second can too, because a rename is
 * recorded before the data it points at unless the data is flushed first. A torn
 * session file lost every window and every unsaved buffer, and a torn save lost
 * the file being edited.
 *
 * So: a temporary file beside the target (a rename is only atomic within one
 * volume), written and flushed with fsync, then renamed over the target. With
 * `backup`, the target's previous bytes are first copied to `<name>.bak`, which is
 * what a damaged file can be recovered from.
 *
 * Windows adds one hazard: a rename fails with EPERM, EBUSY or EACCES while
 * anything — an antivirus scanner, the indexer, an editor — holds the target open.
 * Those are retried a few times with a short wait, which is usually all it takes.
 */

/** The filesystem calls this needs, so a test can make any one of them fail. */
export interface AtomicOps {
  openSync: typeof fs.openSync
  writeSync: (fd: number, data: Uint8Array) => number
  fsyncSync: typeof fs.fsyncSync
  closeSync: typeof fs.closeSync
  renameSync: typeof fs.renameSync
  copyFileSync: typeof fs.copyFileSync
  existsSync: typeof fs.existsSync
  rmSync: typeof fs.rmSync
}

const real: AtomicOps = {
  openSync: fs.openSync,
  writeSync: (fd, data) => fs.writeSync(fd, data),
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  copyFileSync: fs.copyFileSync,
  existsSync: fs.existsSync,
  rmSync: fs.rmSync
}

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** Wait without an event loop: this runs where a sync write was already expected. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function renameWithRetry(ops: AtomicOps, from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      ops.renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!BUSY.has(code) || attempt >= 3) throw err
      pause(40 * (attempt + 1))
    }
  }
}

export interface AtomicOptions {
  /** Keep the previous contents as `<file>.bak` before replacing them. */
  backup?: boolean
  ops?: AtomicOps
}

/**
 * Replace `file` with `data`, whole or not at all.
 *
 * Throws if the new bytes could not be put in place; the original is then exactly
 * as it was, and the temporary file is removed.
 */
export function writeAtomic(file: string, data: string | Uint8Array, options: AtomicOptions = {}): void {
  const ops = options.ops ?? real
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  // Named for the target and this process, so two windows writing two files never
  // share one, and a leftover from a crash is recognisable for what it is.
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)

  let fd: number | null = null
  try {
    fd = ops.openSync(temp, 'w')
    let written = 0
    while (written < bytes.length) written += ops.writeSync(fd, bytes.subarray(written))
    ops.fsyncSync(fd)
    ops.closeSync(fd)
    fd = null
    if (options.backup && ops.existsSync(file)) {
      // A copy, not a rename: renaming the original away first would leave a
      // moment with no file at all under its name.
      ops.copyFileSync(file, `${file}.bak`)
    }
    renameWithRetry(ops, temp, file)
  } catch (err) {
    if (fd !== null) {
      try {
        ops.closeSync(fd)
      } catch {
        // Already closed or never usable; the removal below is what matters.
      }
    }
    try {
      ops.rmSync(temp, { force: true })
    } catch {
      // Left behind is untidy but harmless: it is never read.
    }
    throw err
  }
}

/**
 * The same, for a file someone is editing, where replacing the file is not always
 * the right thing to do to it.
 *
 * A rename puts a new file under the old name, which is right almost always — and
 * wrong for a file with other hard links (they would keep the old text) and for a
 * symbolic link (the link itself would be replaced by a plain file). Those are
 * written where they live, in place. So is a file whose rename is still refused
 * after the retries, which on Windows means something is holding it; for that one
 * the previous bytes are copied to `<file>.bak` first, since an in-place write is
 * the one that can be interrupted halfway.
 *
 * Returns how it was written, for the caller to say so if it wants.
 */
export function writeDocument(file: string, data: Uint8Array, ops: AtomicOps = real): 'replaced' | 'in-place' {
  let target = file
  let linked = false
  try {
    const link = fs.lstatSync(file)
    if (link.isSymbolicLink()) target = fs.realpathSync(file)
    linked = fs.statSync(target).nlink > 1
  } catch {
    // A new file: nothing to preserve.
  }
  if (!linked) {
    try {
      writeAtomic(target, data, { ops })
      return 'replaced'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!BUSY.has(code)) throw err
    }
  }
  if (ops.existsSync(target)) ops.copyFileSync(target, `${target}.bak`)
  fs.writeFileSync(target, data)
  return 'in-place'
}

/**
 * `writeAtomic`, off the main thread — for the session file, which is written
 * often and must not stall the thread that forwards terminal output.
 */
export async function writeAtomicAsync(
  file: string,
  data: string,
  options: { backup?: boolean } = {}
): Promise<void> {
  // Not the synchronous writer's name: a flush at quit can run while one of these is
  // still under way, and the two must not write into the same temporary file.
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.async.tmp`)
  const handle = await fs.promises.open(temp, 'w')
  try {
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (options.backup && fs.existsSync(file)) await fs.promises.copyFile(file, `${file}.bak`)
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(temp, file)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (!BUSY.has(code) || attempt >= 3) throw err
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)))
      }
    }
  } catch (err) {
    await fs.promises.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Read a JSON file that may have been damaged, falling back to its `.bak`.
 *
 * A file that exists but will not parse is moved aside to `<file>.bad` — kept, not
 * deleted, because it may be the only copy of something — and the previous
 * generation is tried instead. `accept` says whether a parsed value is one this
 * version can use; one it cannot is treated the same way, so a file written by a
 * newer Ember is kept for it rather than overwritten by this one.
 */
export function readRecoverable<T>(
  file: string,
  accept: (value: unknown) => value is T
): { value: T | null; recovered: 'none' | 'backup' | 'lost'; problem?: string } {
  const attempt = (path: string): { value?: T; problem?: string } => {
    if (!fs.existsSync(path)) return {}
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path, 'utf8'))
      if (accept(value)) return { value }
      return { problem: 'it is not in a shape this version of Ember can read' }
    } catch (err) {
      return { problem: err instanceof Error ? err.message : 'it could not be read' }
    }
  }
  const main = attempt(file)
  if (main.value !== undefined) return { value: main.value, recovered: 'none' }
  if (main.problem === undefined) return { value: null, recovered: 'none' }
  try {
    fs.renameSync(file, `${file}.bad`)
  } catch {
    // Keeping it in place is better than losing it; the next write will replace it.
  }
  const backup = attempt(`${file}.bak`)
  if (backup.value !== undefined) return { value: backup.value, recovered: 'backup', problem: main.problem }
  return { value: null, recovered: 'lost', problem: main.problem }
}
