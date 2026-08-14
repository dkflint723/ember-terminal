/** Types shared across main, preload, and renderer. */

import type { ResolvedTheme, ThemeSummary } from './theme.js'

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
  /** Recent failed command + output, when the user asks to explain an error. */
  recent?: { command: string; output: string; exitCode: number }[]
  mode: 'command' | 'explain'
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
  activeTabId: string | null
  tabs: { id: string; root: SessionLayout; activePaneId: string }[]
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
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
  fontSize: 13,
  defaultProfileId: null,
  themeId: 'ember-dark',
  anthropicApiKey: null,
  aiModel: 'claude-opus-5',
  restoreSession: true,
  notifyAfterSeconds: 10,
  autoSaveAfterSeconds: 0,
  recentFolders: []
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
  onData(cb: (e: PtyDataEvent) => void): () => void
  onExit(cb: (e: PtyExitEvent) => void): () => void
  listProfiles(): Promise<ShellProfile[]>
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
  windowAction(action: 'minimize' | 'maximize' | 'close'): void
  onWindowState(cb: (s: { maximized: boolean }) => void): () => void
  platform: string
  homeDir: string
}
