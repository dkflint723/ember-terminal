import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { containsInlineSecret, redactSecrets } from '../shared/secrets.js'
import type {
  HistoryEntry,
  HistoryQuery,
  HistoryRecord,
  PersistedBlock
} from '../shared/types.js'

/** Output is stored to make history searchable, not to reproduce a block. */
const MAX_OUTPUT_CHARS = 8000

/**
 * How much of each pane comes back, and how much of each block.
 *
 * Both are caps on what a launch has to read before it can show anything. A pane
 * shows its recent end and nothing scrolls back for ever, so keeping more than this
 * only buys a slower start — which is the failure Warp has, where an install of a
 * few weeks loads tens of thousands of rows before the first frame.
 */
const MAX_BLOCKS_PER_PANE = 120
const MAX_BLOCK_HTML_CHARS = 96_000

/**
 * Cut long output on a row boundary.
 *
 * The serializer emits one `<div class="row">` per logical line, so a cut anywhere
 * else would store half a tag and the restored block would render as markup. A
 * block with no boundary at all before the cap is one enormous line; it keeps its
 * head and says so, rather than coming back as text that ends mid-escape.
 */
function trimOutput(html: string): string {
  if (html.length <= MAX_BLOCK_HTML_CHARS) return html
  const cut = html.lastIndexOf('</div>', MAX_BLOCK_HTML_CHARS)
  const kept = cut === -1 ? '' : html.slice(0, cut + 6)
  return `${kept}<div class="row">… earlier output was not kept</div>`
}

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
      CREATE TABLE IF NOT EXISTS blocks (
        seq         INTEGER PRIMARY KEY,
        id          TEXT    NOT NULL UNIQUE,
        pane_id     TEXT    NOT NULL,
        command     TEXT    NOT NULL,
        output      TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL,
        exit_code   INTEGER,
        cwd         TEXT    NOT NULL DEFAULT '',
        started_at  INTEGER NOT NULL,
        duration_ms INTEGER,
        interactive INTEGER NOT NULL DEFAULT 0,
        collapsed   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_pane ON blocks(pane_id, seq);
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

    /*
     * The output is scrubbed as well as the command.
     *
     * A command line carrying a credential is dropped entirely, but plenty of
     * commands print one without mentioning it — `aws configure list`, a curl that
     * echoes its own headers, a script that dumps its environment. That went into
     * a database that outlives the session, in the clear. Redacted rather than
     * dropped: the output is what makes history searchable, and losing a line is a
     * far better trade than keeping a key.
     */
    const output = redactSecrets(entry.output.slice(0, MAX_OUTPUT_CHARS))
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

  /*
   * ---------- blocks kept for the next launch ----------
   *
   * The same database, deliberately: it is already here, already WAL, already the
   * place a command's text and output are trusted to live, and a second store would
   * be a second thing to migrate, prune and get wrong. What is kept here is the
   * rendered block rather than the searchable text, because these exist to put a
   * pane back rather than to be searched.
   *
   * Bounded on purpose. Warp keeps every block it has ever run in one table and
   * loads all of them on start, and a long-lived install eventually opens on a hang
   * — the pane only ever shows the recent end of the list, so that is all that is
   * worth keeping.
   */

  /** Remember one finished block. Running ones are never stored. */
  saveBlock(paneId: string, block: PersistedBlock): void {
    const command = block.command.trim()
    if (command.length === 0) return
    // The same rule history follows: a credential typed on a command line must not
    // reach a file that outlives the session, and one printed by a command is
    // redacted rather than kept.
    if (containsInlineSecret(command)) return

    const db = this.open()
    if (!db) return

    try {
      db.prepare(
        `INSERT INTO blocks
           (id, pane_id, command, output, status, exit_code, cwd, started_at,
            duration_ms, interactive, collapsed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           output = excluded.output, status = excluded.status,
           exit_code = excluded.exit_code, duration_ms = excluded.duration_ms,
           interactive = excluded.interactive, collapsed = excluded.collapsed`
      ).run(
        block.id,
        paneId,
        command,
        redactSecrets(trimOutput(block.output)),
        block.status,
        block.exitCode ?? null,
        block.cwd,
        block.startedAt,
        block.durationMs ?? null,
        block.interactive ? 1 : 0,
        block.collapsed ? 1 : 0
      )
      // Trimmed as it grows rather than swept later, so the table cannot outrun the
      // cap between launches.
      db.prepare(
        `DELETE FROM blocks WHERE pane_id = ? AND seq <= (
           SELECT seq FROM blocks WHERE pane_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?
         )`
      ).run(paneId, paneId, MAX_BLOCKS_PER_PANE)
    } catch {
      // Losing one block from the next launch is not worth interrupting this one.
    }
  }

  /** The blocks to put back in these panes, oldest first. */
  loadBlocks(paneIds: string[]): Record<string, PersistedBlock[]> {
    const out: Record<string, PersistedBlock[]> = {}
    const db = this.open()
    if (!db || paneIds.length === 0) return out

    try {
      for (const paneId of paneIds) {
        const rows = db
          .prepare(
            `SELECT id, command, output, status, exit_code AS exitCode, cwd,
                    started_at AS startedAt, duration_ms AS durationMs,
                    interactive, collapsed
             FROM blocks WHERE pane_id = ? ORDER BY seq DESC LIMIT ?`
          )
          .all(paneId, MAX_BLOCKS_PER_PANE) as unknown as (Omit<
          PersistedBlock,
          'interactive' | 'collapsed'
        > & { interactive: number; collapsed: number })[]
        if (rows.length === 0) continue
        // SQLite has no boolean of its own, so these come back as 0 and 1.
        out[paneId] = rows
          .map((r) => ({ ...r, interactive: !!r.interactive, collapsed: !!r.collapsed }))
          .reverse()
      }
    } catch {
      return out
    }
    return out
  }

  /**
   * Forget blocks. One pane when the user clears it, and everything belonging to
   * panes that no longer exist once a session has been restored — otherwise every
   * closed pane's blocks would sit in the file for good.
   */
  clearBlocks(paneId: string): void {
    const db = this.open()
    if (!db) return
    try {
      db.prepare('DELETE FROM blocks WHERE pane_id = ?').run(paneId)
    } catch {
      // Nothing else depends on this having happened.
    }
  }

  keepOnlyBlocksFor(paneIds: string[]): void {
    const db = this.open()
    if (!db) return
    try {
      if (paneIds.length === 0) {
        db.prepare('DELETE FROM blocks').run()
        return
      }
      const holes = paneIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM blocks WHERE pane_id NOT IN (${holes})`).run(...paneIds)
    } catch {
      // Same: housekeeping, not correctness.
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
