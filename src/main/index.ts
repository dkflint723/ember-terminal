import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell } from 'electron'
import { join } from 'node:path'
import { appendFileSync, existsSync } from 'node:fs'

/*
 * Who this app is, declared before any window exists.
 *
 * The Windows shell identifies a window by its AppUserModelID at the moment the
 * window is created. This used to be set when the notifier was constructed —
 * long after the window was up — so the taskbar had already filed the window
 * under Electron's own identity and kept Electron's icon for it, and the Start
 * Menu shortcut (which the installer stamps with this same id) never matched
 * the running app. The packaged id matches electron-builder's appId and the
 * Start Menu shortcut. Development gets an id of its own, deliberately: a dev
 * run is electron.exe, and every dev or test launch that claimed the installed
 * app's id taught the shell's icon cache that this application looks like
 * Electron — which the installed app then inherited.
 */
if (process.platform === 'win32') {
  /*
   * ".app", not the bare appId: years of dev runs bound the bare id to
   * electron.exe in shell caches that survive icon-cache resets and reinstalls.
   * A fresh id has no history, so the shell resolves it from the shortcut and
   * the executable — which carry the right icon — instead of from a memory.
   */
  app.setAppUserModelId(app.isPackaged ? 'dev.dkflint.ember.app' : 'dev.dkflint.ember.dev')
}
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
import { ClaudeCliService } from './claude-cli.js'
import {
  DEFAULT_SETTINGS,
  type ShellProfile,
  type AiChatRequest,
  type CompletionRequest,
  type HistoryQuery,
  type HistoryRecord,
  type PersistedBlock,
  type ReplaceRequest,
  type Settings,
  type SpawnRequest
} from '../shared/types.js'

/**
 * Where a fault goes when there is no console: a packaged build's stderr lands
 * nowhere, so every report is also appended to ember.log in userData — the file
 * to ask for when something went wrong on a machine that is not this one.
 */
function reportFault(label: string, detail: unknown): void {
  console.error(`Ember: ${label}`, detail)
  try {
    const line = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail)
    appendFileSync(
      join(app.getPath('userData'), 'ember.log'),
      `[${new Date().toISOString()}] ${label}: ${line}\n`
    )
  } catch {
    // A log that cannot be written must not become its own crash.
  }
}

/* One dialog, not one per fault: a crash loop that raised a box per throw would
   bury the desktop. The first is the one that says where the log lives. */
let faultShown = false

/**
 * Look for a new version, when that has been asked for.
 *
 * Off by default and checked only here: an app that reaches out to a server and
 * then rewrites itself is doing something the person running it should have chosen,
 * not something that comes with a terminal. `checkForUpdatesAndNotify` downloads in
 * the background and tells the OS when a version is ready, which is installed on the
 * next quit — nothing is replaced underneath a running shell.
 *
 * Imported where it is used so a launch with the setting off never loads it, and
 * wrapped because there is nothing to check against until a release is published:
 * a missing feed is an ordinary outcome here, not a fault worth interrupting for.
 */
async function maybeCheckForUpdate(): Promise<void> {
  if (!settings.get().autoUpdate) return
  if (!app.isPackaged) return
  try {
    const autoUpdater = await loadUpdater()
    autoUpdater.autoDownload = true
    autoUpdater.on('error', (err) => reportFault('update check failed', err))
    await autoUpdater.checkForUpdatesAndNotify()
  } catch (err) {
    reportFault('update check could not run', err)
  }
}

/*
 * electron-updater is CommonJS, and what a dynamic import hands back differs
 * between the dev server and the packaged bundle: dev synthesizes the named
 * export, the packaged require does not — where it worked all through
 * development and then failed in the one build users run. Both shapes are
 * accepted here, which is the only place the difference is allowed to matter.
 */
async function loadUpdater(): Promise<typeof import('electron-updater').autoUpdater> {
  const mod = (await import('electron-updater')) as {
    autoUpdater?: typeof import('electron-updater').autoUpdater
    default?: { autoUpdater?: typeof import('electron-updater').autoUpdater }
  }
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!updater) throw new Error('electron-updater exposed no autoUpdater')
  return updater
}

