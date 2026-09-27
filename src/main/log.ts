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
  const rotate = (dir: string): void => {
    const current = generation(dir, 0)
    if (!existsSync(current) || statSync(current).size < rotateAt) return
    rmSync(generation(dir, GENERATIONS), { force: true })
    for (let n = GENERATIONS - 1; n >= 0; n -= 1) {
      const from = generation(dir, n)
      if (existsSync(from)) renameSync(from, generation(dir, n + 1))
    }
  }

  const write = (label: string, text: string): void => {
    try {
      const dir = dirOf()
      rotate(dir)
      appendFileSync(
        generation(dir, 0),
        `[${new Date().toISOString()}] ${redactSecrets(label)}: ${redactSecrets(text)}\n`
      )
    } catch {
      // A log that cannot be written must not become its own crash.
    }
  }

  return {
    line: write,
    fault: (label, detail) => write(label, textOf(detail)),
    tail(n) {
      try {
        const lines = readFileSync(generation(dirOf(), 0), 'utf8').split(/\r?\n/)
        if (lines.at(-1) === '') lines.pop()
        return lines.slice(-n)
      } catch {
        return []
      }
    },
    path: () => generation(dirOf(), 0)
  }
}
