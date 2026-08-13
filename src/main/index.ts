import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import { PtyManager } from './pty.js'
import { detectProfiles } from './profiles.js'
import { SettingsStore } from './settings.js'
import { ThemeStore } from './themes.js'
import { CompletionService } from './completion.js'
import { HistoryStore } from './history.js'
import { FileService, fileArgs, pathArgs } from './files.js'
import { LspService } from './lsp.js'
import { GitService } from './git.js'
import { IdeServer } from './ide.js'
import { GitHubService } from './github.js'
import { ExplorerMenu } from './explorer.js'
import { SessionStore } from './session.js'
import { applyReplacement, SearchService } from './search.js'
import { SnippetStore } from './snippets.js'
import { Notifier, focusWindow } from './notify.js'
import { AiService } from './ai.js'
import {
  DEFAULT_SETTINGS,
  type AiRequest,
  type CompletionRequest,
  type HistoryQuery,
  type HistoryRecord,
  type ReplaceRequest,
  type Settings,
  type SpawnRequest
} from '../shared/types.js'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore
let themes: ThemeStore
let completion: CompletionService
let history: HistoryStore
let files: FileService
let lsp: LspService
let git: GitService
let ide: IdeServer
let github: GitHubService
const explorer = new ExplorerMenu()
let session: SessionStore
const search = new SearchService()
const snippets = new SnippetStore()
let notifier: Notifier

/**
 * Tool calls arrive on a socket owned by main, but every one of them is a question
 * about editors, which only the renderer knows. Each is forwarded with an id and
 * parked until the answer comes back on `ide:result`.
 *
 * `openDiff` is why these are promises rather than a synchronous read: it is
 * answered when the user accepts or rejects the change, which may be minutes, and
 * the CLI is waiting on that answer to decide what to do next. Hence no timeout —
 * a call is settled by the user, or by the window going away.
 */
let nextIdeCall = 0
const pendingIdeCalls = new Map<number, (result: unknown) => void>()

