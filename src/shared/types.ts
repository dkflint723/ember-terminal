/** Types shared across main, preload, and renderer. */

import type { ResolvedTheme, ThemeSummary } from './theme.js'
import type { AiEffort, AiMode } from './models.js'

export interface ShellProfile {
  id: string
  name: string
  /** Absolute path to the shell executable. */
  path: string
  args: string[]
  /** Which shell-integration dialect to inject, if any. */
  integration: 'powershell' | 'bash' | 'none'
  icon: string
  /**
   * Where a fresh session with this shell starts, when the profile says.
   * Absent for detected shells; carried over from a custom profile's "Start in".
   */
  cwd?: string
}

/**
 * A shell the user taught Ember about, kept in settings.
 *
 * Detection can only ever guess at the well-known five; a specific WSL distro,
 * a Developer PowerShell, nushell, or an ssh somewhere are all spawnable the
 * moment someone writes down how. The icon is derived, not stored — these
 * become full ShellProfiles when the list is served.
 */
export interface CustomProfile {
  id: string
  name: string
  /** The executable, absolute or resolvable on PATH. */
  path: string
  args: string[]
  integration: ShellProfile['integration']
  /**
   * Where a fresh session with this shell starts. Empty means the default —
   * home. An explicit cwd (a split, a restored pane, "open here") still wins.
   */
  cwd?: string
}

export interface SpawnRequest {
  paneId: string
  profileId: string
  cwd?: string
  cols: number
  rows: number
}

export interface PtyDataEvent {
  paneId: string
  data: string
}

export interface PtyExitEvent {
  paneId: string
  exitCode: number
}

export interface AiRequest {
  /** What the user typed in natural language. */
  intent: string
  /** Best-effort shell/OS context so the model emits a runnable command. */
  shell: string
  cwd: string
  /**
   * Recent failed command + output, when the user asks to explain an error.
   *
   * `cwd` is where that command ran, which is not necessarily the `cwd` above: an
   * attached block can predate a cd, or belong to another pane entirely. It is
   * optional because a caller that has no directory to name — the chat path, which
   * is about the work rather than one command — sends none, and a directory that
   * was not collected is left out of the prompt rather than guessed at.
   */
  recent?: {
    command: string
    output: string
    exitCode: number
    cwd?: string
    /** Whether `output` is a cut-down copy, which the model is told rather than left
        to infer from a length that both sides happen to cap at the same number. */
    elided?: boolean
  }[]
  mode: 'command' | 'explain' | 'chat'
}

export interface AiResponse {
  ok: boolean
  /** A single runnable command line, for mode: 'command'. */
  command?: string
  /** Prose explanation, for mode: 'explain'. */
  explanation?: string
  error?: string
}

export interface CompletionRequest {
  profileId: string
  cwd: string
  /** The whole input line, so shells can complete parameters in context. */
  input: string
  /** Caret offset within `input`. */
  cursor: number
}

export interface CompletionItem {
  /** Text to substitute into the line. */
  text: string
  /** What to show in the list, when it differs from `text`. */
  label: string
  /** Provider-specific kind, e.g. Command, ParameterName, ProviderItem. */
  type: string
  tip?: string
}

export interface CompletionResult {
  /** Start of the span in `input` that `text` replaces. */
  replaceIndex: number
  replaceLength: number
  items: CompletionItem[]
  /** Which backend answered, surfaced so the UI can explain reduced fidelity. */
  source: 'powershell' | 'generic' | 'none'
  error?: string
}

export interface HistoryRecord {
  command: string
  cwd: string
  shell: string
  exitCode: number | null
  durationMs: number | null
  startedAt: number
  /** Plain text, stored to make history searchable rather than replayable. */
  output: string
}

/**
 * A finished command block, kept so a pane comes back with its commands still in it.
 *
 * Separate from HistoryRecord even though both describe a command, because they
 * answer different questions: history is plain text so it can be searched across
 * every session, and this is the block's rendered output so the pane can be put
 * back the way the user left it. Only finished commands are stored — a block still
 * running when the app closed would come back looking live forever.
 */
export interface PersistedCommandBlock {
  /**
   * Optional rather than required, because every row written before conversations
   * existed has no kind at all. Those rows are read as commands rather than
   * rewritten: there are installs with blocks already stored, and the point of the
   * table is that they survive.
   */
  kind?: 'command'
  id: string
  command: string
  /** Serialized HTML, as the block rendered it. */
  output: string
  status: 'done' | 'failed'
  exitCode: number | null
  cwd: string
  startedAt: number
  durationMs: number | null
  interactive: boolean
  collapsed: boolean
}

/** What the agent offered to do, and what was decided about it. */
export interface PersistedProposal {
  command: string
  note: string
  destructive: boolean
  /**
   * The decision, kept rather than the card being dropped once it is made. A
   * conversation that comes back cannot offer to do a second time what was already
   * done, because only `open` is the state that still has a Run button attached to
   * it — and restoring a block runs nothing either way.
   */
  state: 'open' | 'run' | 'dismissed'
}

