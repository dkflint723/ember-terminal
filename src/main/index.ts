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
import { DapService, detectAdapters } from './dap.js'
import { formatWithPrettier } from './prettier.js'
import {
  DEFAULT_SETTINGS,
  type ShellProfile,
  type AiChatRequest,
  type CompletionRequest,
  type DebugAdapter,
  type DebugStartRequest,
  type HistoryQuery,
  type HistoryRecord,
  type PersistedBlock,
  type ReplaceRequest,
  type SessionSnapshot,
  type Settings,
  type SpawnRequest,
  type TabTransfer
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
    watchUpdater(autoUpdater)
    await autoUpdater.checkForUpdatesAndNotify()
  } catch (err) {
    reportFault('update check could not run', err)
    sendToAll('updates:status', `The update check could not run: ${describeUpdateError(err)}`)
  }
}

/** The first line of whatever went wrong, as a sentence rather than a stack. */
function describeUpdateError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  const first = text.split('\n')[0]
  // The failure this whole path was rebuilt for: a feed naming a file the
  // release does not carry. Said plainly rather than as an HTTP status.
  if (/status 404/i.test(first)) {
    return 'the release is missing the installer its update feed names (404).'
  }
  return first
}

/**
 * Say out loud what the updater is doing.
 *
 * It used to promise "downloading; it installs when Ember quits" the moment a
 * version was found and then say nothing ever again — so a download that 404'd
 * looked exactly like one that worked, and the update simply never arrived.
 * Every window hears the progress, the finish, and the failure.
 */
let updaterWatched = false
function watchUpdater(updater: typeof import('electron-updater').autoUpdater): void {
  if (updaterWatched) return
  updaterWatched = true
  updater.on('error', (err) => {
    reportFault('update failed', err)
    sendToAll('updates:status', `The update failed: ${describeUpdateError(err)}`)
  })
  updater.on('download-progress', (progress) => {
    sendToAll('updates:status', `Downloading the update — ${Math.round(progress.percent)}%.`)
  })
  updater.on('update-downloaded', (info) => {
    sendToAll('updates:status', `Version ${info.version} is downloaded. It installs when Ember quits.`)
  })
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
    watchUpdater(autoUpdater)
    const result = await autoUpdater.checkForUpdates()
    const found = result?.updateInfo?.version
    if (!found) return 'The update service had nothing to say.'
    if (found === app.getVersion()) return `Up to date — ${found} is the newest version.`
    if (!settings.get().autoUpdate) {
      return `Version ${found} is available. Turn on update checks to download it.`
    }
    /*
     * The download reports its own outcome through updates:status as it goes.
     * This line says only that it has begun, which is the one thing known to
     * be true here — the sentence it replaced promised an install that a
     * 404'd download could never deliver, and then never corrected itself.
     */
    return `Version ${found} found; downloading it now.`
  } catch (err) {
    reportFault('manual update check failed', err)
    return `The check failed: ${describeUpdateError(err)}`
  }
}

const isDev = !app.isPackaged

/**
 * Every window, keyed by an ember window id handed out at creation. `mainWindow`
 * survives as the primary — the first window, the one whose bounds live in
 * settings and the one background messages fall back to; when it closes with
 * others still open, one of them inherits the title.
 */
const windows = new Map<number, BrowserWindow>()
let nextWindowId = 0
let mainWindow: BrowserWindow | null = null
/**
 * Which window each pane's output belongs to. Written when a shell is spawned,
 * re-pointed when a session moves to another window, cleared when it dies —
 * this map is what makes a moved tab's shell keep talking, to the new place.
 */
const paneOwners = new Map<string, number>()
/** Unsaved-document counts, per window — each close prompt asks about its own. */
const unsavedCounts = new Map<number, number>()
/** Session snapshots waiting for restored windows that have not booted yet. */
const parkedSnapshots = new Map<number, SessionSnapshot>()
/** Packed sessions waiting for the windows a move created. */
const parkedTransfers = new Map<number, TabTransfer>()
/**
 * Each window's last "keep these blocks" report. The database prune runs on the
 * union: one window listing only its own panes must never delete another's.
 */
