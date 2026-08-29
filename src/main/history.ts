import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { containsInlineSecret, redactSecrets } from '../shared/secrets.js'
import type {
  HistoryEntry,
  HistoryQuery,
  HistoryRecord,
  PersistedAttachment,
  PersistedBlock,
  PersistedCommandBlock,
  PersistedConversationBlock,
  PersistedProposal
} from '../shared/types.js'

/** Output is stored to make history searchable, not to reproduce a block. */
/*
 * Raised from 8000: a build log's middle was unrecallable — the living block
 * keeps a bounded tail and this kept less than a screenful more. A hundred
 * thousand characters holds the whole of almost any real command, and the FTS
 * index price for it is megabytes against a history already capped by rows.
 */
const MAX_OUTPUT_CHARS = 100_000

/*
 * History is a tool, not an archive: the blocks table has always been capped and
 * this one grew forever. Twenty thousand commands is years of work for most
 * people and a few megabytes on disk; past that, the oldest go.
 */
const MAX_HISTORY_ROWS = 20_000

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
 * The same idea for a conversation, at prose scale.
 *
 * An answer is plain text rather than rendered output, and a prompt is something a
 * person typed, so neither needs anything like the room a screen of build output
 * does. Both caps exist for the same reason as the one above: what a launch has to
 * read before it can show anything.
 */
const MAX_PROMPT_CHARS = 2_000
const MAX_ANSWER_CHARS = 16_000

/**
 * And for what the question was asked about.
 *
 * An attachment list is small by construction — it is however far back someone
 * walked with Ctrl+Up — but nothing in the shape of it says so, and each entry
 * holds a command line a person typed, which can be a pasted page as easily as a
 * word. Capped for the reason MAX_PROMPT_CHARS is: this column is read before a
 * launch can show anything, and a row that may grow without bound is a launch that
 * may. The count is generous enough that a real list survives whole; the length is
 * enough to name a command in a chip, which is all the stored copy is ever used for.
 */
const MAX_ATTACHED = 12
const MAX_ATTACHED_COMMAND_CHARS = 500

/**
 * Cut long output on a row boundary.
 *
 * The serializer emits one `<div class="row">` per logical line, so a cut anywhere
 * else would store half a tag and the restored block would render as markup. A
 * block with no boundary at all before the cap is one enormous line; it keeps its
 * head and says so, rather than coming back as text that ends mid-escape.
 *
 * The marker wears `block__elided`, the class the live capture marks its own lost
 * beginning with, because that class is how everything downstream asks whether a
 * block is whole — the chip on an attached block reads the stored HTML for it, so
 * a second way of saying "this was cut" is a cut the question cannot see, and the
 * conversation ends up claiming the agent was given a log it was given part of.
 * The sentence differs from the live one because the cuts are at opposite ends: a
 * capture loses its beginning, and this loses everything past the cap.
 */
function trimOutput(html: string): string {
  if (html.length <= MAX_BLOCK_HTML_CHARS) return html
  const cut = html.lastIndexOf('</div>', MAX_BLOCK_HTML_CHARS)
  const kept = cut === -1 ? '' : html.slice(0, cut + 6)
  return `${kept}<div class="row"><span class="block__elided">… the rest of the output was not kept</span></div>`
}

/** An answer is text, so it is cut on a line boundary and says that it was. */
function trimAnswer(text: string): string {
  if (text.length <= MAX_ANSWER_CHARS) return text
  const cut = text.lastIndexOf('\n', MAX_ANSWER_CHARS)
  const kept = cut === -1 ? text.slice(0, MAX_ANSWER_CHARS) : text.slice(0, cut)
  return `${kept}\n… the rest of the answer was not kept`
}

/**
 * The columns conversations needed, which the blocks table did not have.
 *
 * Every one of them is nullable and none of the existing columns changed, so a row
 * written by an earlier build is still a valid row — it simply has nothing in
 * these, which is exactly what "it is a command block" looks like on read. Adding
 * to the table rather than rebuilding it is the whole point: people have blocks
 * stored already, and a migration that dropped them would throw away the only
 * thing this table is for.
 */
const ADDED_BLOCK_COLUMNS: Record<string, string> = {
  kind: 'TEXT',
  prompt: 'TEXT',
  answer: 'TEXT',
  error: 'TEXT',
  proposal: 'TEXT',
  attached: 'TEXT'
}

