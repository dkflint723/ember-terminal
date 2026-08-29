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
  sidebarView: 'explorer' | 'search' | 'scm' | 'github' | 'problems'
  /** Terminal mode's session list. Optional so sessions from older builds load. */
  sessionsOpen?: boolean
  activeTabId: string | null
  /**
   * `root` is the shells, and keeps its name so that a session written by an
   * earlier build still restores. `editors` is the middle of the IDE, and is
   * absent both in those older files and in any tab where nothing has been opened.
   */
  tabs: {
    id: string
    /** The user's own name for the session, when they gave it one. */
    name?: string
    root: SessionLayout
    editors?: SessionLayout
    activePaneId: string
  }[]
  panes: SessionPane[]
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

export interface LspEvent {
  type: 'message' | 'exit'
  language: string
  message?: unknown
  code?: number | null
  /** Set when the server failed to start at all, rather than exiting later. */
  error?: string
}

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
  uiZoom: 1,
  windowBounds: null,
  windowMaximized: false,
  autoUpdate: false
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
  gitCheckout(root: string, name: string, create: boolean): Promise<GitSimpleResult>
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
  ai(req: AiRequest): Promise<AiResponse>
  /** `hasApiKey` says whether one is stored; the key itself never comes back. */
  getSettings(): Promise<Settings & { hasApiKey: boolean }>
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