/**
 * One block a question was asked about, kept so a restored conversation still says
 * what it was about.
 *
 * The command is stored rather than looked up from the id later, because the block
 * it names need not still exist: a pane keeps only its recent end, and Clear
 * removes everything. An attachment that outlives its block is still a true record
 * of what was asked — one that could only point at a row that has gone would leave
 * the exchange looking like it came out of nowhere.
 */
export interface PersistedAttachment {
  blockId: string
  command: string
  /** Whether the output sent with it was cut short, which the chip says out loud. */
  elided: boolean
}

/**
 * One exchange with the agent, kept for the reason a command block is: it is part
 * of what happened in this pane, and the answer to "why did that fail" is worth as
 * much tomorrow as the failure itself.
 *
 * `streaming` is deliberately absent. A request that was still arriving when the
 * window closed is not still arriving now, so it is restored as false rather than
 * stored — a block that came back mid-stream would say "Thinking…" for ever.
 */
export interface PersistedConversationBlock {
  kind: 'conversation'
  id: string
  prompt: string
  answer: string
  /**
   * Why the request failed, when it did. Stored because an answer and a failure
   * are both empty in the `answer` column, and a failed exchange that came back
   * indistinguishable from an empty one would read as still waiting.
   */
  error: string | null
  proposal: PersistedProposal | null
  /** The blocks the question was asked about; empty when it was asked about none. */
  attached: PersistedAttachment[]
  startedAt: number
  collapsed: boolean
}

export type PersistedBlock = PersistedCommandBlock | PersistedConversationBlock

export interface HistoryEntry {
  id: number
  command: string
  cwd: string
  shell: string
  exitCode: number | null
  durationMs: number | null
  startedAt: number
}

export interface HistoryQuery {
  /** Free text; matched against the command and, more weakly, its output. */
  text?: string
  /** Restrict to one directory. */
  cwd?: string
  onlyFailures?: boolean
  limit?: number
}

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
  hidden: boolean
}

export type DirReadResult =
  | { ok: true; path: string; entries: DirEntry[] }
  | { ok: false; error: string }

export interface FileReadOk {
  ok: true
  path: string
  name: string
  content: string
  eol: 'lf' | 'crlf'
}

export type FileReadResult = FileReadOk | { ok: false; error: string }
export type FileOpenResult = FileReadOk | { ok: false; error?: string; canceled?: boolean }
export type FileWriteResult = { ok: true } | { ok: false; error: string }

/**
 * One changed path. `status` is git's own single letter — M, A, D, R, C — plus `U`
 * for untracked, which git reports as `?` but which reads better alongside the rest.
 * A path modified in both the index and the working tree appears twice, once in each
 * list, which is what lets it be staged and unstaged independently.
 */
export interface GitFileChange {
  /** Repository-relative, forward slashes, as git reports it. */
  path: string
  /** Where a rename came from, else null. */
  origPath: string | null
  status: string
  staged: boolean
}

export interface GitStatus {
  root: string
  /** Null on a detached HEAD, where `detached` is true instead. */
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  staged: GitFileChange[]
  changes: GitFileChange[]
  conflicts: GitFileChange[]
  /**
   * Lines added and removed across the working tree and the index together — the
   * `+77 −29` a person quotes about their day. Zero when the tree is clean, and
   * zero when the numbers could not be read, because a chip that says nothing is
   * better than one that fails a whole status for a statistic.
   */
  insertions: number
  deletions: number
  /**
   * A half-finished operation, which the change lists alone do not reveal: a merge
   * whose conflicts are all resolved looks exactly like a clean tree.
   */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null
}

export type GitStatusResult = { ok: true; status: GitStatus } | { ok: false; error: string }

export interface GitDiffOk {
  ok: true
  path: string
  /** Left-hand side; empty for a file that did not exist at that revision. */
  original: string
  modified: string
  originalLabel: string
  modifiedLabel: string
}

/**
 * A workspace, written down so it can be put back.
 *
 * Structure only: which tabs, how they were split, which shells were where and what
 * was open in the editors. Deliberately not the terminal scrollback — a block
 * reading "done in 107ms" from yesterday is a lie about a process that no longer
 * exists, and restoring it would make the pane look alive when it is not.
 *
 * Unsaved editor content is the exception, and is kept: a feature called session
 * restore that loses work someone had not saved would be worse than none at all.
 */
export type SessionLayout =
  | { type: 'leaf'; paneId: string }
  | { type: 'split'; direction: 'row' | 'column'; children: SessionLayout[]; sizes: number[] }

export interface SessionDocument {
  filePath: string | null
  title: string
  language: string
  eol: 'lf' | 'crlf'
  /** Only present when the buffer differed from disk when the session was written. */
  unsaved?: string
}

export type SessionPane =
  | { kind: 'terminal'; id: string; profileId: string; cwd: string; title: string }
  | { kind: 'editor'; id: string; activeIndex: number; documents: SessionDocument[] }

