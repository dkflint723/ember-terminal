import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import type {
  AiRequest,
  CompletionRequest,
  HistoryQuery,
  LspEvent,
  HistoryRecord,
  AiResponse,
  EmberApi,
  PtyDataEvent,
  PtyExitEvent,
  Settings,
  ShellProfile,
  SpawnRequest
} from '../shared/types.js'

/**
 * The renderer never touches Node or Electron internals directly; everything
 * crosses this bridge as plain data.
 */
const api: EmberApi = {
  startupFiles: () => ipcRenderer.invoke('file:startupFiles'),
  onOpenFiles: (cb: (paths: string[]) => void) => {
    const listener = (_: unknown, paths: string[]): void => cb(paths)
    ipcRenderer.on('file:open', listener)
    return () => ipcRenderer.removeListener('file:open', listener)
  },
  openFileDialog: (defaultPath?: string) => ipcRenderer.invoke('file:openDialog', defaultPath),
  readFile: (path: string) => ipcRenderer.invoke('file:read', path),
  readDir: (path: string) => ipcRenderer.invoke('file:readDir', path),
  lspStart: (language: string, root?: string) => ipcRenderer.invoke('lsp:start', language, root),
  lspSend: (language: string, message: unknown) => ipcRenderer.send('lsp:send', language, message),
  onLspMessage: (cb: (e: LspEvent) => void) => {
    const listener = (_: unknown, e: LspEvent): void => cb(e)
    ipcRenderer.on('lsp:message', listener)
    return () => ipcRenderer.removeListener('lsp:message', listener)
  },
  gitStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
  gitDiff: (root: string, path: string, staged: boolean) =>
    ipcRenderer.invoke('git:diff', root, path, staged),
  gitStage: (root: string, paths: string[]) => ipcRenderer.invoke('git:stage', root, paths),
  gitUnstage: (root: string, paths: string[]) => ipcRenderer.invoke('git:unstage', root, paths),
  gitDiscard: (root: string, paths: string[], untracked: string[]) =>
    ipcRenderer.invoke('git:discard', root, paths, untracked),
  gitCommit: (root: string, message: string) => ipcRenderer.invoke('git:commit', root, message),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('file:write', path, content),
  saveFileDialog: (defaultPath?: string) => ipcRenderer.invoke('file:saveDialog', defaultPath),
  complete: (req: CompletionRequest) => ipcRenderer.invoke('completion:request', req),
  recordHistory: (entry: HistoryRecord) => ipcRenderer.send('history:record', entry),
  searchHistory: (query: HistoryQuery) => ipcRenderer.invoke('history:search', query),
  suggestHistory: (prefix: string, cwd: string) =>
    ipcRenderer.invoke('history:suggest', prefix, cwd),
  listThemes: () => ipcRenderer.invoke('themes:list'),
  getTheme: (id: string) => ipcRenderer.invoke('themes:get', id),
  importTheme: () => ipcRenderer.invoke('themes:import'),
  openThemeFolder: () => ipcRenderer.send('themes:openFolder'),

  spawn: (req: SpawnRequest) => ipcRenderer.invoke('pty:spawn', req),
  write: (paneId: string, data: string) => ipcRenderer.send('pty:write', paneId, data),
  resize: (paneId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', paneId, cols, rows),
  kill: (paneId: string) => ipcRenderer.send('pty:kill', paneId),

  onData: (cb: (e: PtyDataEvent) => void) => {
    const listener = (_: unknown, e: PtyDataEvent): void => cb(e)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },

  onExit: (cb: (e: PtyExitEvent) => void) => {
    const listener = (_: unknown, e: PtyExitEvent): void => cb(e)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  },

  listProfiles: (): Promise<ShellProfile[]> => ipcRenderer.invoke('profiles:list'),
  ai: (req: AiRequest): Promise<AiResponse> => ipcRenderer.invoke('ai:run', req),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', patch),

  windowAction: (action: 'minimize' | 'maximize' | 'close') =>
    ipcRenderer.send('window:action', action),

  onWindowState: (cb: (s: { maximized: boolean }) => void) => {
    const listener = (_: unknown, s: { maximized: boolean }): void => cb(s)
    ipcRenderer.on('window:state', listener)
    return () => ipcRenderer.removeListener('window:state', listener)
  },

  platform: process.platform,
  homeDir: homedir()
}

contextBridge.exposeInMainWorld('ember', api)
