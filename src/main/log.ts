import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../shared/secrets.js'

/**
 * ember.log: one writer, a size it stays under, and no keys in it.
 *
 * Two functions in index.ts appended to it directly. Nothing ever trimmed it, so a
 * fault in a loop — a language server that dies on every keystroke, an updater that
 * cannot reach its server every hour — grew it without end on a machine where it is
 * the one file anyone will ask for. And whatever a fault carried was written as it
 * came: an error that quoted a request, a command line or a header put the key in
 * it, and the log is exactly the file that gets attached to a bug report.
 *
 * So every line goes through redactSecrets, the same rule history uses, and the file
 * is rotated at 2 MB: ember.log becomes ember.1.log, and so on, three generations
 * back, the oldest dropped. That bounds it at 8 MB whatever happens.
 *
 * The format is unchanged — `[time] label: text`, with a stack continuing on the
 * lines after — because it is read by people pasting it into a report and by the
 * suites, which fail on any line in it that is not narration. JSON lines would
 * serve neither better.
 *
 * Kept free of Electron so a table can drive it: the directory is asked for at each
 * write, since it is only known once the app is ready and the admin window has its
 * own.
 */
export const LOG_NAME = 'ember.log'
export const ROTATE_AT = 2 * 1024 * 1024
export const GENERATIONS = 3
/** Where the current file waits while the older ones move up; see rotate(). */
export const ROTATING_NAME = 'ember.rotating.log'
/** Characters of one line's text; a stack is a few KB, a quoted file is not. */
export const MAX_LINE = 64 * 1024

export interface Log {
  /** A narration line: the updater saying what it is doing. */
  line(label: string, text: string): void
  /** Something that went wrong. An Error is written with its stack. */
  fault(label: string, detail: unknown): void
  /** The last `n` lines of the current file, for a diagnostics report. */
  tail(n: number): string[]
  /** Where the current file is, for "Open logs". */
  path(): string
}

const generation = (dir: string, n: number): string =>
  n === 0 ? join(dir, LOG_NAME) : join(dir, `ember.${n}.log`)

export function textOf(detail: unknown): string {
  if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail) ?? String(detail)
  } catch {
    return String(detail)
  }
}

export function createLog(dirOf: () => string, rotateAt = ROTATE_AT): Log {
  /*
   * The current file moves first, under a name of its own, and only then does
   * anything older. Another program holding ember.log open — a `Get-Content -Wait`,
   * an editor tailing it — makes that first rename fail, and when it came last it
   * failed after the older generations had already been shifted and the oldest
   * deleted: every write while the file was held lost its line and one more
   * generation. Now a held file fails before anything is touched, and is rotated on
   * the first write after it is let go.
   */
  /*
   * A rotation that stopped part-way is finished before another starts. An older
   * generation held open — a tail left running after "Open logs" — can stop the
   * shift after the current file has moved aside, and the next rotation then
   * renamed the new current file over the one left waiting, which Windows allows:
   * that whole file was lost, and what was in it sat under a name no reader looks for.
   */
  const shiftInto1 = (dir: string, moving: string): void => {
    rmSync(generation(dir, GENERATIONS), { force: true })
    for (let n = GENERATIONS - 1; n >= 1; n -= 1) {
      const from = generation(dir, n)
      if (existsSync(from)) renameSync(from, generation(dir, n + 1))
    }
    renameSync(moving, generation(dir, 1))
  }
  const rotate = (dir: string): void => {
    const moving = join(dir, ROTATING_NAME)
    if (existsSync(moving)) shiftInto1(dir, moving)
    const current = generation(dir, 0)
    if (!existsSync(current) || statSync(current).size < rotateAt) return
    renameSync(current, moving)
    shiftInto1(dir, moving)
  }

  const write = (label: string, text: string): void => {
    let dir: string
    try {
      dir = dirOf()
    } catch {
      return
    }
    try {
      rotate(dir)
    } catch {
      // Not rotated this time; the line is still worth more than the size limit.
    }
    try {
      // One line cannot outgrow the limit either: a fault quoting a whole file is
      // clipped rather than written as a megabyte that no rotation would split.
      const body = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)} … [${text.length - MAX_LINE} more characters]` : text
      appendFileSync(
        generation(dir, 0),
        `[${new Date().toISOString()}] ${redactSecrets(label)}: ${redactSecrets(body)}\n`
      )
    } catch {
      // A log that cannot be written must not become its own crash.
    }
  }

  return {
    line: write,
    fault: (label, detail) => write(label, textOf(detail)),
    // Reaching back a generation when the current file is short: just after a
    // rotation it holds a line or two, and the lines that matter are in the last.
    tail(n) {
      const linesOf = (file: string): string[] => {
        try {
          const lines = readFileSync(file, 'utf8').split(/\r?\n/)
          if (lines.at(-1) === '') lines.pop()
          return lines
        } catch {
          return []
        }
      }
      let dir: string
      try {
        dir = dirOf()
      } catch {
        return []
      }
      const current = linesOf(generation(dir, 0))
      if (current.length >= n) return current.slice(-n)
      return [...linesOf(generation(dir, 1)), ...current].slice(-n)
    },
    path: () => generation(dirOf(), 0)
  }
}