export interface SessionSnapshot {
  version: 1
  treeRoot: string | null
  sidebarOpen: boolean
  sidebarView: 'explorer' | 'search' | 'scm' | 'github' | 'problems' | 'debug' | 'run'
  /** Terminal mode's session list. Optional so sessions from older builds load. */
  sessionsOpen?: boolean
  agentOpen?: boolean
  agentWidth?: number
  /**
   * The window's debugging posture: breakpoints with their conditions, which
   * exception filters are on, and what F5 was last set to run. Sessions and
   * their processes are not restorable; where the marks stood is.
   */
  debug?: {
    breakpoints: {
      path: string
      lines: { line: number; condition?: string; logMessage?: string }[]
    }[]
    exceptionFilters?: Record<string, boolean>
    launchChoice?: string
  }
  activeTabId: string | null
  /**
   * `root` is the shells, and keeps its name so that a session written by an
   * earlier build still restores. `editors` is the middle of the IDE, and is
   * absent both in those older files and in any tab where nothing has been opened.
   */
  tabs: {
    id: string
    /** The session's conversation with the agent, newest last. */
    thread?: AgentTurn[]
    /** The user's own name for the session, when they gave it one. */
    name?: string
    root: SessionLayout
    editors?: SessionLayout
    activePaneId: string
  }[]
  panes: SessionPane[]
}

/**
 * A live terminal pane crossing between windows.
 *
 * The blocks travel as the opaque objects the renderer holds — main only
 * ferries them, and typing them here would mean teaching main a shape it has
 * no business acting on. The pty itself never moves: main re-points its output
 * at the adopting window, and the shell never notices.
 */
export interface TerminalPaneTransfer {
  id: string
  profileId: string
  cwd: string
  title: string
  exited: boolean
  exitCode: number | null
  integration: 'pending' | 'ready' | 'absent'
  blocks: unknown[]
}

/**
 * One session, packed to move to another window.
 *
 * Terminals travel live — blocks, standing, and the pty they are attached to.
 * Editors travel the way the session file writes them down, unsaved text
 * included, and the adopting window re-reads the files the same way a restore
 * does. The move is refused at the source while a command is running: a block
 * split across two windows mid-stream belongs to neither.
 */
export interface TabTransfer {
  tab: {
    id: string
    name?: string
    thread: AgentTurn[]
    root: SessionLayout
    editors?: SessionLayout | null
    activePaneId: string
  }
  terminals: TerminalPaneTransfer[]
  editors: Extract<SessionPane, { kind: 'editor' }>[]
  /** The source window's debugging posture, adopted when the new window has none. */
  debug?: SessionSnapshot['debug']
}

/**
 * A language server the user taught Ember about, kept in settings.
 *
 * The bundled four cover the common ground; rust-analyzer, gopls, clangd or
 * anything else that speaks LSP over stdio is one settings row away. The
 * languageId must be one Monaco knows (most are built in); extensions map
 * files to it when Monaco does not already.
 */
/**
 * A command worth keeping, with holes in it.
 *
 * The neighbour of the Scripts view: that lists what a project declares, and this
 * is what a person declares for themselves. Anything in double braces —
 * `deploy {{env}}` — is asked for before it runs, which is the difference between
 * a saved command and a note to copy from.
 */
export interface SavedCommand {
  id: string
  name: string
  command: string
}

export interface CustomLanguageServer {
  id: string
  /** Monaco language id this server answers for: 'rust', 'go', 'cpp', … */
  languageId: string
  name: string
  command: string
  args: string[]
  /** Extra file extensions for languageId, dots included; often unnecessary. */
  extensions?: string[]
}

/**
 * One debug adapter: a program that speaks the Debug Adapter Protocol.
 *
 * Detected ones come from probing the machine — VS Code ships js-debug, and an
 * install of it is a working Node debugger sitting right there. Taught ones
 * come from settings, exactly like custom shells: anything spawnable that
 * speaks DAP over stdio, or that listens on a port when handed one.
 */
export interface DebugAdapter {
  /** The DAP `type` this adapter answers for: 'pwa-node', 'debugpy', … */
  id: string
  name: string
  /** The command to spawn; for 'tcp' transports `${port}` in args is filled in. */
  command: string
  args: string[]
  transport: 'stdio' | 'tcp'
  /** Extra environment for the adapter process, merged over Ember's own. */
  env?: Record<string, string>
  /** Languages whose files this adapter debugs, by extension, dots included. */
  extensions: string[]
}

/** What the renderer asks main to start: which adapter, and what to run. */
export interface DebugStartRequest {
  adapterId: string
  /** The DAP launch arguments, handed to the adapter as they are. */
  launch: Record<string, unknown>
}

/** A protocol event or lifecycle notice from one debug session. */
export interface DapEventPayload {
  sessionId: string
  /** DAP event name, or the two lifecycle notices 'session-started' / 'session-ended'. */
  event: string
  body: unknown
}

/**
 * One thing the updater has to say, and what it means.
 *
 * The stage is carried rather than inferred: the Install now button used to
 * appear by matching the message text, so rewording the message — which
 * happened one release later — silently took the button away while the words
 * still told people to press it. What a message *is* must not be a guess made
 * from what it *says*.
 */
export interface UpdateStatus {
  text: string
  stage: 'progress' | 'ready' | 'error' | 'info'
}

/** What the Claude Code CLI can tell us about how, or whether, the user is signed in. */
export interface ClaudeAccess {
  installed: boolean
  signedIn: boolean
  account: string | null
  plan: string | null
  /** Present when the CLI is there but could not answer. */
  error: string | null
}

