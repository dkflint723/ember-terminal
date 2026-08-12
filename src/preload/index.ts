import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import type {
  AiRequest,
  CompletionRequest,
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
  complete: (req: CompletionRequest) => ipcRenderer.invoke('completion:request', req),
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