/** One row of the blocks table, in the shape the statements below want it. */
interface BlockRow {
  kind: 'command' | 'conversation'
  command: string
  output: string
  status: string
  exitCode: number | null
  cwd: string
  startedAt: number
  durationMs: number | null
  interactive: number
  collapsed: number
  prompt: string | null
  answer: string | null
  error: string | null
  proposal: string | null
  /** The attachment list as JSON, since SQLite has no list of its own. */
  attached: string | null
}

/** The same row as it comes back out, before it is read as one kind or the other. */
interface StoredBlockRow {
  id: string
  kind: string | null
  command: string
  output: string
  status: string
  exitCode: number | null
  cwd: string
  startedAt: number
  durationMs: number | null
  interactive: number
  collapsed: number
  prompt: string | null
  answer: string | null
  error: string | null
  proposal: string | null
  attached: string | null
}

/**
 * A command block's row, or null when it must not be written at all.
 *
 * The rule is the one `record` follows: a credential typed on a command line is
 * dropped rather than stored, and one printed by a command is redacted.
 */
function commandRow(block: PersistedCommandBlock): BlockRow | null {
  const command = block.command.trim()
  if (command.length === 0) return null
  if (containsInlineSecret(command)) return null

  return {
    kind: 'command',
    command,
    output: redactSecrets(trimOutput(block.output)),
    status: block.status,
    exitCode: block.exitCode ?? null,
    cwd: block.cwd,
    startedAt: block.startedAt,
    durationMs: block.durationMs ?? null,
    interactive: block.interactive ? 1 : 0,
    collapsed: block.collapsed ? 1 : 0,
    prompt: null,
    answer: null,
    error: null,
    proposal: null,
    attached: null
  }
}

/**
 * The attachment list as it goes into the row, or null when nothing is left of it.
 *
 * Filtered by the rule this file already follows about command lines: an attached
 * command line is a command line, so one carrying a credential is dropped rather
 * than stored — the same verdict `commandRow` reaches about the block it is a copy
 * of. One entry goes rather than the exchange, because the answer and the other
 * attachments are still worth keeping, and a chip that is simply not there says
 * less than a chip naming a password would.
 */
function attachedJson(attached: PersistedAttachment[]): string | null {
  const kept = attached
    .map((a) => ({ ...a, command: a.command.trim() }))
    .filter((a) => a.command.length > 0 && !containsInlineSecret(a.command))
    .slice(0, MAX_ATTACHED)
    .map((a) => ({
      blockId: a.blockId,
      command: a.command.slice(0, MAX_ATTACHED_COMMAND_CHARS),
      elided: a.elided
    }))
  return kept.length === 0 ? null : JSON.stringify(kept)
}

/**
 * A conversation's row.
 *
 * The command columns are left empty rather than filled with something plausible.
 * A conversation has no exit code, no duration and no directory, and a zero written
 * into any of them is a number someone reads later as meaning something — the
 * status column says `done` because it has to say something, and nothing reads it
 * for a conversation.
 *
 * Prompt and answer are redacted rather than dropped, for the reason `record`
 * gives about output: they are prose, and losing a line from them is a far better
 * trade than losing the exchange. The proposal is different, because it is a
 * command line — and a command line carrying a credential is the one thing this
 * database never keeps, so the conversation is stored without it. Each attachment
 * is a command line too, and is held to the same rule one at a time.
 */
function conversationRow(block: PersistedConversationBlock): BlockRow | null {
  const prompt = block.prompt.trim()
  if (prompt.length === 0) return null

  const proposal =
    block.proposal && !containsInlineSecret(block.proposal.command) ? block.proposal : null

  return {
    kind: 'conversation',
    command: '',
    output: '',
    status: 'done',
    exitCode: null,
    cwd: '',
    startedAt: block.startedAt,
    durationMs: null,
    interactive: 0,
    collapsed: block.collapsed ? 1 : 0,
    prompt: redactSecrets(prompt.slice(0, MAX_PROMPT_CHARS)),
    answer: redactSecrets(trimAnswer(block.answer)),
    error: block.error === null ? null : redactSecrets(block.error),
    proposal: proposal
      ? JSON.stringify({
          command: proposal.command,
          note: redactSecrets(proposal.note),
          destructive: proposal.destructive,
          state: proposal.state
        })
      : null,
    attached: attachedJson(block.attached)
  }
}

/**
 * A stored proposal, or nothing.
 *
 * A state that cannot be read falls to `dismissed` rather than `open`, because
 * those are not equivalent guesses: `open` is the one state that still carries a
 * Run button, and a proposal whose verdict is unreadable must not come back asking
 * to be carried out.
 */