function callRenderer(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!mainWindow) return Promise.resolve({ success: false, message: 'No window is open.' })
  const id = ++nextIdeCall
  return new Promise((resolve) => {
    pendingIdeCalls.set(id, resolve)
    sendToRenderer('ide:call', { id, name, args })
  })
}
/** Drained once by the renderer at boot; refilled when a second instance starts. */
let startupFiles: string[] = []
let startupFolders: string[] = []
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
    // Set explicitly rather than left to the packager: without it the window and
    // taskbar show Electron's own icon in development, and the Explorer context
    // menu entry — which reads its icon from this executable — would too.
    icon: join(
      app.isPackaged ? process.resourcesPath : app.getAppPath(),
      'resources',
      'icon.png'
    ),
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

  ipcMain.handle('file:startupFiles', () => {
    const pending = startupFiles
    startupFiles = []
    return pending
  })

  ipcMain.handle('file:startupFolders', () => {
    const pending = startupFolders
    startupFolders = []
    return pending
  })

  ipcMain.handle('explorer:status', () =>
    explorer.supported ? explorer.isRegistered() : Promise.resolve(false)
  )
  ipcMain.handle('session:load', () => session.load())
  ipcMain.handle('session:save', (_e, snapshot) => session.save(snapshot))
  ipcMain.on('session:clear', () => session.clear())
  ipcMain.on('notify:command', (_e, notice) => {
    /*
     * Suppressed only when the user can actually see the window.
     *
     * Focus alone does not mean that. A minimized window here reports
     * `isFocused()` true while `isVisible()` is false, so testing focus by itself
     * threw away every notification sent while the window was minimized — which is
     * the case the whole feature exists for. It is the same trap as
     * `document.hasFocus()` in the renderer, one layer down: asking who has the
     * keyboard rather than what is on screen.
     */
    const watching =
      mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isFocused() &&
      mainWindow.isVisible() &&
      !mainWindow.isMinimized()
    if (watching) return
    notifier.show(notice)
  })
  ipcMain.handle('notify:supported', () => notifier.supported)

  ipcMain.handle('explorer:supported', () => explorer.supported)
  ipcMain.handle('explorer:register', () => explorer.register())
  ipcMain.handle('explorer:unregister', () => explorer.unregister())

  ipcMain.handle('file:openDialog', (_e, defaultPath?: string) =>
    mainWindow ? files.openDialog(mainWindow, defaultPath) : { ok: false, error: 'No window.' }
  )
  ipcMain.handle('file:openFolderDialog', (_e, defaultPath?: string) =>
    mainWindow ? files.openFolderDialog(mainWindow, defaultPath) : null
  )
  ipcMain.handle('file:read', (_e, filePath: string) => files.read(filePath))
  ipcMain.handle('file:readDir', (_e, dirPath: string) => files.readDir(dirPath))
  ipcMain.handle('file:dirExists', (_e, dirPath: string) => files.directoryExists(dirPath))
  ipcMain.handle('file:create', (_e, target: string, kind: 'file' | 'directory') =>
    files.create(target, kind)
  )
  ipcMain.handle('file:rename', (_e, from: string, to: string) => files.rename(from, to))
  ipcMain.handle('file:trash', (_e, target: string) => files.trash(target))
  ipcMain.on('file:reveal', (_e, target: string) => files.reveal(target))

  ipcMain.handle('lsp:start', (_e, language: string, root?: string) => lsp.start(language, root))
  ipcMain.on('lsp:setRoot', (_e, root: string) => lsp.setRoot(root))
  ipcMain.on('lsp:send', (_e, language: string, message: unknown) => lsp.post(language, message))
  ipcMain.handle('lsp:request', (_e, language: string, method: string, params: unknown) =>
    lsp.request(language, method, params)
  )

  ipcMain.on('ide:result', (_e, id: number, result: unknown) => {
    const resolve = pendingIdeCalls.get(id)
    if (!resolve) return
    pendingIdeCalls.delete(id)
    resolve(result)
  })
  ipcMain.on('ide:workspace', (_e, folders: string[]) => ide.setWorkspaceFolders(folders))
  ipcMain.on('ide:notify', (_e, method: string, params: unknown) => ide.notify(method, params))

  ipcMain.handle('github:overview', (_e, cwd: string) => github.overview(cwd))
  ipcMain.handle('github:checkout', (_e, cwd: string, number: number) =>
    github.checkout(cwd, number)
  )
  ipcMain.on('shell:openExternal', (_e, url: string) => {
    // Only ever a link the user clicked in a list this app fetched, and only over
    // http(s): openExternal will hand anything else to whatever the OS has
    // registered for the scheme.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  ipcMain.handle('search:run', (_e, query) => search.run(query))
  ipcMain.on('search:cancel', () => search.cancel())
  ipcMain.handle('search:files', (_e, root: string) => search.files(root))
  ipcMain.handle('search:replace', (_e, request: ReplaceRequest) => applyReplacement(request))

  ipcMain.handle('git:status', (_e, cwd: string) => git.status(cwd))
  ipcMain.handle('git:diff', (_e, root: string, path: string, staged: boolean) =>
    git.diff(root, path, staged)
  )
  ipcMain.handle('git:stage', (_e, root: string, paths: string[]) => git.stage(root, paths))
  ipcMain.handle('git:unstage', (_e, root: string, paths: string[]) => git.unstage(root, paths))
  ipcMain.handle('git:discard', (_e, root: string, paths: string[], untracked: string[]) =>
    git.discard(root, paths, untracked)
  )
  ipcMain.handle('git:commit', (_e, root: string, message: string) => git.commit(root, message))
  ipcMain.handle('file:write', (_e, filePath: string, content: string) =>
    files.write(filePath, content)
  )
  ipcMain.handle('file:saveDialog', (_e, defaultPath?: string) =>
    mainWindow ? files.saveDialog(mainWindow, defaultPath) : null
  )

  completion = new CompletionService(profiles)
  ipcMain.handle('completion:request', (_e, req: CompletionRequest) => completion.complete(req))

  ipcMain.on('history:record', (_e, entry: HistoryRecord) => history.record(entry))
  ipcMain.handle('history:search', (_e, query: HistoryQuery) => history.search(query))
  ipcMain.handle('history:suggest', (_e, prefix: string, cwd: string) =>
    history.suggest(prefix, cwd)
  )

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
      title: 'Import a VS Code theme or .vsix extension',
      filters: [{ name: 'VS Code theme or extension', extensions: ['json', 'vsix'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false }
    const chosen = picked.filePaths[0]
    // A .vsix may carry several themes, so it reports how many it installed.
    if (chosen.toLowerCase().endsWith('.vsix')) {
      const res = themes.installVsix(chosen)
      return res.ok ? { ok: true, id: res.ids?.[0], count: res.ids?.length } : res
    }
    return themes.install(chosen)
  })

  // Takes a path directly, rather than opening a picker. The dialog handler above
  // is a thin wrapper over this, and having it separately reachable is what makes
  // importing scriptable and testable.
  ipcMain.handle('themes:importFrom', (_e, file: string) => {
    if (file.toLowerCase().endsWith('.vsix')) {
      const res = themes.installVsix(file)
      return res.ok ? { ok: true, id: res.ids?.[0], count: res.ids?.length } : res
    }
    return themes.install(file)
  })

  ipcMain.on('themes:openFolder', () => void shell.openPath(themes.userDir()))

  ipcMain.handle('snippets:for', (_e, languageId: string) => snippets.forLanguage(languageId))
  ipcMain.handle('snippets:import', async () => {
    if (!mainWindow) return { ok: false, error: 'No window.' }
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Import snippets or a .vsix extension',
      filters: [{ name: 'Snippets or extension', extensions: ['json', 'code-snippets', 'vsix'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false }
    const chosen = picked.filePaths[0]
    return chosen.toLowerCase().endsWith('.vsix')
      ? snippets.installVsix(chosen)
      : snippets.install(chosen)
  })
  // Reachable with a path so importing is scriptable, the same as themes.
  ipcMain.handle('snippets:importFrom', (_e, file: string) =>
    file.toLowerCase().endsWith('.vsix') ? snippets.installVsix(file) : snippets.install(file)
  )
  ipcMain.on('snippets:openFolder', () => void shell.openPath(snippets.dir()))

  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => settings.set(patch))
  ipcMain.handle('settings:noteFolder', (_e, folder: string) => settings.noteRecentFolder(folder))

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
  app.on('second-instance', (_e, argv) => {
    // Opening a file while Ember is already running should surface it here rather
    // than starting a competing instance.
    const opened = fileArgs(argv, app.getAppPath())
    if (opened.length > 0) sendToRenderer('file:open', opened)
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  // The window draws its own chrome, and the default menu would bind accelerators
  // the app uses itself — Ctrl+R for history search would reload instead.
  Menu.setApplicationMenu(null)

  void app.whenReady().then(() => {
    settings = new SettingsStore()
    themes = new ThemeStore()
    history = new HistoryStore()
    files = new FileService()
    lsp = new LspService((payload) => sendToRenderer('lsp:message', payload))
    git = new GitService()
    github = new GitHubService()
    session = new SessionStore()
    notifier = new Notifier(() => focusWindow(mainWindow))
    const startup = pathArgs(process.argv, app.getAppPath())
    startupFiles = startup.files
    startupFolders = startup.folders
    ai = new AiService(settings)
    ide = new IdeServer((name, args) => callRenderer(name, args))
    ide.start([])
    ptys = new PtyManager(
      (paneId, data) => sendToRenderer('pty:data', { paneId, data }),
      (paneId, exitCode) => sendToRenderer('pty:exit', { paneId, exitCode }),
      () => ide.env()
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
    history?.close()
    lsp?.dispose()
    // Before the process goes, so no lockfile is left naming a dead port for the
    // next CLI that goes looking for an IDE.
    ide?.stop()
  })
}
