import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { PtyManager } from './pty.js'
import { detectProfiles } from './profiles.js'
import { SettingsStore } from './settings.js'
import { ThemeStore } from './themes.js'
import { CompletionService } from './completion.js'
import { AiService } from './ai.js'
import {
  DEFAULT_SETTINGS,
  type AiRequest,
  type CompletionRequest,
  type Settings,
  type SpawnRequest
} from '../shared/types.js'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore
let themes: ThemeStore
let completion: CompletionService
let ai: AiService
let ptys: PtyManager

/**
 * Ptys can exit while the window is being torn down, so every send has to check
 * the target still exists — otherwise shutdown throws on a disposed frame.
 */
function sendToRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 520,
    minHeight: 360,
    show: false,
    backgroundColor: '#0c0c0c',
    // Frameless so the tab strip can live in the title bar, the way Windows
    // Terminal does. The renderer draws its own caption buttons.
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  const emitState = (): void =>
    sendToRenderer('window:state', { maximized: mainWindow?.isMaximized() ?? false })
  mainWindow.on('maximize', emitState)
  mainWindow.on('unmaximize', emitState)

  mainWindow.on('closed', () => {
    ptys.killAll()
    mainWindow = null
  })

  // Links from terminal output open in the real browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  const profiles = detectProfiles()

  ipcMain.handle('profiles:list', () => profiles)

  ipcMain.handle('pty:spawn', (_e, req: SpawnRequest) => {
    const profile = profiles.find((p) => p.id === req.profileId) ?? profiles[0]
    if (!profile) return { ok: false, error: 'No shell found on this machine.' }
    try {
      ptys.spawn(req, profile)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to start shell.' }
    }
  })

  ipcMain.on('pty:write', (_e, paneId: string, data: string) => ptys.write(paneId, data))
  ipcMain.on('pty:resize', (_e, paneId: string, cols: number, rows: number) =>
    ptys.resize(paneId, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, paneId: string) => ptys.kill(paneId))

  ipcMain.handle('ai:run', (_e, req: AiRequest) => ai.run(req))

  completion = new CompletionService(profiles)
  ipcMain.handle('completion:request', (_e, req: CompletionRequest) => completion.complete(req))

  ipcMain.handle('themes:list', () => themes.list())

  ipcMain.handle('themes:get', (_e, id: string) => {
    // Fall back to the default rather than leaving the UI unthemed if the saved
    // theme has been deleted from disk.
    themes.refresh()
    return themes.load(id) ?? themes.load(DEFAULT_SETTINGS.themeId)
  })

  ipcMain.handle('themes:import', async () => {
    if (!mainWindow) return { ok: false, error: 'No window.' }
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Import a VS Code theme',
      filters: [{ name: 'VS Code theme', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false }
    return themes.install(picked.filePaths[0])
  })

  ipcMain.on('themes:openFolder', () => void shell.openPath(themes.userDir()))

  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => settings.set(patch))

  ipcMain.on('window:action', (_e, action: 'minimize' | 'maximize' | 'close') => {
    if (!mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    else if (action === 'close') mainWindow.close()
    else if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
}

// A second instance should focus the existing window rather than opening a
// duplicate that competes for the same shells.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    settings = new SettingsStore()
    themes = new ThemeStore()
    ai = new AiService(settings)
    ptys = new PtyManager(
      (paneId, data) => sendToRenderer('pty:data', { paneId, data }),
      (paneId, exitCode) => sendToRenderer('pty:exit', { paneId, exitCode })
    )

    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    ptys?.killAll()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    ptys?.killAll()
    completion?.dispose()
  })
}