function parseProposal(json: string | null): PersistedProposal | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json) as Partial<PersistedProposal>
    if (typeof raw?.command !== 'string' || raw.command.length === 0) return null
    return {
      command: raw.command,
      note: typeof raw.note === 'string' ? raw.note : '',
      destructive: raw.destructive === true,
      state: raw.state === 'open' || raw.state === 'run' ? raw.state : 'dismissed'
    }
  } catch {
    return null
  }
}

/**
 * The attachments a stored row names, and never a throw.
 *
 * An exchange is worth restoring even when the note of what it was about cannot be
 * read, so everything unreadable ends at the same place: bad JSON, a value that is
 * not a list, an entry with no command to be named after. All of them come back as
 * no attachments, and the conversation itself is unaffected — the chips say what
 * the question was about, they are not what it said.
 *
 * The caps are applied here as well as on the way in. What is in the file is not
 * necessarily what this build wrote — a row survives a downgrade and an upgrade —
 * and a read that trusted the column's size would let a launch be slowed by a row
 * this build would never have written.
 */
function parseAttached(json: string | null): PersistedAttachment[] {
  if (!json) return []
  try {
    const raw: unknown = JSON.parse(json)
    if (!Array.isArray(raw)) return []
    const out: PersistedAttachment[] = []
    for (const entry of raw as Partial<PersistedAttachment>[]) {
      if (typeof entry?.blockId !== 'string' || typeof entry.command !== 'string') continue
      if (entry.command.length === 0) continue
      out.push({
        blockId: entry.blockId,
        command: entry.command.slice(0, MAX_ATTACHED_COMMAND_CHARS),
        elided: entry.elided === true
      })
      if (out.length === MAX_ATTACHED) break
    }
    return out
  } catch {
    return []
  }
}

/**
 * Read a row back as the block it describes.
 *
 * A null `kind` is not a missing value to be repaired — it is every block written
 * before conversations existed, and all of those are commands. SQLite has no
 * boolean and no enum of its own, which is why the flags come back as 0 and 1 and
 * why anything that is not a recorded failure is read as a finish.
 */
