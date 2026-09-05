import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiChatEvent,
  AiChatRequest,
  CommandNotice,
  CompletionRequest,
  DapEventPayload,
  GhostRequest,
  DebugStartRequest,
  HistoryQuery,
  IdeCall,
  LspEvent,
  AiCredential,
  AiUsage,
  ClaudeAccess,
  ReplaceRequest,
  SearchQuery,
  SessionSnapshot,
  TabTransfer,
  UpdateStatus,
  HistoryRecord,
  PersistedBlock,
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
  startupFolders: () => ipcRenderer.invoke('file:startupFolders'),
  onOpenFolder: (cb: (folder: string) => void) => {
    const listener = (_: unknown, folder: string): void => cb(folder)
    ipcRenderer.on('file:openFolder', listener)
    return () => ipcRenderer.removeListener('file:openFolder', listener)
  },
  sessionLoad: () => ipcRenderer.invoke('session:load'),
  sessionSave: (snapshot: SessionSnapshot) => ipcRenderer.invoke('session:save', snapshot),
  sessionClear: () => ipcRenderer.send('session:clear'),
  newWindow: () => ipcRenderer.send('window:new'),
  listDebugAdapters: () => ipcRenderer.invoke('dap:adapters'),
  formatWithPrettier: (filePath: string, content: string) =>
    ipcRenderer.invoke('format:prettier', filePath, content),
  dapStart: (req: DebugStartRequest) => ipcRenderer.invoke('dap:start', req),
  dapRequest: (sessionId: string, command: string, args?: unknown) =>
    ipcRenderer.invoke('dap:request', sessionId, command, args),
  dapStop: (sessionId: string) => ipcRenderer.invoke('dap:stop', sessionId),
  dapReverseReply: (sessionId: string, requestSeq: number, ok: boolean) =>
    ipcRenderer.send('dap:reverseReply', sessionId, requestSeq, ok),
  onDapEvent: (cb: (payload: DapEventPayload) => void) => {
    const listener = (_: unknown, payload: DapEventPayload): void => cb(payload)
    ipcRenderer.on('dap:event', listener)
    return () => ipcRenderer.removeListener('dap:event', listener)
  },
  moveTabToNewWindow: (transfer: TabTransfer) => ipcRenderer.invoke('window:moveTab', transfer),
  takeAdoption: () => ipcRenderer.invoke('window:adoption'),
  installUpdateNow: () => ipcRenderer.send('updates:installNow'),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => {
    const listener = (_: unknown, status: UpdateStatus): void => cb(status)
    ipcRenderer.on('updates:status', listener)
    return () => ipcRenderer.removeListener('updates:status', listener)
  },
  newAdminWindow: () => ipcRenderer.send('window:newAdmin'),
  isAdmin: ipcRenderer.sendSync('app:isAdmin') as boolean,
  onNotice: (cb: (notice: { text: string; tone: 'info' | 'error' }) => void) => {
    const listener = (_: unknown, n: { text: string; tone: 'info' | 'error' }): void => cb(n)
    ipcRenderer.on('ui:notice', listener)
    return () => ipcRenderer.removeListener('ui:notice', listener)
  },
  onOpenSettings: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('ui:openSettings', listener)
    return () => ipcRenderer.removeListener('ui:openSettings', listener)
  },
  onSettingsChanged: (cb: (settings: Settings & { hasApiKey: boolean; hasGhostKey: boolean }) => void) => {
    const listener = (_: unknown, s: Settings & { hasApiKey: boolean; hasGhostKey: boolean }): void =>
      cb(s)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },
  notifyCommand: (notice: CommandNotice) => ipcRenderer.send('notify:command', notice),
  notificationsSupported: () => ipcRenderer.invoke('notify:supported'),
  explorerSupported: () => ipcRenderer.invoke('explorer:supported'),
  explorerStatus: () => ipcRenderer.invoke('explorer:status'),
  explorerRegister: () => ipcRenderer.invoke('explorer:register'),
  explorerUnregister: () => ipcRenderer.invoke('explorer:unregister'),
  openFileDialog: (defaultPath?: string) => ipcRenderer.invoke('file:openDialog', defaultPath),
  openFolderDialog: (defaultPath?: string) =>
    ipcRenderer.invoke('file:openFolderDialog', defaultPath),
  ptyAck: (paneId: string, parsed: number) => ipcRenderer.send('pty:ack', paneId, parsed),
  ptyFlowStats: () => ipcRenderer.invoke('pty:flowStats'),
  readFile: (path: string) => ipcRenderer.invoke('file:read', path),
  pathExists: (path: string): Promise<boolean> => ipcRenderer.invoke('file:exists', path),
  readDir: (path: string) => ipcRenderer.invoke('file:readDir', path),
  directoryExists: (path: string) => ipcRenderer.invoke('file:dirExists', path),
  createPath: (target: string, kind: 'file' | 'directory') =>
    ipcRenderer.invoke('file:create', target, kind),
  renamePath: (from: string, to: string) => ipcRenderer.invoke('file:rename', from, to),
  trashPath: (target: string) => ipcRenderer.invoke('file:trash', target),
  revealPath: (target: string) => ipcRenderer.send('file:reveal', target),
  lspStart: (language: string, root?: string) => ipcRenderer.invoke('lsp:start', language, root),
  lspSetRoot: (root: string) => ipcRenderer.send('lsp:setRoot', root),
  lspSend: (language: string, message: unknown) => ipcRenderer.send('lsp:send', language, message),
  lspRequest: (language: string, method: string, params: unknown) =>
    ipcRenderer.invoke('lsp:request', language, method, params),
  onLspMessage: (cb: (e: LspEvent) => void) => {
    const listener = (_: unknown, e: LspEvent): void => cb(e)
    ipcRenderer.on('lsp:message', listener)
    return () => ipcRenderer.removeListener('lsp:message', listener)
  },
  onIdeCall: (cb: (call: IdeCall) => void) => {
    const listener = (_: unknown, call: IdeCall): void => cb(call)
    ipcRenderer.on('ide:call', listener)
    return () => ipcRenderer.removeListener('ide:call', listener)
  },
  ideResult: (id: number, result: unknown) => ipcRenderer.send('ide:result', id, result),
  ideWorkspace: (folders: string[]) => ipcRenderer.send('ide:workspace', folders),
  ideNotify: (method: string, params: unknown) => ipcRenderer.send('ide:notify', method, params),

  githubOverview: (cwd: string) => ipcRenderer.invoke('github:overview', cwd),
  githubCheckout: (cwd: string, number: number) =>
    ipcRenderer.invoke('github:checkout', cwd, number),
  openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),

  search: (query: SearchQuery) => ipcRenderer.invoke('search:run', query),
  cancelSearch: () => ipcRenderer.send('search:cancel'),
  listFiles: (root: string) => ipcRenderer.invoke('search:files', root),
  replaceInFiles: (request: ReplaceRequest) => ipcRenderer.invoke('search:replace', request),

  gitStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
  gitPush: (root: string, hasUpstream: boolean) => ipcRenderer.invoke('git:push', root, hasUpstream),
  gitPull: (root: string) => ipcRenderer.invoke('git:pull', root),
  gitBranches: (root: string) => ipcRenderer.invoke('git:branches', root),
  gitHeadText: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('git:headText', filePath),
  ghostComplete: (id: number, request: GhostRequest) =>
    ipcRenderer.invoke('ghost:complete', id, request),
  ghostCancel: (id: number) => ipcRenderer.send('ghost:cancel', id),
  ghostModels: (baseUrl?: string): Promise<string[]> =>
    ipcRenderer.invoke('ghost:models', baseUrl),
  ghostTest: () => ipcRenderer.invoke('ghost:test'),
  rewriteSelection: (selection: string, instruction: string, language: string) =>
    ipcRenderer.invoke('edit:rewrite', selection, instruction, language),
  gitBlameLine: (root: string, filePath: string, line: number) =>
    ipcRenderer.invoke('git:blameLine', root, filePath, line),
  gitLog: (root: string, filePath: string | null, limit: number) =>
    ipcRenderer.invoke('git:log', root, filePath, limit),
  gitStashList: (root: string) => ipcRenderer.invoke('git:stashList', root),
  gitStashPush: (root: string, message: string) =>
    ipcRenderer.invoke('git:stashPush', root, message),
  gitStashApply: (root: string, ref: string, drop: boolean, expect?: string) =>
    ipcRenderer.invoke('git:stashApply', root, ref, drop, expect),
  gitStashDrop: (root: string, ref: string, expect?: string) =>
    ipcRenderer.invoke('git:stashDrop', root, ref, expect),
  gitCheckout: (root: string, name: string, create: boolean) =>
    ipcRenderer.invoke('git:checkout', root, name, create),
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
  saveBlock: (paneId: string, block: PersistedBlock) =>
    ipcRenderer.send('blocks:save', paneId, block),
  loadBlocks: (paneIds: string[]) => ipcRenderer.invoke('blocks:load', paneIds),
  clearBlocks: (paneId: string) => ipcRenderer.send('blocks:clear', paneId),
  keepBlocksFor: (paneIds: string[]) => ipcRenderer.send('blocks:keep', paneIds),
  suggestHistory: (prefix: string, cwd: string) =>
    ipcRenderer.invoke('history:suggest', prefix, cwd),
  listThemes: () => ipcRenderer.invoke('themes:list'),
  getTheme: (id: string) => ipcRenderer.invoke('themes:get', id),
  importTheme: () => ipcRenderer.invoke('themes:import'),
  importThemeFrom: (file: string) => ipcRenderer.invoke('themes:importFrom', file),
  openThemeFolder: () => ipcRenderer.send('themes:openFolder'),
  snippetsFor: (languageId: string) => ipcRenderer.invoke('snippets:for', languageId),
  importSnippets: () => ipcRenderer.invoke('snippets:import'),
  importSnippetsFrom: (file: string) => ipcRenderer.invoke('snippets:importFrom', file),
  openSnippetsFolder: () => ipcRenderer.send('snippets:openFolder'),

  spawn: (req: SpawnRequest) => ipcRenderer.invoke('pty:spawn', req),
  write: (paneId: string, data: string) => ipcRenderer.send('pty:write', paneId, data),
  resize: (paneId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', paneId, cols, rows),
  kill: (paneId: string) => ipcRenderer.send('pty:kill', paneId),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),

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
  checkForUpdates: (): Promise<string> => ipcRenderer.invoke('updates:check'),
  aiChat: (req: AiChatRequest): void => ipcRenderer.send('ai:chat', req),
  aiChatCancel: (requestId: string): void => ipcRenderer.send('ai:chat-cancel', requestId),
  onAiChatEvent: (cb: (e: AiChatEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: AiChatEvent): void => cb(event)
    ipcRenderer.on('ai:chat-event', listener)
    return () => ipcRenderer.removeListener('ai:chat-event', listener)
  },
  aiCredential: (): Promise<AiCredential> => ipcRenderer.invoke('ai:credential'),
  aiUsage: (): Promise<AiUsage | null> => ipcRenderer.invoke('ai:usage'),
  aiCheckUsage: (): Promise<{ ok: true; usage: AiUsage } | { ok: false; error: string }> =>
    ipcRenderer.invoke('ai:check-usage'),
  claudeAccess: (): Promise<ClaudeAccess> => ipcRenderer.invoke('ai:claudeAccess'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  keyEncryptionAvailable: (): Promise<boolean> => ipcRenderer.invoke('settings:encryption'),
  noteRecentFolder: (folder: string): Promise<Settings> =>
    ipcRenderer.invoke('settings:noteFolder', folder),
  noteLearnedChord: (chord: string): Promise<Settings> =>
    ipcRenderer.invoke('settings:noteChord', chord),
  settingsLoadError: (): Promise<string | null> => ipcRenderer.invoke('settings:loadError'),
  reportUnsaved: (count: number) => ipcRenderer.send('window:unsaved', count),
  setZoom: (factor: number) => ipcRenderer.send('window:zoom', factor),
  setSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke('settings:set', patch),

  windowAction: (action: 'minimize' | 'maximize' | 'close') =>
    ipcRenderer.send('window:action', action),

  onWindowState: (cb: (s: { maximized: boolean }) => void) => {
    const listener = (_: unknown, s: { maximized: boolean }): void => cb(s)
    ipcRenderer.on('window:state', listener)
    return () => ipcRenderer.removeListener('window:state', listener)
  },

  platform: process.platform,
  // Read at preload time so callers still see a plain string. Node is not
  // available in a sandboxed preload, which is the point.
  homeDir: ipcRenderer.sendSync('app:homeDir') as string
}

contextBridge.exposeInMainWorld('ember', api)