/** Where Ember's AI features get their credentials from, in the order tried. */
export interface AiCredential {
  source: 'settings-key' | 'environment-key' | 'claude-code' | 'none'
  detail: string | null
}

/** One rate-limited quantity, as the API reports it in a response header. */
export interface AiLimit {
  limit: number | null
  remaining: number | null
  /** When the window refills, ISO 8601 as sent. */
  reset: string | null
}

/**
 * What is left of the API's rate limits, read from the headers of a real answer.
 *
 * There is no endpoint that reports this — the numbers ride along with responses,
 * so what can be shown is always "as of the last request", and asking for a fresh
 * reading means making one. Only the API-key path has them at all: a Claude Code
 * subscription's limits are not exposed outside a session, which the panel says
 * rather than leaving an empty box to be read as "nothing left".
 */
export interface AiUsage {
  /** When these numbers were read, epoch milliseconds. */
  at: number
  source: AiCredential['source']
  requests: AiLimit
  inputTokens: AiLimit
  outputTokens: AiLimit
  /** Seconds the API asked us to wait, when it turned a request away. */
  retryAfter: number | null
}

/** One editor snippet, in the form the completion list needs it. */
export interface Snippet {
  label: string
  prefix: string
  /** The insertion text, in the `${1:placeholder}` syntax Monaco already speaks. */
  body: string
  description: string | null
}

export interface SearchQuery {
  root: string
  text: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  /** A ripgrep glob such as `*.ts`, or empty for everything. */
  include: string
}

export interface SearchHit {
  path: string
  line: number
  /** Character offsets into `preview`, so a match can be highlighted. */
  column: number
  length: number
  preview: string
}

/** Every file in the workspace, or why they could not be listed. */
export type FileListResult =
  | { ok: true; files: string[] }
  | { ok: false; error: string }

export type SearchResult =
  | { ok: true; hits: SearchHit[]; truncated: boolean }
  | { ok: false; error: string }

/**
 * A replacement driven by hits that have already been found, rather than by running
 * the search again. What the user is about to change is exactly what they were
 * shown, and there is no second matcher whose idea of the query could differ from
 * ripgrep's.
 */
export interface ReplaceRequest {
  hits: SearchHit[]
  replacement: string
  /** Needed only so `$1` in the replacement can mean what it does in the pattern. */
  pattern: string
  regex: boolean
  caseSensitive: boolean
}

export interface ReplaceOutcome {
  ok: boolean
  files: number
  replaced: number
  /** Hits whose line no longer holds the text that was found there. */
  stale: number
  error?: string
}

/** A finished command worth telling the user about. */
export interface CommandNotice {
  command: string
  durationMs: number
  ok: boolean
  /** So a click can put the user back where the command ran. */
  paneId: string
}

/** One word for a pull request's checks, reduced from however many it has. */
export type GitHubCheckState = 'passing' | 'failing' | 'pending' | 'none'

export interface GitHubPr {
  number: number
  title: string
  author: string
  isDraft: boolean
  state: string
  headRefName: string
  updatedAt: string
  url: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when none applies. */
  reviewDecision: string | null
  checks: GitHubCheckState
}

export interface GitHubIssue {
  number: number
  title: string
  author: string
  updatedAt: string
  url: string
  labels: string[]
}

export interface GitHubOverview {
  repo: { owner: string; name: string; url: string; defaultBranch: string }
  prs: GitHubPr[]
  issues: GitHubIssue[]
}

/**
 * A failure carries why, not just what: gh missing, not signed in and no GitHub
 * remote each have a different remedy, and the panel says which.
 */
export type GitHubFailure = 'no-cli' | 'no-auth' | 'no-repo' | 'error'

export type GitHubResult =
  | { ok: true; overview: GitHubOverview; reason?: undefined }
  | { ok: false; reason: GitHubFailure; error: string }

/** A Claude Code tool call, forwarded from the socket in main to the editors here. */
export interface IdeCall {
  id: number
  name: string
  args: Record<string, unknown>
}

export type GitDiffResult = GitDiffOk | { ok: false; error: string }
export type GitSimpleResult = { ok: true } | { ok: false; error: string }
export type GitCommitResult = { ok: true; summary: string } | { ok: false; error: string }

/** Who last touched one line, and why. */
export interface GitBlameLine {
  hash: string
  /** True where the line is not committed yet — git's all-zero hash. */
  uncommitted: boolean
  author: string
  authoredAt: number
  summary: string
}

/** One commit, as a list of them needs it. */
export interface GitLogEntry {
  hash: string
  short: string
  author: string
  authoredAt: number
  subject: string
  /** More than one parent: its diff is not what a list of subjects implies. */
  merge: boolean
}

/** One entry on the stash. `ref` is git's own name for it, `stash@{0}` and so on. */
export interface GitStashEntry {
  ref: string
  subject: string
  at: number
}

/** One turn of a session's conversation with the agent. */
export interface AgentTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  status: 'streaming' | 'done' | 'error' | 'cancelled'
  error?: string
}