const keepSets = new Map<number, string[]>()

function windowIdOf(contents: Electron.WebContents): number | null {
  for (const [id, win] of windows) {
    if (!win.isDestroyed() && win.webContents === contents) return id
  }
  return null
}

function windowFromEvent(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(e.sender)
  return win && !win.isDestroyed() ? win : null
}

function sendToWindow(id: number, channel: string, payload: unknown): void {
  const win = windows.get(id)
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function sendToAll(channel: string, payload: unknown): void {
  for (const id of windows.keys()) sendToWindow(id, channel, payload)
}

/** A pane's messages go to the window that holds it; the primary is the fallback. */
function sendToPaneOwner(paneId: string, channel: string, payload: unknown): void {
  const owner = paneOwners.get(paneId)
  if (owner !== undefined && windows.has(owner)) sendToWindow(owner, channel, payload)
  else sendToRenderer(channel, payload)
}

function focusedEmberWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return mainWindow
}

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
  // The window the user is looking at: a CLI asking about "the editor" means the
  // one in front of them, which with several windows is not always the primary.
  const target = focusedEmberWindow()
  if (!target || target.webContents.isDestroyed()) {
    return Promise.resolve({ success: false, message: 'No window is open.' })
  }
  const id = ++nextIdeCall
  return new Promise((resolve) => {
    pendingIdeCalls.set(id, resolve)
    target.webContents.send('ide:call', { id, name, args })
  })
}
/** Drained once by the renderer at boot; refilled when a second instance starts. */
let startupFiles: string[] = []
let startupFolders: string[] = []
let ai: AiService
let claudeCli: ClaudeCliService
let ptys: PtyManager
let dap: DapService
/** Which window raised the last notification, so its click can land there. */
let lastNoticeWindowId: number | null = null
/**
 * Set the moment a quit begins. The app quits by closing every window, and
 * each of those closes would otherwise read as "the user closed this one" —
 * dropping every session entry but the last window's on the way down.
 */