/**
 * The same check, run by hand from Settings — and answered in words.
 *
 * The background check is deliberately silent, which also made it unaccountable:
 * with nothing published yet there was no way to tell "no update" from "the
 * check never ran". This one returns a sentence for the settings panel to show,
 * whatever happened.
 */
async function checkForUpdateNow(): Promise<string> {
  if (!app.isPackaged) return 'Update checks only run in the installed app.'
  try {
    const autoUpdater = await loadUpdater()
    autoUpdater.autoDownload = settings.get().autoUpdate
    const result = await autoUpdater.checkForUpdates()
    const found = result?.updateInfo?.version
    if (!found) return 'The update service had nothing to say.'
    if (found === app.getVersion()) return `Up to date — ${found} is the newest version.`
    return settings.get().autoUpdate
      ? `Version ${found} is available and downloading; it installs when Ember quits.`
      : `Version ${found} is available. Turn on update checks to download it.`
  } catch (err) {
    reportFault('manual update check failed', err)
    return `The check failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
  }
}

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
let claudeCli: ClaudeCliService
/** How many editor documents hold unsaved changes, as last reported by the renderer. */
let unsavedCount = 0
/** Set once the user has agreed to lose them, so the second close goes through. */
let closingConfirmed = false
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

/**
 * Where the window should open.
 *
 * The remembered rectangle, but only if some display still contains it: monitors
 * get unplugged and resolutions change, and a window restored onto a screen that is
 * no longer there opens somewhere nobody can reach it. Falling back to the default
 * size with no position lets Electron place it, which is the right answer for a
 * first run as well.
 */
function openingBounds(): { x?: number; y?: number; width: number; height: number } {
  const fallback = { width: 1180, height: 760 }
  const saved = settings.get().windowBounds
  if (!saved) return fallback

  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    // The title bar has to be reachable, so the test is on the top edge rather than
    // on the whole rectangle: a window hanging off the bottom can still be dragged.
    return (
      saved.x + saved.width > a.x &&
      saved.x < a.x + a.width &&
      saved.y >= a.y - 8 &&
      saved.y < a.y + a.height
    )
  })
  return visible ? saved : fallback
}

function createWindow(): void {
  const opening = openingBounds()
  mainWindow = new BrowserWindow({
    ...opening,
    minWidth: 520,
    minHeight: 360,
    show: false,
    backgroundColor: '#0c0c0c',
    // Set explicitly rather than left to the packager: without it the window and
    // taskbar show Electron's own icon in development, and the Explorer context
    // menu entry — which reads its icon from this executable — would too. The
    // .ico on Windows, because it carries every size the shell asks for; a PNG
    // gets scaled to the taskbar and arrives blurry or not at all.
    icon: join(
      app.isPackaged ? process.resourcesPath : app.getAppPath(),
      'resources',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    ),
    // Frameless so the tab strip can live in the title bar, the way Windows
    // Terminal does. The renderer draws its own caption buttons.
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /*
       * The renderer runs sandboxed.
       *
       * It was off for one reason: the preload called homedir(), which needs Node.
       * That is a whole OS sandbox given up for a string, and the string is now
       * fetched over IPC instead. Nothing else in the preload touches Node.
       */
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // Before it is shown, so the first frame is already the right size.
    const zoom = settings.get().uiZoom
    if (Number.isFinite(zoom) && zoom !== 1) {
      mainWindow?.webContents.setZoomFactor(Math.min(Math.max(zoom, 0.6), 2.5))
    }
    // Maximised before the first paint, for the same reason as the zoom: showing a
    // 1180px window and then snapping it out is a flash the user has to watch.
    if (settings.get().windowMaximized) mainWindow?.maximize()
    mainWindow?.show()
    // After the window, never before: a launch should not wait on a network call.
    setTimeout(() => void maybeCheckForUpdate(), 8000)
  })

  /*
   * Closing the window is the last chance to keep unsaved work.
   *
   * The renderer keeps this count current, because asking it at close time means
   * an async round trip inside an event that has to decide synchronously. Session
   * restore does preserve unsaved buffers, but it can be switched off, it has a
   * size limit, and neither is something to bet someone's work on without asking.
   */
  mainWindow.on('close', (event) => {
    if (unsavedCount === 0 || closingConfirmed || !mainWindow) return
    event.preventDefault()
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      message: `${unsavedCount} ${unsavedCount === 1 ? 'file has' : 'files have'} unsaved changes.`,
      detail: 'Closing now discards them.'
    })
    if (choice === 1) {
      closingConfirmed = true
      mainWindow.close()
    }
  })

  /*
   * Remember the window as it is moved and sized, not as it closes.
   *
   * On close the window may already be minimised or on its way out, and a
   * minimised window's bounds are not where it lives. Recorded on a debounce
   * instead, and only while it is in its normal state — a maximised window keeps
   * the rectangle it would return to, which is what should come back when it is
   * unmaximised again.
   */
  let boundsTimer: NodeJS.Timeout | null = null
  const rememberBounds = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
      const maximized = mainWindow.isMaximized()
      settings.set({
        windowMaximized: maximized,
        ...(maximized ? {} : { windowBounds: mainWindow.getNormalBounds() })
      })
    }, 400)
  }
  mainWindow.on('resize', rememberBounds)
  mainWindow.on('move', rememberBounds)
  mainWindow.on('maximize', rememberBounds)
  mainWindow.on('unmaximize', rememberBounds)

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

  /*
   * The window stays on its own document.
   *
   * Nothing stopped it navigating elsewhere — a dropped link, a stray anchor, a
   * redirect — and whatever it landed on would inherit the whole preload bridge:
   * reading and writing arbitrary files, spawning shells, the lot. The frame is
   * pinned to the page it starts on, and anything else is handed to the browser,
   * which is where a web page belongs.
   */
  const stayPut = (event: Electron.Event, url: string): void => {
    const current = mainWindow?.webContents.getURL()
    if (!current || url === current) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', stayPut)
  mainWindow.webContents.on('will-redirect', stayPut)

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  // Synchronous because the preload reads it while it is being set up, before any
  // renderer code runs — and registerIpc() runs before the window is created.
  ipcMain.on('app:homeDir', (event) => {
    event.returnValue = app.getPath('home')
  })
  const detected = detectProfiles()

  /*
   * Recomputed per ask rather than captured once: the custom half lives in
   * settings, and a shell added in the dialog should be spawnable without a
   * relaunch. The icon is chosen by dialect — it is the part of the shape a
   * person should not have to answer for.
   */
  const profiles = (): ShellProfile[] => [
    ...detected,
    ...settings.get().customProfiles.map((c) => ({
      ...c,
      icon: c.integration === 'powershell' ? 'pwsh' : c.integration === 'bash' ? 'bash' : 'cmd'
    }))
  ]

  ipcMain.handle('profiles:list', () => profiles())

  ipcMain.handle('pty:spawn', (_e, req: SpawnRequest) => {
    const all = profiles()
    const profile = all.find((p) => p.id === req.profileId) ?? all[0]
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

  ipcMain.on('ai:chat', (_e, req: AiChatRequest) => {
    void ai.chat(req, (event) => sendToRenderer('ai:chat-event', event))
  })
  ipcMain.on('ai:chat-cancel', (_e, requestId: string) => ai.cancelChat(requestId))
  ipcMain.handle('ai:credential', () => ai.credential())
  ipcMain.handle('ai:usage', () => ai.usage())
  ipcMain.handle('ai:check-usage', () => ai.checkUsage())
  // Refreshed rather than cached, because this is asked right after the user has
  // gone away and signed in.
  ipcMain.handle('ai:claudeAccess', () => {
    claudeCli.forget()
    return claudeCli.access(true)
  })

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
  // One boolean, so a click on something path-shaped can stay quiet when it
  // leads nowhere instead of opening an empty tab.
  ipcMain.handle('file:exists', (_e, filePath: string) => existsSync(filePath))
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
  ipcMain.handle('git:push', (_e, root: string, hasUpstream: boolean) => git.push(root, hasUpstream))
  ipcMain.handle('git:pull', (_e, root: string) => git.pull(root))
  ipcMain.handle('git:branches', (_e, root: string) => git.branches(root))
  ipcMain.handle('git:checkout', (_e, root: string, name: string, create: boolean) =>
    create ? git.createBranch(root, name) : git.checkout(root, name)
  )
  ipcMain.handle('file:write', (_e, filePath: string, content: string) =>
    files.write(filePath, content)
  )
  ipcMain.handle('file:saveDialog', (_e, defaultPath?: string) =>
    mainWindow ? files.saveDialog(mainWindow, defaultPath) : null
  )

  // Completion only cares which dialects exist, and the detected set answers
  // that; a custom shell added mid-session completes like its dialect.
  completion = new CompletionService(detected)
  ipcMain.handle('completion:request', (_e, req: CompletionRequest) => completion.complete(req))

  ipcMain.on('pty:ack', (_e, paneId: string, parsed: number) => ptys.ack(paneId, parsed))
  ipcMain.handle('pty:flowStats', () => ptys.flowStats())
  ipcMain.on('history:record', (_e, entry: HistoryRecord) => history.record(entry))
  ipcMain.on('blocks:save', (_e, paneId: string, block: PersistedBlock) =>
    history.saveBlock(paneId, block)
  )
  ipcMain.handle('blocks:load', (_e, paneIds: string[]) => history.loadBlocks(paneIds))
  ipcMain.on('blocks:clear', (_e, paneId: string) => history.clearBlocks(paneId))
  ipcMain.on('blocks:keep', (_e, paneIds: string[]) => history.keepOnlyBlocksFor(paneIds))
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

  /*
   * The key never crosses into the renderer.
   *
   * It was decrypted and handed over on every read, and the renderer is the side
   * that turns command output into HTML — so anything that ever managed to run
   * there could ask for the settings and walk away with the key. Nothing in the
   * renderer needs its value: AiService reads it in main, and the dialog only
   * needs to know whether one is set.
   */
  ipcMain.handle('settings:get', () => {
    const current = settings.get()
    return { ...current, anthropicApiKey: null, hasApiKey: !!current.anthropicApiKey?.trim() }
  })
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => settings.set(patch))
  ipcMain.handle('updates:check', () => checkForUpdateNow())
  ipcMain.handle('settings:noteFolder', (_e, folder: string) => settings.noteRecentFolder(folder))
  ipcMain.handle('settings:loadError', () => settings.takeLoadError())
  ipcMain.on('window:zoom', (_e, factor: number) => {
    // Clamped: a zoom of 0 leaves an invisible window with no way back to the
    // control that set it.
    const clamped = Math.min(Math.max(Number.isFinite(factor) ? factor : 1, 0.6), 2.5)
    mainWindow?.webContents.setZoomFactor(clamped)
  })
  ipcMain.on('window:unsaved', (_e, count: number) => {
    unsavedCount = Math.max(0, count)
  })
  ipcMain.handle('settings:encryption', () => settings.encryptionAvailable())

  /*
   * Pasting into a terminal.
   *
   * The renderer can write to the clipboard on a keystroke, but reading it needs a
   * permission the sandbox does not grant — and a paste that depends on a
   * permission prompt is not a paste. Main has the clipboard already.
   */
  ipcMain.handle('clipboard:read', () => clipboard.readText())

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

/*
 * Anything that got away.
 *
 * Without these an unhandled rejection anywhere in main — an IPC handler, a git
 * call, a language server dying mid-request — takes the process down with no
 * message and no log, and the window vanishes with the shells still in it. There
 * is nowhere useful to report to, so this does the one thing that helps: says what
 * happened, on stderr, where a packaged build's console and a dev run both show it.
 *
 * Deliberately not exiting. Electron's default for an uncaught exception is to
 * die, and for a terminal holding live shells that is the worse of the two risks:
 * a main process carrying on in a slightly wrong state is recoverable by closing
 * the window, and one that has already exited is not.
 */
process.on('uncaughtException', (error) => {
  reportFault('uncaught exception in main', error)
  if (app.isPackaged && !faultShown) {
    faultShown = true
    dialog.showErrorBox(
      'Ember hit a problem',
      `Something failed in the background. Ember will keep running if it can.\n\n` +
        `Details were written to:\n${join(app.getPath('userData'), 'ember.log')}`
    )
  }
})
process.on('unhandledRejection', (reason) => {
  reportFault('unhandled rejection in main', reason)
})

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
    claudeCli = new ClaudeCliService()
    ai = new AiService(settings, claudeCli)
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