/** What the panel sends: the whole thread, plus where the session stands. */
export interface AiChatRequest {
  requestId: string
  messages: { role: 'user' | 'assistant'; text: string }[]
  cwd: string
  shell: string
  /** The file under the caret when the window is an IDE, capped by the sender. */
  activeFile?: { path: string; text: string }
  /** Command blocks the user attached, already rendered to plain text. */
  attached?: string[]
}

/** Streaming events for one chat request, in arrival order. */
export interface AiChatEvent {
  requestId: string
  /** A few more characters of the answer. */
  delta?: string
  /** Set once, last: the stream ended this way. */
  done?: 'complete' | 'cancelled' | 'error'
  error?: string
}

export interface LspEvent {
  type: 'message' | 'exit' | 'restarted'
  language: string
  message?: unknown
  code?: number | null
  /** Set when the server failed to start at all, rather than exiting later. */
  error?: string
}

/** How much room a command block takes. See Settings.blockDensity. */
export type BlockDensity = 'compact' | 'normal' | 'comfortable'

/**
 * Who writes the suggestion that appears ahead of the caret.
 *
 * `local` and `openai` are the same protocol — an OpenAI-compatible HTTP endpoint —
 * which is why there is no separate entry for Ollama, llama.cpp, LM Studio,
 * OpenRouter or anyone else who speaks it. They differ in two honest ways: a local
 * server needs no key, and a model served locally is usually one trained to fill in
 * the middle, so it is asked in that form rather than in prose.
 *
 * `claude` goes through the credential this app already has, so it costs a
 * subscription rather than a second key.
 */
export type GhostProvider = 'local' | 'openai' | 'claude'

/** What the editor sends when it wants a suggestion: the caret, with context. */
export interface GhostRequest {
  /** The text before the caret, already trimmed to a budget by the caller. */
  prefix: string
  /** The text after it. */
  suffix: string
  language: string
}

/** What one deliberate test of the suggestion setup found. */
export type GhostTest =
  | { ok: true; ms: number; sample: string; shape: string | null }
  | { ok: false; error: string; ms: number }

export type GhostResult = { ok: true; text: string } | { ok: false; error: string }