function toPersistedBlock(r: StoredBlockRow): PersistedBlock {
  if (r.kind === 'conversation') {
    return {
      kind: 'conversation',
      id: r.id,
      prompt: r.prompt ?? '',
      answer: r.answer ?? '',
      error: r.error,
      proposal: parseProposal(r.proposal),
      attached: parseAttached(r.attached),
      startedAt: r.startedAt,
      collapsed: !!r.collapsed
    }
  }
  return {
    kind: 'command',
    id: r.id,
    command: r.command,
    output: r.output,
    status: r.status === 'failed' ? 'failed' : 'done',
    exitCode: r.exitCode,
    cwd: r.cwd,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    interactive: !!r.interactive,
    collapsed: !!r.collapsed
  }
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
        collapsed   INTEGER NOT NULL DEFAULT 0,
        kind        TEXT,
        prompt      TEXT,
        answer      TEXT,
        error       TEXT,
        proposal    TEXT,
        attached    TEXT
      );
      -- Keyed on the clock the blocks are read back by, not on the order they
      -- were written; the index that was on (pane_id, seq) is dropped by name
      -- because CREATE INDEX IF NOT EXISTS would leave the old columns in place.
      DROP INDEX IF EXISTS idx_blocks_pane;
      CREATE INDEX IF NOT EXISTS idx_blocks_pane_time ON blocks(pane_id, started_at);
    `)
    this.addBlockColumns(db)
  }

  /**
   * Bring a blocks table written by an earlier build up to this one.
   *
   * CREATE TABLE IF NOT EXISTS does nothing whatever to a table that already
   * exists, so the columns above reach an existing install only by being added
   * here. Checked against the table rather than added and the error swallowed: a
   * column that was already there and a migration that genuinely failed would
   * otherwise look identical, and the second one loses conversations silently.
   */
  private addBlockColumns(db: DatabaseSync): void {
    const present = new Set(
      (db.prepare('PRAGMA table_info(blocks)').all() as unknown as { name: string }[]).map(
        (c) => c.name
      )
    )
    for (const [name, type] of Object.entries(ADDED_BLOCK_COLUMNS)) {
      if (present.has(name)) continue
      db.exec(`ALTER TABLE blocks ADD COLUMN ${name} ${type}`)
    }
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
      // The index rows first, while the base rows still exist to be selected by.
      db.exec(`
        DELETE FROM commands_fts WHERE rowid IN
          (SELECT id FROM commands ORDER BY id DESC LIMIT -1 OFFSET ${MAX_HISTORY_ROWS});
        DELETE FROM commands WHERE id IN
          (SELECT id FROM commands ORDER BY id DESC LIMIT -1 OFFSET ${MAX_HISTORY_ROWS});
      `)
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

  /**
   * The order a pane's blocks happened in, newest first.
   *
   * Not `seq`, which is the order they were written, and the two are not the same
   * list. A command block is written the instant the command finishes; a
   * conversation is written when the renderer's autosave debounce next fires, a
   * second or more after the answer landed. So a question asked before a command
   * can reach this table after it, and a pane read back by `seq` reopens with the
   * exchange sitting underneath the command it came before. A list of what happened
   * that gets the order wrong is not a record, it is a plausible-looking fiction —
   * and `started_at` is the one column on both kinds that says when the thing
   * actually began.
   *
   * `seq` breaks ties rather than being dropped: two blocks stamped in the same
   * millisecond have nothing better to be ordered by than which was written first.
   *
   * Rows from before this ordering need no migration. `started_at` was always the
   * real start time — a command's, or the moment a question was asked — so the
   * column was right all along and only the read of it was wrong. Every block
   * already in the file comes back in its true order the first time this runs.
   *
   * One constant, used by both the load and the trim, because a cap that keeps the
   * newest by one ordering while the load reads by another throws away blocks that
   * are still on screen.
   */
  private static readonly NEWEST_FIRST = 'ORDER BY started_at DESC, seq DESC'

  /**
   * Remember one finished block. Running commands and streaming answers are never
   * stored — both would come back looking like something still happening.
   *
   * An upsert on the id, which is what lets a conversation be written more than
   * once: unlike a command, it is not finished when it first appears here. The
   * answer arrives, and then the proposal is run or dismissed whenever the user
   * gets to it, and saying the same thing again costs one statement.
   */
  saveBlock(paneId: string, block: PersistedBlock): void {
    const row = block.kind === 'conversation' ? conversationRow(block) : commandRow(block)
    if (!row) return

    const db = this.open()
    if (!db) return

    try {
      db.prepare(
        `INSERT INTO blocks
           (id, pane_id, kind, command, output, status, exit_code, cwd, started_at,
            duration_ms, interactive, collapsed, prompt, answer, error, proposal,
            attached)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           output = excluded.output, status = excluded.status,
           exit_code = excluded.exit_code, duration_ms = excluded.duration_ms,
           interactive = excluded.interactive, collapsed = excluded.collapsed,
           answer = excluded.answer, error = excluded.error,
           proposal = excluded.proposal, attached = excluded.attached`
      ).run(
        block.id,
        paneId,
        row.kind,
        row.command,
        row.output,
        row.status,
        row.exitCode,
        row.cwd,
        row.startedAt,
        row.durationMs,
        row.interactive,
        row.collapsed,
        row.prompt,
        row.answer,
        row.error,
        row.proposal,
        row.attached
      )
      // Trimmed as it grows rather than swept later, so the table cannot outrun the
      // cap between launches. Keeping the newest by the same ordering the load uses:
      // by `seq` this would have kept whichever blocks were written last, which for
      // a conversation is not the same thing as which happened last, and the cap
      // would delete a command the pane was about to show.
      db.prepare(
        `DELETE FROM blocks WHERE pane_id = ? AND seq NOT IN (
           SELECT seq FROM blocks WHERE pane_id = ?
           ${HistoryStore.NEWEST_FIRST} LIMIT ?
         )`
      ).run(paneId, paneId, MAX_BLOCKS_PER_PANE)
    } catch {
      // Losing one block from the next launch is not worth interrupting this one.
    }
  }

  /**
   * The blocks to put back in these panes, oldest first.
   *
   * The newest `MAX_BLOCKS_PER_PANE` by when they happened, then turned round, so a
   * pane reopens holding its recent end in the order it was lived through.
   */
  loadBlocks(paneIds: string[]): Record<string, PersistedBlock[]> {
    const out: Record<string, PersistedBlock[]> = {}
    const db = this.open()
    if (!db || paneIds.length === 0) return out

    try {
      for (const paneId of paneIds) {
        const rows = db
          .prepare(
            `SELECT id, kind, command, output, status, exit_code AS exitCode, cwd,
                    started_at AS startedAt, duration_ms AS durationMs,
                    interactive, collapsed, prompt, answer, error, proposal, attached
             FROM blocks WHERE pane_id = ?
             ${HistoryStore.NEWEST_FIRST} LIMIT ?`
          )
          .all(paneId, MAX_BLOCKS_PER_PANE) as unknown as StoredBlockRow[]
        if (rows.length === 0) continue
        out[paneId] = rows.map(toPersistedBlock).reverse()
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
