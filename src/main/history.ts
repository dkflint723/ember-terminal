import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { containsInlineSecret } from '../shared/secrets.js'
import type { HistoryEntry, HistoryQuery, HistoryRecord } from '../shared/types.js'

/** Output is stored to make history searchable, not to reproduce a block. */
const MAX_OUTPUT_CHARS = 8000

/**
 * Persistent command history.
 *
 * Built on the SQLite that ships inside Node rather than a native module: there
 * is no compiler on a typical Windows machine, and an append-only JSON file would
 * force a full scan for every keystroke of search. FTS5 gives indexed matching
 * over both the command and its output, which is what makes "find the command
 * where I did X" answerable.
 */
export class HistoryStore {
  private db: DatabaseSync | null = null
  private broken = false

  private open(): DatabaseSync | null {
    if (this.db || this.broken) return this.db
    try {
      this.db = new DatabaseSync(join(app.getPath('userData'), 'history.db'))
      this.migrate(this.db)
    } catch {
      // History is a convenience; losing it must never stop the app.
      this.broken = true
      this.db = null
    }
    return this.db
  }

  private migrate(db: DatabaseSync): void {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS commands (
        id          INTEGER PRIMARY KEY,
        command     TEXT    NOT NULL,
        cwd         TEXT    NOT NULL DEFAULT '',
        shell       TEXT    NOT NULL DEFAULT '',
        exit_code   INTEGER,
        duration_ms INTEGER,
        started_at  INTEGER NOT NULL,
        output      TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_commands_started ON commands(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_commands_cwd ON commands(cwd);
      CREATE VIRTUAL TABLE IF NOT EXISTS commands_fts USING fts5(
        command, output, content='commands', content_rowid='id'
      );
    `)
  }

  record(entry: HistoryRecord): void {
    const command = entry.command.trim()
    if (command.length === 0) return

    // A persisted history is forever, so a credential passed inline on the
    // command line must not be written to it at all.
    if (containsInlineSecret(command)) return

    const db = this.open()
    if (!db) return

    const output = entry.output.slice(0, MAX_OUTPUT_CHARS)
    try {
      const insert = db.prepare(
        `INSERT INTO commands (command, cwd, shell, exit_code, duration_ms, started_at, output)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      const result = insert.run(
        command,
        entry.cwd,
        entry.shell,
        entry.exitCode ?? null,
        entry.durationMs ?? null,
        entry.startedAt,
        output
      )
      db.prepare('INSERT INTO commands_fts (rowid, command, output) VALUES (?, ?, ?)').run(
        result.lastInsertRowid,
        command,
        output
      )
    } catch {
      // A failed write loses one entry; nothing else should notice.
    }
  }

  /**
   * Turn a search box's contents into an FTS5 query. Each word becomes a prefix
   * term so results narrow as the user types, and every term is quoted so
   * punctuation common in shell commands cannot be read as FTS operators.
   */
  private toMatchQuery(text: string): string | null {
    const terms = text
      .split(/\s+/)
      .map((t) => t.replace(/"/g, '').trim())
      .filter((t) => t.length > 0)
    if (terms.length === 0) return null
    return terms.map((t) => `"${t}"*`).join(' AND ')
  }

  search(query: HistoryQuery): HistoryEntry[] {
    const db = this.open()
    if (!db) return []

    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000)
    const filters: string[] = []
    const params: (string | number)[] = []

    if (query.cwd) {
      filters.push('c.cwd = ?')
      params.push(query.cwd)
    }
    if (query.onlyFailures) filters.push('c.exit_code IS NOT NULL AND c.exit_code != 0')

    const match = query.text ? this.toMatchQuery(query.text) : null

    try {
      let sql: string
      if (match) {
        // Weight the command far above the output: matching what was typed is
        // almost always the intent, with output matching as a fallback.
        sql = `
          SELECT c.id, c.command, c.cwd, c.shell, c.exit_code AS exitCode,
                 c.duration_ms AS durationMs, c.started_at AS startedAt
          FROM commands_fts f
          JOIN commands c ON c.id = f.rowid
          WHERE commands_fts MATCH ?
          ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
          ORDER BY bm25(commands_fts, 10.0, 1.0), c.started_at DESC
          LIMIT ?`
        return db.prepare(sql).all(match, ...params, limit) as unknown as HistoryEntry[]
      }

      sql = `
        SELECT c.id, c.command, c.cwd, c.shell, c.exit_code AS exitCode,
               c.duration_ms AS durationMs, c.started_at AS startedAt
        FROM commands c
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY c.started_at DESC
        LIMIT ?`
      return db.prepare(sql).all(...params, limit) as unknown as HistoryEntry[]
    } catch {
      return []
    }
  }

  /**
   * The most useful command starting with `prefix`. Commands run in the same
   * directory win, because history is far more relevant in the place it was used;
   * recency breaks the remaining ties.
   */
  suggest(prefix: string, cwd?: string): string | null {
    const trimmed = prefix.trimStart()
    if (trimmed.length < 2) return null
    const db = this.open()
    if (!db) return null

    // Compared with substr rather than LIKE: LIKE would read % and _ in the typed
    // prefix as wildcards, and the backslash escaping needed to prevent that is a
    // needless source of error when an exact prefix comparison says what is meant.
    try {
      const row = db
        .prepare(
          `SELECT command FROM commands
           WHERE substr(command, 1, ?) = ? AND command <> ?
           ORDER BY (cwd = ?) DESC, started_at DESC
           LIMIT 1`
        )
        .get(trimmed.length, trimmed, trimmed, cwd ?? '') as unknown as
        | { command?: string }
        | undefined
      return row?.command ?? null
    } catch {
      return null
    }
  }

  /** Distinct recent commands, for prefix suggestions in the input editor. */
  recentCommands(limit = 500): string[] {
    const db = this.open()
    if (!db) return []
    try {
      const rows = db
        .prepare(
          `SELECT command, MAX(started_at) AS last
           FROM commands GROUP BY command ORDER BY last DESC LIMIT ?`
        )
        .all(Math.min(limit, 2000)) as unknown as { command: string }[]
      return rows.map((r) => r.command)
    } catch {
      return []
    }
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      // Already closed.
    }
    this.db = null
  }
}