export interface Settings {
  fontFamily: string
  fontSize: number
  defaultProfileId: string | null
  /** Id of a theme in the VS Code color-theme format; see shared/theme.ts. */
  themeId: string
  /**
   * Stored encrypted at rest via Electron safeStorage when available.
   *
   * Always null when read from the renderer — the value stays in main, which is
   * the only side that needs it. Set it by sending a string; leave it undefined in
   * a patch to keep whatever is already stored.
   */
  anthropicApiKey: string | null
  aiModel: string
  /**
   * How hard Claude thinks before answering. Low by default because the request
   * this app makes most often is one command line, where the wait is the thing
   * being felt — the switcher beside the prompt is there to raise it for the
   * questions that deserve it.
   */
  aiEffort: AiEffort
  /**
   * How much the agent may do without being asked.
   *
   * Manual by default, and deliberately so: this is a terminal, the proposal is a
   * real command line, and the difference between the three settings is whether a
   * sentence written by a model reaches a shell without anyone reading it first.
   * Someone who wants that can say so; nobody should get it by not choosing.
   */
  aiMode: AiMode
  /** Shells the user added by hand, served alongside the detected ones. */
  customProfiles: CustomProfile[]
  /** Commands the user keeps, listed beside a project's own scripts. */
  savedCommands: SavedCommand[]
  /** Debug adapters the user taught Ember about, served with the detected ones. */
  debugAdapters: DebugAdapter[]
  /** Language servers the user taught Ember about, joined with the bundled ones. */
  languageServers: CustomLanguageServer[]
  /**
   * Format a document as part of an explicit save. Off by default — a save
   * that rewrites the file is a real change in what Ctrl+S means, and should
   * be chosen. Auto-saves never format; they fire mid-thought.
   */
  formatOnSave: boolean
  /**
   * Chord overrides by command id — only the differences from the defaults.
   * The registry of commands and their default chords lives in renderer code;
   * settings only remember what the user changed.
   */
  keybindings: Record<string, string>
  /** Put the last window's tabs, splits and open files back on launch. */
  restoreSession: boolean
  /**
   * Notify when a command taking at least this many seconds finishes while the
   * window is not focused. Zero turns it off.
   */
  notifyAfterSeconds: number
  /**
   * Save an edited file this many seconds after typing stops. Zero turns it off,
   * which is the default: writing to disk on a timer is a real change in what the
   * editor does with your work, and it should be asked for rather than assumed.
   */
  autoSaveAfterSeconds: number
  /** Folders opened before, most recent first, so one can be returned to. */
  recentFolders: string[]
  /**
   * How large the interface is drawn, 1 being unscaled.
   *
   * The chrome was fixed between 8 and 13 pixels with nothing to change it, which
   * is unreadable on a dense display and unusable for anyone who needs larger text.
   * Applied as a zoom factor rather than a font size so everything scales together
   * — including the terminal, whose cell metrics the editor's font settings do not
   * touch.
   */
  uiZoom: number
  /**
   * How much room a command block takes.
   *
   * A block is flat and hairline-separated at every setting; this changes the air
   * inside it, not the vocabulary. `normal` is roughly forty-seven pixels for a
   * one-line command against the seventy-six the old cards spent, and `compact`
   * gives up the last of the padding for people who would rather see the
   * scrollback than the spacing.
   */
  blockDensity: BlockDensity
  /**
   * Whether a suggestion is offered ahead of the caret as you type.
   *
   * Off, for everybody, until it is asked for. Every way of answering costs
   * something a person should choose to spend: a paid API is billed by the
   * keystroke-pause, a subscription is drawn down the same way, and a local model
   * is a gigabyte or two of download and a GPU running while you type. A default
   * that quietly spends any of those is a default that should not be on.
   */
  ghostEnabled: boolean
  ghostProvider: GhostProvider
  /** An OpenAI-compatible base URL, for `local` and `openai`. */
  ghostBaseUrl: string
  /** The model as the endpoint names it. Empty means the endpoint's own default. */
  ghostModel: string
  /**
   * Only for `openai`. Encrypted at rest exactly as the Anthropic key is, and
   * likewise always null when read from the renderer — `local` needs none and
   * `claude` uses the credential this app already holds.
   */
  ghostApiKey: string | null
  /** How long the caret must rest before anything is asked. */
  ghostDebounceMs: number
  /**
   * Where the window was and how big, so it comes back the same shape.
   *
   * Null until a window has been closed once. Stored with the settings rather than
   * with the session because it describes the window rather than the work in it: a
   * launch that restores no session still opens somewhere, and it should be where
   * it was left rather than in the middle of whatever monitor Windows picks.
   */
  windowBounds: { x: number; y: number; width: number; height: number } | null
  windowMaximized: boolean
  /**
   * Look for a new version on launch.
   *
   * Off unless asked for. An update check is the app reaching out to a server on
   * its own and then changing itself, which is not something to start doing to
   * somebody because they installed a terminal.
   */
  autoUpdate: boolean
  /**
   * The version an update announced as downloaded and ready to install on quit.
   *
   * Written down because the install happens after every window is gone, where
   * nothing can be reported to anyone: on the next launch this is compared with
   * the version actually running, which is the only way to tell an install that
   * worked from one that silently did nothing.
   */
  pendingUpdateVersion: string | null
  /**
   * The one-time welcome card has been seen and put away — by its button, or by
   * running a first command, which says the same thing better.
   */
  firstRunDone: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
  fontSize: 13,
  defaultProfileId: null,
  themeId: 'tidewater',
  anthropicApiKey: null,
  aiModel: 'claude-opus-5',
  aiEffort: 'low',
  aiMode: 'manual',
  restoreSession: true,
  notifyAfterSeconds: 10,
  autoSaveAfterSeconds: 0,
  recentFolders: [],
  customProfiles: [],
  savedCommands: [],
  debugAdapters: [],
  languageServers: [],
  formatOnSave: false,
  keybindings: {},
  uiZoom: 1,
  blockDensity: 'normal',
  ghostEnabled: false,
  ghostProvider: 'local',
  // Ollama's OpenAI-compatible port, which is the likeliest thing already listening
  // on a machine that has anything at all. llama.cpp's server is :8080.
  ghostBaseUrl: 'http://localhost:11434/v1',
  ghostModel: '',
  ghostApiKey: null,
  ghostDebounceMs: 200,
  windowBounds: null,
  windowMaximized: false,
  autoUpdate: false,
  pendingUpdateVersion: null,
  firstRunDone: false
}

