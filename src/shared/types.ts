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

export interface Settings {
  fontFamily: string
  fontSize: number
  defaultProfileId: string | null
  /** Id of a theme in the VS Code color-theme format; see shared/theme.ts. */
  themeId: string
  /** Stored encrypted at rest via Electron safeStorage when available. */
  anthropicApiKey: string | null
  aiModel: string
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
  fontSize: 13,
  defaultProfileId: null,
  themeId: 'ember-dark',
  anthropicApiKey: null,
  aiModel: 'claude-opus-5'
}

/** The API the preload script exposes on `window.ember`. */
export interface EmberApi {
  startupFiles(): Promise<string[]>
  onOpenFiles(cb: (paths: string[]) => void): () => void
  openFileDialog(defaultPath?: string): Promise<FileOpenResult>
  readFile(path: string): Promise<FileReadResult>
  readDir(path: string): Promise<DirReadResult>
  writeFile(path: string, content: string): Promise<FileWriteResult>
  saveFileDialog(defaultPath?: string): Promise<string | null>
  complete(req: CompletionRequest): Promise<CompletionResult>
  recordHistory(entry: HistoryRecord): void
  searchHistory(query: HistoryQuery): Promise<HistoryEntry[]>
  suggestHistory(prefix: string, cwd: string): Promise<string | null>
  listThemes(): Promise<ThemeSummary[]>
  /** Null when the id names a theme that has since been removed. */
  getTheme(id: string): Promise<ResolvedTheme | null>
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
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  windowAction(action: 'minimize' | 'maximize' | 'close'): void
  onWindowState(cb: (s: { maximized: boolean }) => void): () => void
  platform: string
  homeDir: string
}