let quitting = false

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
/** Whether some display still contains this rectangle's title bar. */
function onSomeScreen(saved: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((d) => {
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
}

function openingBounds(): { x?: number; y?: number; width: number; height: number } {
  const fallback = { width: 1180, height: 760 }
  const saved = settings.get().windowBounds
  if (!saved) return fallback
  return onSomeScreen(saved) ? saved : fallback
}

/** What a new window is born holding: a restored session, a moved one, or nothing. */
interface WindowSeed {
  snapshot?: SessionSnapshot | null
  transfer?: TabTransfer | null
  bounds?: { x: number; y: number; width: number; height: number } | null
  maximized?: boolean
}

function createWindow(seed: WindowSeed = {}): number {
  const id = ++nextWindowId
  const primary = mainWindow === null

  /*
   * Where it opens. The primary keeps its settings-remembered rectangle, the way
   * it always has. A restored secondary gets the bounds its session entry wrote
   * down; anything else — a fresh Ctrl+Shift+N, a moved tab — opens offset from
   * the window the user is looking at, the way every multi-window app says
   * "this one is new".
   */
  let opening: { x?: number; y?: number; width: number; height: number }
  if (primary) {
    opening = openingBounds()
  } else if (seed.bounds && onSomeScreen(seed.bounds)) {
    opening = seed.bounds
  } else {
    const anchor = focusedEmberWindow()?.getNormalBounds()
    opening = anchor
      ? { x: anchor.x + 34, y: anchor.y + 34, width: anchor.width, height: anchor.height }
      : { width: 1180, height: 760 }
  }

  if (seed.snapshot) parkedSnapshots.set(id, seed.snapshot)
  if (seed.transfer) parkedTransfers.set(id, seed.transfer)

  const win = new BrowserWindow({
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

  windows.set(id, win)
  if (primary) mainWindow = win

  win.on('ready-to-show', () => {
    // Before it is shown, so the first frame is already the right size.
    const zoom = settings.get().uiZoom
    if (Number.isFinite(zoom) && zoom !== 1) {
      win.webContents.setZoomFactor(Math.min(Math.max(zoom, 0.6), 2.5))
    }
    // Maximised before the first paint, for the same reason as the zoom: showing a
    // 1180px window and then snapping it out is a flash the user has to watch.
    const wantsMax = primary ? settings.get().windowMaximized : seed.maximized === true
    if (wantsMax) win.maximize()
    win.show()
    // After the window, never before: a launch should not wait on a network call —
    // and once per app, not once per window.
    if (primary) setTimeout(() => void maybeCheckForUpdate(), 8000)
  })

  /*
   * Closing the window is the last chance to keep unsaved work.
   *
   * The renderer keeps this count current, because asking it at close time means
   * an async round trip inside an event that has to decide synchronously. Session
   * restore does preserve unsaved buffers, but it can be switched off, it has a
   * size limit, and neither is something to bet someone's work on without asking.
   */
  // Per window, because each window holds its own documents: agreeing to lose
  // one window's edits must not wave the next window's close through.
  let closingConfirmed = false
  win.on('close', (event) => {
    const unsaved = unsavedCounts.get(id) ?? 0
    if (unsaved === 0 || closingConfirmed) return
    event.preventDefault()
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      message: `${unsaved} ${unsaved === 1 ? 'file has' : 'files have'} unsaved changes.`,
      detail: 'Closing now discards them.'
    })
    if (choice === 1) {
      closingConfirmed = true
      win.close()
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
  // Only the primary writes settings: that is the rectangle a plain launch
  // opens with. Secondary windows are remembered through their session entries,
  // whose bounds are stamped every time that window saves its session.
  let boundsTimer: NodeJS.Timeout | null = null
  const rememberBounds = (): void => {
    if (!primary) return
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized() || mainWindow !== win) return
      const maximized = win.isMaximized()
      settings.set({
        windowMaximized: maximized,
        ...(maximized ? {} : { windowBounds: win.getNormalBounds() })
      })
    }, 400)
  }
  win.on('resize', rememberBounds)
  win.on('move', rememberBounds)
  win.on('maximize', rememberBounds)
  win.on('unmaximize', rememberBounds)

  const emitState = (): void =>
    sendToWindow(id, 'window:state', { maximized: !win.isDestroyed() && win.isMaximized() })
  win.on('maximize', emitState)
  win.on('unmaximize', emitState)

  win.on('closed', () => {
    /*
     * This window's shells die with it — and only this window's. The map is
     * walked rather than asked, because a pane whose owner is gone must never
     * outlive it as an orphan process.
     */
    for (const [paneId, owner] of [...paneOwners]) {
      if (owner !== id) continue
      ptys.kill(paneId)
      paneOwners.delete(paneId)
    }
    windows.delete(id)
    dap?.stopOwnedBy(id)
    unsavedCounts.delete(id)
    keepSets.delete(id)
    parkedSnapshots.delete(id)
    parkedTransfers.delete(id)
    /*
     * Closing a window while others live is the statement that it should not
     * come back; the last window's close — and every close on the way out of a
     * quit — is the app closing, and stays kept.
     */
    if (!quitting && windows.size > 0) session.dropWindow(id)
    if (mainWindow === win) {
      mainWindow = windows.values().next().value ?? null
    }
  })

  // Links from terminal output open in the real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
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
    const current = win.isDestroyed() ? null : win.webContents.getURL()
    if (!current || url === current) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', stayPut)
  win.webContents.on('will-redirect', stayPut)

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return id
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

  ipcMain.handle('pty:spawn', (e, req: SpawnRequest) => {
    const all = profiles()
    const profile = all.find((p) => p.id === req.profileId) ?? all[0]
    if (!profile) return { ok: false, error: 'No shell found on this machine.' }
    try {
      // The spawner owns the pane's output until a move says otherwise.
      paneOwners.set(req.paneId, windowIdOf(e.sender) ?? 1)
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
  ipcMain.on('pty:kill', (_e, paneId: string) => {
    paneOwners.delete(paneId)
    ptys.kill(paneId)
  })

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

  // Only the primary drains the command line: restored secondary windows boot
  // at the same moment, and whichever asked first used to walk off with the
  // file the user double-clicked.
  ipcMain.handle('file:startupFiles', (e) => {
    if (windowFromEvent(e) !== mainWindow) return []
    const pending = startupFiles
    startupFiles = []
    return pending
  })

  ipcMain.handle('file:startupFolders', (e) => {
    if (windowFromEvent(e) !== mainWindow) return []
    const pending = startupFolders
    startupFolders = []
    return pending
  })

  ipcMain.handle('explorer:status', () =>
    explorer.supported ? explorer.isRegistered() : Promise.resolve(false)
  )
  // Each window is served the snapshot parked for it at creation, and writes
  // its own entry back — stamped with where the window stands, so a restored
  // secondary opens where it was rather than wherever the cascade lands.
  ipcMain.handle('session:load', (e) => {
    const id = windowIdOf(e.sender)
    if (id === null) return null
    const parked = parkedSnapshots.get(id) ?? null
    parkedSnapshots.delete(id)
    return parked
  })
  ipcMain.handle('session:save', (e, snapshot: SessionSnapshot) => {
    const id = windowIdOf(e.sender)
    const win = windowFromEvent(e)
    if (id === null || !win) return { ok: false, error: 'No window.' }
    /*
     * A window with nothing in it has nothing to restore. This is also what
     * closes the race a move opens: the source window's farewell save — fired
     * from beforeunload after its tab walked out — must not resurrect the
     * session entry its close just dropped.
     */
    if (!Array.isArray(snapshot?.tabs) || snapshot.tabs.length === 0) {
      session.dropWindow(id)
      return { ok: true }
    }
    return session.saveFor(id, {
      bounds: win.isMinimized() ? null : win.getNormalBounds(),
      maximized: win.isMaximized(),
      snapshot
    })
  })
  ipcMain.on('session:clear', () => session.clear())

  ipcMain.on('window:new', () => {
    createWindow()
  })

  /*
   * Debugging. The adapters are served the way shells are — detected plus
   * taught — and the protocol itself passes through a thin generic client:
   * the renderer speaks DAP, main speaks processes and sockets.
   */
  const adapters = (): DebugAdapter[] => [
    ...detectAdapters(
      join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources')
    ),
    ...settings.get().debugAdapters
  ]
  ipcMain.handle('dap:adapters', () => adapters())
  ipcMain.handle('format:prettier', (_e, filePath: string, content: string) =>
    formatWithPrettier(filePath, content)
  )
  ipcMain.handle('dap:start', (e, req: DebugStartRequest) => {
    const adapter = adapters().find((a) => a.id === req?.adapterId)
    if (!adapter) return { ok: false, error: `No debug adapter for '${req?.adapterId}'.` }
    return dap.start(req, adapter, windowIdOf(e.sender) ?? 1)
  })
  ipcMain.handle('dap:request', (_e, sessionId: string, command: string, args?: unknown) =>
    dap.request(sessionId, command, args)
  )
  ipcMain.handle('dap:stop', (_e, sessionId: string) => dap.stop(sessionId))
  ipcMain.on('dap:reverseReply', (_e, sessionId: string, requestSeq: number, ok: boolean) =>
    dap.reverseReply(sessionId, requestSeq, ok)
  )

  /*
   * A session moving house. The new window is created holding the packed tab;
   * the ptys are re-pointed at it here, before the source lets go, so not a
   * byte of shell output has anywhere to fall between the two.
   */
  ipcMain.handle('window:moveTab', (_e, transfer: TabTransfer) => {
    if (
      typeof transfer?.tab?.id !== 'string' ||
      !Array.isArray(transfer.terminals) ||
      !Array.isArray(transfer.editors)
    ) {
      return { ok: false, error: 'Malformed transfer.' }
    }
    const id = createWindow({ transfer })
    for (const pane of transfer.terminals) {
      if (typeof pane?.id === 'string') paneOwners.set(pane.id, id)
    }
    return { ok: true }
  })

  ipcMain.handle('window:adoption', (e) => {
    const id = windowIdOf(e.sender)
    if (id === null) return null
    const parked = parkedTransfers.get(id) ?? null
    parkedTransfers.delete(id)
    return parked
  })
  ipcMain.on('notify:command', (e, notice) => {
    const sender = windowFromEvent(e)
    // The click should land the user back on the window whose command finished.
    lastNoticeWindowId = windowIdOf(e.sender)
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
      sender && sender.isFocused() && sender.isVisible() && !sender.isMinimized()
    if (watching) return
    notifier.show(notice)
  })
  ipcMain.handle('notify:supported', () => notifier.supported)

  ipcMain.handle('explorer:supported', () => explorer.supported)
  ipcMain.handle('explorer:register', () => explorer.register())
  ipcMain.handle('explorer:unregister', () => explorer.unregister())

  ipcMain.handle('file:openDialog', (e, defaultPath?: string) => {
    const win = windowFromEvent(e) ?? mainWindow
    return win ? files.openDialog(win, defaultPath) : { ok: false, error: 'No window.' }
  })
  ipcMain.handle('file:openFolderDialog', (e, defaultPath?: string) => {
    const win = windowFromEvent(e) ?? mainWindow
    return win ? files.openFolderDialog(win, defaultPath) : null
  })
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
  ipcMain.handle('git:headText', (_e, filePath: string) => git.headText(filePath))
  ipcMain.handle('git:checkout', (_e, root: string, name: string, create: boolean) =>
    create ? git.createBranch(root, name) : git.checkout(root, name)
  )
  ipcMain.handle('file:write', (_e, filePath: string, content: string) =>
    files.write(filePath, content)
  )
  ipcMain.handle('file:saveDialog', (e, defaultPath?: string) => {
    const win = windowFromEvent(e) ?? mainWindow
    return win ? files.saveDialog(win, defaultPath) : null
  })

  // Live, so a custom shell added mid-session completes like its dialect —
  // a snapshot taken here would never find it.
  completion = new CompletionService(profiles)
  ipcMain.handle('completion:request', (_e, req: CompletionRequest) => completion.complete(req))

  ipcMain.on('pty:ack', (_e, paneId: string, parsed: number) => ptys.ack(paneId, parsed))
  ipcMain.handle('pty:flowStats', () => ptys.flowStats())
  ipcMain.on('history:record', (_e, entry: HistoryRecord) => history.record(entry))
  ipcMain.on('blocks:save', (_e, paneId: string, block: PersistedBlock) =>
    history.saveBlock(paneId, block)
  )
  ipcMain.handle('blocks:load', (_e, paneIds: string[]) => history.loadBlocks(paneIds))
  ipcMain.on('blocks:clear', (_e, paneId: string) => history.clearBlocks(paneId))
  /*
   * The prune runs on the union of every window's report plus every pane that
   * is currently owned. One window restoring and listing only its own panes
   * used to be the whole truth; with several windows it would be a deletion of
   * everyone else's history.
   */
  ipcMain.on('blocks:keep', (e, paneIds: string[]) => {
    const id = windowIdOf(e.sender)
    if (id !== null) keepSets.set(id, paneIds.filter((p) => typeof p === 'string'))
    const union = new Set<string>(paneOwners.keys())
    for (const list of keepSets.values()) for (const p of list) union.add(p)
    history.keepOnlyBlocksFor([...union])
  })
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

  ipcMain.handle('themes:import', async (e) => {
    const win = windowFromEvent(e) ?? mainWindow
    if (!win) return { ok: false, error: 'No window.' }
    const picked = await dialog.showOpenDialog(win, {
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
  ipcMain.handle('snippets:import', async (e) => {
    const win = windowFromEvent(e) ?? mainWindow
    if (!win) return { ok: false, error: 'No window.' }
    const picked = await dialog.showOpenDialog(win, {
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
  ipcMain.handle('settings:set', (e, patch: Partial<Settings>) => {
    const res = settings.set(patch)
    /*
     * Every window hears about it — the sender included, so a save made from
     * anywhere (the dialog, a script, a suite) lands in every store the same
     * way. Applying settings twice is writing the same values twice. The key
     * never travels: the broadcast carries the redacted shape the read gives.
     */
    const redacted = {
      ...res.settings,
      anthropicApiKey: null,
      hasApiKey: !!res.settings.anthropicApiKey?.trim()
    }
    sendToAll('settings:changed', redacted)
    /*
     * Redacted on the way back, the same as settings:get. The write path used
     * to return the merged settings raw, which handed the stored key to the
     * renderer every time anyone saved a font size — the exact thing the read
     * path was built to never do.
     */
    return { ...res, settings: redacted }
  })
  ipcMain.handle('updates:check', () => checkForUpdateNow())
  ipcMain.handle('settings:noteFolder', (_e, folder: string) => settings.noteRecentFolder(folder))
  ipcMain.handle('settings:loadError', () => settings.takeLoadError())
  ipcMain.on('window:zoom', (e, factor: number) => {
    // Clamped: a zoom of 0 leaves an invisible window with no way back to the
    // control that set it.
    const clamped = Math.min(Math.max(Number.isFinite(factor) ? factor : 1, 0.6), 2.5)
    windowFromEvent(e)?.webContents.setZoomFactor(clamped)
  })
  ipcMain.on('window:unsaved', (e, count: number) => {
    const id = windowIdOf(e.sender)
    if (id !== null) unsavedCounts.set(id, Math.max(0, count))
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

  ipcMain.on('window:action', (e, action: 'minimize' | 'maximize' | 'close') => {
    const win = windowFromEvent(e)
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'close') win.close()
    else if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
}

// A second instance should focus the existing window rather than opening a
// duplicate that competes for the same shells.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    // Opening a file while Ember is already running should surface it here rather
    // than starting a competing instance — in the window the user last stood in.
    const target = focusedEmberWindow()
    const opened = fileArgs(argv, app.getAppPath())
    if (opened.length > 0 && target && !target.webContents.isDestroyed()) {
      target.webContents.send('file:open', opened)
    }
    if (!target) return
    if (target.isMinimized()) target.restore()
    target.focus()
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
    // Every window: each renderer keeps only the documents it holds, and
    // ignores diagnostics about files that are open somewhere else.
    lsp = new LspService(
      (payload) => sendToAll('lsp:message', payload),
      () => settings.get().languageServers
    )
    git = new GitService()
    github = new GitHubService()
    session = new SessionStore()
    notifier = new Notifier(() =>
      focusWindow(windows.get(lastNoticeWindowId ?? -1) ?? mainWindow)
    )
    const startup = pathArgs(process.argv, app.getAppPath())
    startupFiles = startup.files
    startupFolders = startup.folders
    claudeCli = new ClaudeCliService()
    ai = new AiService(settings, claudeCli)
    ide = new IdeServer((name, args) => callRenderer(name, args))
    ide.start([])
    ptys = new PtyManager(
      (paneId, data) => sendToPaneOwner(paneId, 'pty:data', { paneId, data }),
      (paneId, exitCode) => {
        sendToPaneOwner(paneId, 'pty:exit', { paneId, exitCode })
        paneOwners.delete(paneId)
      },
      () => ide.env()
    )
    dap = new DapService((ownerWindowId, sessionId, event, body) =>
      sendToWindow(ownerWindowId, 'dap:event', { sessionId, event, body })
    )

    registerIpc()

    /*
     * Every window that was open comes back, each with its own session. The
     * first stored entry is the primary; the rest only return when restore is
     * on — with it off there is nothing to put in them, and a pile of empty
     * windows would be the memory the user asked not to keep.
     */
    const stored = session.load()
    createWindow({ snapshot: stored[0]?.snapshot ?? null })
    if (settings.get().restoreSession) {
      for (const entry of stored.slice(1)) {
        createWindow({
          snapshot: entry.snapshot,
          bounds: entry.bounds,
          maximized: entry.maximized
        })
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    ptys?.killAll()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    dap?.dispose()
    ptys?.killAll()
    completion?.dispose()
    history?.close()
    lsp?.dispose()
    // Before the process goes, so no lockfile is left naming a dead port for the
    // next CLI that goes looking for an IDE.
    ide?.stop()
  })
}