/** The API the preload script exposes on `window.ember`. */
export interface EmberApi {
  startupFiles(): Promise<string[]>
  onOpenFiles(cb: (paths: string[]) => void): () => void
  /** Folders named on the command line — what Explorer's "Open in Ember" passes. */
  startupFolders(): Promise<string[]>
  onOpenFolder(cb: (folder: string) => void): () => void
  sessionLoad(): Promise<SessionSnapshot | null>
  sessionSave(snapshot: SessionSnapshot): Promise<{ ok: boolean; error?: string }>
  /** Open another Ember window, with its own fresh session. */
  newWindow(): void
  /** Open a second Ember running as administrator, through a UAC prompt. */
  newAdminWindow(): void
  /** Whether THIS window is the elevated one. Fixed for the window's life. */
  isAdmin: boolean
  /** A message from main worth putting on the notice banner. */
  onNotice(fn: (notice: { text: string; tone: 'info' | 'error' }) => void): () => void
  /** Hand the packed session to a new window; the ptys are re-pointed by main. */
  moveTabToNewWindow(transfer: TabTransfer): Promise<{ ok: boolean; error?: string }>
  /**
   * The session parked for this window by a move, claimed once at boot.
   * Null for every window that was not created by one.
   */
  takeAdoption(): Promise<TabTransfer | null>
  /**
   * What the updater is doing, as it happens: download progress, the finish,
   * and any failure. Pushed rather than polled, because a check that answers
   * "downloading" has not yet learned whether the download works.
   */
  onUpdateStatus(fn: (status: UpdateStatus) => void): () => void
  /** Main asking for the Settings dialog — the update notification was clicked. */
  onOpenSettings(fn: () => void): () => void
  /** Settings saved by another window; this one applies them without a round trip. */
  onSettingsChanged(fn: (settings: Settings & { hasApiKey: boolean; hasGhostKey: boolean }) => void): () => void
  /** Debug adapters this machine can offer: detected ones plus those taught in settings. */
  listDebugAdapters(): Promise<DebugAdapter[]>
  /**
   * Format through the workspace's own prettier, resolved by walking up from
   * the file. `{ok:false, error:'absent'}` when the workspace has none — the
   * caller falls back to the editor's formatter rather than telling anyone.
   */
  formatWithPrettier(
    filePath: string,
    content: string
  ): Promise<{ ok: boolean; content?: string; error?: string }>
  /** Start a debug session; resolves once the adapter is up and launch is sent. */
  dapStart(req: DebugStartRequest): Promise<{ ok: boolean; sessionId?: string; error?: string }>
  /**
   * One DAP request, passed through: stackTrace, scopes, variables, continue,
   * next, stepIn, stepOut, setBreakpoints, pause, evaluate — the client stays
   * thin and the protocol stays visible.
   */
  dapRequest(
    sessionId: string,
    command: string,
    args?: unknown
  ): Promise<{ ok: boolean; body?: unknown; error?: string }>
  /** Quit and install a downloaded update now, rather than waiting for a quit. */
  installUpdateNow(): void
  /** Tear the session down, adapter process and all. */
  dapStop(sessionId: string): Promise<void>
  /**
   * Answer a reverse request the adapter made of the client — runInTerminal,
   * once the command is actually standing in a terminal pane.
   */
  dapReverseReply(sessionId: string, requestSeq: number, ok: boolean): void
  onDapEvent(fn: (payload: DapEventPayload) => void): () => void
  sessionClear(): void
  notifyCommand(notice: CommandNotice): void
  notificationsSupported(): Promise<boolean>
  explorerSupported(): Promise<boolean>
  explorerStatus(): Promise<boolean>
  explorerRegister(): Promise<{ ok: boolean; error?: string }>
  explorerUnregister(): Promise<{ ok: boolean; error?: string }>
  openFileDialog(defaultPath?: string): Promise<FileOpenResult>
  readFile(path: string): Promise<FileReadResult>
  /** Whether a path exists on disk — for keeping quiet about ones that don't. */
  pathExists(path: string): Promise<boolean>
  readDir(path: string): Promise<DirReadResult>
  directoryExists(path: string): Promise<boolean>
  createPath(target: string, kind: 'file' | 'directory'): Promise<FileWriteResult>
  renamePath(from: string, to: string): Promise<FileWriteResult>
  trashPath(target: string): Promise<FileWriteResult>
  revealPath(target: string): void
  lspStart(language: string, root?: string): Promise<{ ok: boolean; error?: string }>
  noteRecentFolder(folder: string): Promise<Settings>
  /** Whether a saved API key would really be encrypted at rest. */
  keyEncryptionAvailable(): Promise<boolean>
  /** Which credential AI requests would use right now. */
  aiCredential(): Promise<AiCredential>
  /** What the last answer's headers said was left, or null if none has come back. */
  aiUsage(): Promise<AiUsage | null>
  /** Ask for a fresh reading, by making the smallest request that carries one. */
  aiCheckUsage(): Promise<{ ok: true; usage: AiUsage } | { ok: false; error: string }>
  /** Re-probe the Claude Code CLI, after the user has signed in or out. */
  claudeAccess(): Promise<ClaudeAccess>
  /** Tell every running server the workspace moved. */
  lspSetRoot(root: string): void
  lspSend(language: string, message: unknown): void
  lspRequest(language: string, method: string, params: unknown): Promise<unknown>
  onLspMessage(cb: (e: LspEvent) => void): () => void
  onIdeCall(cb: (call: IdeCall) => void): () => void
  ideResult(id: number, result: unknown): void
  ideWorkspace(folders: string[]): void
  ideNotify(method: string, params: unknown): void
  githubOverview(cwd: string): Promise<GitHubResult>
  githubCheckout(cwd: string, number: number): Promise<GitSimpleResult>
  /** Push the current branch; publishes it to origin when it has no upstream yet. */
  gitPush(root: string, hasUpstream: boolean): Promise<GitSimpleResult>
  gitPull(root: string): Promise<GitSimpleResult>
  gitBranches(root: string): Promise<string[]>
  /** The committed text of a file, or null when there is nothing to diff against. */
  gitHeadText(filePath: string): Promise<string | null>
  gitCheckout(root: string, name: string, create: boolean): Promise<GitSimpleResult>
  /** Who last touched one line, or null where git has nothing to say about it. */
  /**
   * A suggestion for the caret. `id` names the editor asking, so a second request
   * from the same one cancels the first rather than racing it.
   */
  ghostComplete(id: number, request: GhostRequest): Promise<GhostResult>
  ghostCancel(id: number): void
  /** Ask the configured provider once, and say what happened. */
  ghostTest(): Promise<GhostTest>
  /** Rewrite a selected fragment to match an instruction. */
  rewriteSelection(
    selection: string,
    instruction: string,
    language: string
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }>
  gitBlameLine(root: string, filePath: string, line: number): Promise<GitBlameLine | null>
  /** Recent commits, for the repository or for one file. */
  gitLog(root: string, filePath: string | null, limit: number): Promise<GitLogEntry[]>
  gitStashList(root: string): Promise<GitStashEntry[]>
  gitStashPush(root: string, message: string): Promise<GitSimpleResult>
  /** Take one back — `drop` pops it, otherwise it is applied and kept. */
  gitStashApply(root: string, ref: string, drop: boolean): Promise<GitSimpleResult>
  gitStashDrop(root: string, ref: string): Promise<GitSimpleResult>
  openExternal(url: string): void
  search(query: SearchQuery): Promise<SearchResult>
  listFiles(root: string): Promise<FileListResult>
  replaceInFiles(request: ReplaceRequest): Promise<ReplaceOutcome>
  openFolderDialog(defaultPath?: string): Promise<string | null>
  snippetsFor(languageId: string): Promise<Snippet[]>
  importSnippets(): Promise<{ ok: boolean; error?: string }>
  importSnippetsFrom(file: string): Promise<{ ok: boolean; error?: string }>
  openSnippetsFolder(): void
  cancelSearch(): void
  gitStatus(cwd: string): Promise<GitStatusResult>
  gitDiff(root: string, path: string, staged: boolean): Promise<GitDiffResult>
  gitStage(root: string, paths: string[]): Promise<GitSimpleResult>
  gitUnstage(root: string, paths: string[]): Promise<GitSimpleResult>
  gitDiscard(root: string, paths: string[], untracked: string[]): Promise<GitSimpleResult>
  gitCommit(root: string, message: string): Promise<GitCommitResult>
  writeFile(path: string, content: string): Promise<FileWriteResult>
  saveFileDialog(defaultPath?: string): Promise<string | null>
  complete(req: CompletionRequest): Promise<CompletionResult>
  recordHistory(entry: HistoryRecord): void
  searchHistory(query: HistoryQuery): Promise<HistoryEntry[]>
  /** Keep a finished block, so its pane comes back holding it. */
  saveBlock(paneId: string, block: PersistedBlock): void
  /** The blocks belonging to these panes, oldest first. */
  loadBlocks(paneIds: string[]): Promise<Record<string, PersistedBlock[]>>
  /** Forget one pane's blocks — what Clear does, on disk as well as on screen. */
  clearBlocks(paneId: string): void
  /** Drop blocks belonging to panes that no longer exist. */
  keepBlocksFor(paneIds: string[]): void
  suggestHistory(prefix: string, cwd: string): Promise<string | null>
  listThemes(): Promise<ThemeSummary[]>
  /** Null when the id names a theme that has since been removed. */
  getTheme(id: string): Promise<ResolvedTheme | null>
  importThemeFrom(file: string): Promise<{ ok: boolean; id?: string; count?: number; error?: string }>
  importTheme(): Promise<{ ok: boolean; id?: string; error?: string }>
  openThemeFolder(): void
  spawn(req: SpawnRequest): Promise<{ ok: boolean; error?: string }>
  write(paneId: string, data: string): void
  /** Tell main how much pty output the terminal has parsed, for flow control. */
  ptyAck(paneId: string, parsed: number): void
  ptyFlowStats(): Promise<Record<string, { pending: number; paused: boolean; pausedCount: number }>>
  resize(paneId: string, cols: number, rows: number): void
  kill(paneId: string): void
  /**
   * The system clipboard, read through main.
   *
   * Writing works from the renderer, but reading needs a permission a sandboxed
   * renderer does not have — and pasting into a terminal is not a thing to make
   * conditional on a permission prompt.
   */
  clipboardRead(): Promise<string>
  onData(cb: (e: PtyDataEvent) => void): () => void
  onExit(cb: (e: PtyExitEvent) => void): () => void
  listProfiles(): Promise<ShellProfile[]>
  /** Ask for a new version now; resolves to a sentence describing what happened. */
  checkForUpdates(): Promise<string>
  /** Start a streaming chat; events arrive on onAiChatEvent until done. */
  aiChat(req: AiChatRequest): void
  aiChatCancel(requestId: string): void
  onAiChatEvent(cb: (e: AiChatEvent) => void): () => void
  /** `hasApiKey` says whether one is stored; the key itself never comes back. */
  getSettings(): Promise<Settings & { hasApiKey: boolean; hasGhostKey: boolean }>
  /** `persisted` is false when the value is in memory only and will not survive. */
  setSettings(
    patch: Partial<Settings>
  ): Promise<{ settings: Settings; persisted: boolean; error?: string }>
  /** Why stored settings could not be read, once, if they could not. */
  settingsLoadError(): Promise<string | null>
  /** Keep main's count current, so closing the window can ask before discarding. */
  reportUnsaved(count: number): void
  /** Scale the whole interface. Clamped in main to something usable. */
  setZoom(factor: number): void
  windowAction(action: 'minimize' | 'maximize' | 'close'): void
  onWindowState(cb: (s: { maximized: boolean }) => void): () => void
  platform: string
  homeDir: string
}
