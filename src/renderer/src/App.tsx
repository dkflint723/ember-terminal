import { useEffect } from 'react'
import { useStore } from './state/store'
import { TitleBar } from './components/TitleBar'
import { SplitView } from './components/SplitView'
import { SettingsPanel } from './components/SettingsPanel'
import { HistorySearch } from './components/HistorySearch'
import { ActivityBar } from './components/ActivityBar'
import { Sidebar } from './components/Sidebar'
import { Palette } from './components/Palette'
import { disposeController } from './terminal/controller'
import { activateTheme, refreshThemeList } from './state/theming'
import { useGitStatusPolling } from './state/git'
import { useIdeBridge } from './state/ide'
import { restore, unsavedWorkIsPreserved, useSessionAutosave } from './state/session'
import { setRevealer } from './editor/navigate'

export function App(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const notice = useStore((s) => s.notice)
  const setNotice = useStore((s) => s.setNotice)

  // Kept current in main, which has to decide synchronously when the window is
  // closing and cannot wait on an answer from here.
  useEffect(() => {
    const report = (): void => {
      const s = useStore.getState()
      let count = 0
      for (const pane of Object.values(s.panes)) {
        if (pane.kind !== 'editor') continue
        for (const doc of pane.documents) if (doc.dirty) count += 1
      }
      // Only work that closing would actually lose. With session restore on and
      // writing successfully, it comes back — warning about it would be a prompt
      // for nothing several times a day.
      window.ember.reportUnsaved(unsavedWorkIsPreserved() ? 0 : count)
    }
    report()
    return useStore.subscribe(report)
  }, [])
  const setProfiles = useStore((s) => s.setProfiles)
  const applySettings = useStore((s) => s.applySettings)
  const newTab = useStore((s) => s.newTab)
  const restoreEnabled = useStore((s) => s.settings.restoreSession)

  // Mounted here rather than in the source-control view: the explorer colours its
  // rows from the same status, and that has to work while the view is closed.
  useGitStatusPolling()
  // Answers Claude Code's tool calls, and keeps the published workspace root current.
  useIdeBridge()
  const isHomeDirectory = (dir: string): boolean =>
    dir.replace(/[\\/]+$/, '').toLowerCase() ===
    window.ember.homeDir.replace(/[\\/]+$/, '').toLowerCase()

  // Reads the applied setting, so turning restore off stops the writing too.
  useSessionAutosave(restoreEnabled)

  // The workspace root defaults to the active terminal's directory, but does not
  // follow it afterwards — re-rooting under someone mid-browse would be hostile.
  // It lives here rather than in the explorer because source control needs a root
  // too, and would otherwise have none until the explorer had been opened once.
  const rootTab = tabs.find((t) => t.id === activeTabId)
  const rootPane = rootTab ? panes[rootTab.activePaneId] : undefined
  const terminalCwd = rootPane?.kind === 'terminal' ? rootPane.cwd : null
  /*
   * Never the home directory, though.
   *
   * A new terminal reports home until its shell says otherwise, so launching
   * without a folder adopted the user's entire profile as the workspace before they
   * had done anything: the explorer listed .ssh and AppData, quick open and search
   * indexed and grepped the lot — one search for "password" turned up real
   * credentials in unrelated files — and Replace All was armed across all of it.
   *
   * Declining also makes the "Open a folder to…" empty states reachable, which is
   * the one place the app tells a new user that opening a folder is a thing to do.
   * Someone who genuinely wants their home directory can still choose it.
   */
  useEffect(() => {
    const s = useStore.getState()
    if (!s.treeRoot && terminalCwd && !isHomeDirectory(terminalCwd)) s.setTreeRoot(terminalCwd)
  }, [terminalCwd])

  // Boot: discover shells, then open the first tab on the preferred one.
  useEffect(() => {
    void (async () => {
      const [profiles, settings] = await Promise.all([
        window.ember.listProfiles(),
        window.ember.getSettings()
      ])
      setProfiles(profiles)
      applySettings(settings)

      // Settings that existed but could not be read were replaced with defaults in
      // silence, which is indistinguishable from a first run right up until the
      // next write makes it permanent.
      const badSettings = await window.ember.settingsLoadError()
      if (badSettings) {
        useStore
          .getState()
          .setNotice(
            `Your settings could not be read and have been reset. The old file was kept as settings.json.bad. (${badSettings})`,
            'error'
          )
      }

      // Theme before the first pane, so no terminal is ever created with the
      // wrong palette and then repainted.
      await Promise.all([activateTheme(settings.themeId), refreshThemeList()])

      if (profiles.length === 0) return

      // Read before the first tab exists, so the workspace root can be seeded from
      // a file argument. A new terminal reports the home directory until its shell
      // says otherwise, and that placeholder would otherwise claim the root first.
      const [startup, folders] = await Promise.all([
        window.ember.startupFiles(),
        window.ember.startupFolders()
      ])

      // A folder argument — what Explorer's "Open in Ember" passes — is the
      // strongest statement of where the user is working, so it wins over a file's
      // directory, which in turn beats the shell's own default.
      const root =
        folders[0] ??
        (startup[0] ? startup[0].replace(/[\\/][^\\/]*$/, '') || null : null)

      // The last workspace goes back before anything is created, so restored tabs
      // are the tabs rather than joining an empty one that was made first.
      /*
       * A restore that throws must not take the window with it.
       *
       * The whole boot sequence runs inside one unguarded async block, so anything
       * thrown while walking a saved layout stopped it before the first tab was
       * ever created — leaving a window with no terminal, no editor and no way to
       * do anything. Main validates the file now, but a fresh window is the right
       * answer to any restore that still fails, rather than no window at all.
       */
      /*
       * A folder argument used to skip the restore entirely, which quietly destroyed
       * the session it skipped: the autosave subscription is already armed by then,
       * so opening a folder from Explorer's "Open in Ember" wrote a one-tab snapshot
       * over session.json a second later, taking every tab from the last workspace
       * and every unsaved buffer in it. The last session comes back either way now,
       * and the folder joins it — the same thing a second instance does with one.
       */
      let restored = false
      if (settings.restoreSession) {
        try {
          restored = await restore(await window.ember.sessionLoad())
        } catch (err) {
          console.error('Could not restore the last session; starting fresh.', err)
          restored = false
        }
      }
      // A folder argument overrides a restored root: launching on a folder is an
      // explicit statement about where the user is working now.
      if (root) useStore.getState().setTreeRoot(root)

      const preferred =
        profiles.find((p) => p.id === settings.defaultProfileId)?.id ?? profiles[0].id
      // The shell starts in that folder too: "open here" would be a strange promise
      // to keep in the sidebar and break in the terminal.
      if (!restored && useStore.getState().tabs.length === 0) {
        newTab(preferred, folders[0] ?? undefined)
      } else if (folders[0]) {
        // A folder asked for on top of a workspace that came back gets its own tab,
        // the same answer a second instance gives when it is handed one.
        newTab(preferred, folders[0])
      }

      // Files named on the command line open once the first tab exists, since an
      // editor pane is created beside an existing pane.
      await openPaths(startup)
    })()
  }, [newTab, setProfiles, applySettings])

  useEffect(() => window.ember.onOpenFiles((paths) => void openPaths(paths)), [])

  // Handed to the editor panes, which need it for Go to Definition but sit several
  // levels down a tree that has no other use for it.
  useEffect(() => setRevealer((p, line, column) => void revealAt(p, line, column)), [])

  /*
   * Let Go to Definition open a file that is not already open.
   *
   * Monaco navigates by asking for a model, and when the target lives in a file
   * with no editor there is no model to ask for — so definitions, references and
   * renames that pointed anywhere else did nothing at all. An opener is how Monaco
   * asks the host to produce one; without it registered, it simply gives up.
   */
  useEffect(() => {
    let disposed = false
    let opener: { dispose(): void } | null = null
    void import('./editor/monaco').then(({ monaco }) => {
      if (disposed) return
      opener = monaco.editor.registerEditorOpener({
        openCodeEditor: (_source, resource, selection) => {
          if (resource.scheme !== 'file') return false
          // Monaco passes either a range or a bare position, depending on whether
          // the target has an extent.
          const at = selection as { startLineNumber?: number; startColumn?: number; lineNumber?: number; column?: number } | undefined
          const line = at?.startLineNumber ?? at?.lineNumber ?? 1
          const column = (at?.startColumn ?? at?.column ?? 1) - 1
          void revealAt(resource.fsPath, line, column)
          // Handled, even though the work finishes asynchronously — returning false
          // makes Monaco fall back to doing nothing.
          return true
        }
      })
    })
    return () => {
      disposed = true
      opener?.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A second instance launched on a folder opens a tab there rather than stealing
  // the root from whatever the current window is already working on.
  useEffect(
    () =>
      window.ember.onOpenFolder((folder) => {
        const s = useStore.getState()
        if (!s.treeRoot) s.setTreeRoot(folder)
        s.newTab(s.profiles[0]?.id ?? '', folder)
      }),
    []
  )

  // Dispose controllers for panes that have gone away, so xterm instances and
  // their offscreen render terminals are not leaked.
  useEffect(() => {
    const live = new Set(Object.keys(panes))
    return () => {
      for (const id of live) if (!useStore.getState().panes[id]) disposeController(id)
    }
  }, [panes])

  const openPaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    // A file named on the command line says more about where the user is working
    // than the shell's start directory does, so it seeds the workspace root.
    const s0 = useStore.getState()
    if (!s0.treeRoot) {
      const dir = paths[0].replace(/[\\/][^\\/]*$/, '')
      if (dir && dir !== paths[0]) s0.setTreeRoot(dir)
    }
    const { languageForPath } = await import('./editor/monaco')
    for (const filePath of paths) {
      const res = await window.ember.readFile(filePath)
      if (!res.ok) {
        /*
         * Say why nothing opened.
         *
         * A binary file, or one over the size cap, was skipped in silence — no tab,
         * no message, nothing at all. Double-clicking a PNG in the explorer looked
         * exactly like the app having stopped responding to clicks.
         */
        useStore
          .getState()
          .setNotice(`${filePath.split(/[\\/]/).pop()}: ${res.error}`, 'error')
        continue
      }
      const s = useStore.getState()
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      if (!tab) return
      s.openFileInSplit(tab.id, {
        path: res.path,
        name: res.name,
        content: res.content,
        language: languageForPath(res.path),
        eol: res.eol
      })
    }
  }

  /**
   * Open a file and put the cursor on a specific match, for a search result.
   *
   * The reveal is a separate step from the open because the editor pane creates
   * Monaco's model itself — the position can only be set once that exists, which
   * is a render later.
   */
  const revealAt = async (filePath: string, line: number, column: number): Promise<void> => {
    await openPaths([filePath])
    const { modelUri, monaco } = await import('./editor/monaco')
    // A couple of frames is enough for the pane to mount and claim the model.
    window.setTimeout(() => {
      const model = monaco.editor.getModel(modelUri(filePath))
      if (!model) return
      for (const editor of monaco.editor.getEditors()) {
        if (editor.getModel() !== model) continue
        const position = { lineNumber: line, column: column + 1 }
        editor.setSelection({
          startLineNumber: line,
          startColumn: column + 1,
          endLineNumber: line,
          endColumn: column + 1
        })
        editor.revealPositionInCenter(position)
        editor.focus()
      }
    }, 220)
  }

  const openFile = async (): Promise<void> => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return
    // Start the picker in the active terminal's directory, which is nearly always
    // where the file the user wants lives.
    const pane = s.panes[tab.activePaneId]
    const from = pane?.kind === 'terminal' ? pane.cwd : undefined

    const res = await window.ember.openFileDialog(from)
    if (!res.ok) return
    await openPaths([res.path])
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      const tabId = s.activeTabId
      const tab = s.tabs.find((t) => t.id === tabId)

      if (e.ctrlKey && e.shiftKey) {
        const key = e.key.toLowerCase()
        if (key === 't') {
          e.preventDefault()
          newTab(s.profiles[0]?.id ?? '')
          return
        }
        if (key === 'w' && tab) {
          e.preventDefault()
          s.closePane(tab.id, tab.activePaneId)
          return
        }
        // Windows Terminal uses Alt+Shift+= / Alt+Shift+- ; these are the
        // equivalents that do not collide with shell shortcuts.
        if (key === 'd' && tab) {
          e.preventDefault()
          s.splitPane(tab.id, tab.activePaneId, 'row')
          return
        }
        if (key === 'e' && tab) {
          e.preventDefault()
          s.splitPane(tab.id, tab.activePaneId, 'column')
          return
        }
      }

      /*
       * Ctrl+K asks Claude, and is claimed globally so it means the same thing
       * wherever focus is. In an editor pane Monaco takes it as a chord prefix and
       * swallows the next keystroke, which reads as the app freezing — the
       * shortcut is advertised in the composer footer, so it has to work from
       * anywhere rather than only from the composer itself.
       */
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (!tab) return
        // The pane it targets is the active one when that is a terminal, else the
        // first terminal in the tab — asking about a shell needs a shell.
        const active = s.panes[tab.activePaneId]
        const target =
          active?.kind === 'terminal'
            ? active.id
            : Object.values(s.panes).find((p) => p.kind === 'terminal')?.id
        if (target) s.requestAsk(target)
        return
      }

      // Save All. Ctrl+S belongs to the focused editor, and VS Code's Ctrl+K S is
      // not available here because Ctrl+K asks Claude.
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void s.saveAllDocuments()
        return
      }

      // Ctrl+R is history search. Electron's default accelerator would reload the
      // window, so this must claim the key.
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        s.toggleHistory()
        return
      }

      // Ctrl+B and Ctrl+Shift+G select a sidebar view, matching the editor
      // convention: pressing one twice collapses the sidebar again.
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        s.showSidebarView('explorer')
        return
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        s.showSidebarView('scm')
        return
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        s.showSidebarView('github')
        return
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        s.showSidebarView('problems')
        return
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        s.showSidebarView('search')
        return
      }

      // Ctrl+P goes to a file, Ctrl+Shift+P runs a command. Claimed globally, and
      // ahead of the editor, so they work wherever focus happens to be.
      if (e.ctrlKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        s.openPalette(e.shiftKey ? 'commands' : 'files')
        return
      }

      // Ctrl+O opens a file in an editor pane beside the current one.
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openFile()
        return
      }

      if (e.ctrlKey && e.key === ',') {
        e.preventDefault()
        s.toggleSettings()
        return
      }

      // Ctrl+Tab cycles tabs.
      if (e.ctrlKey && e.key === 'Tab' && s.tabs.length > 1) {
        e.preventDefault()
        const i = s.tabs.findIndex((t) => t.id === tabId)
        const next = s.tabs[(i + (e.shiftKey ? -1 : 1) + s.tabs.length) % s.tabs.length]
        s.setActiveTab(next.id)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newTab])

  const activeTab = tabs.find((t) => t.id === activeTabId)

  return (
    <div className="app">
      <TitleBar />
      <div className="workspace">
        <ActivityBar />
        {sidebarOpen && (
          <Sidebar onOpen={(p) => void openPaths([p])} onOpenAt={(p, l, c) => void revealAt(p, l, c)} />
        )}
        {activeTab ? (
          <SplitView
            tabId={activeTab.id}
            node={activeTab.root}
            path={[]}
            activePaneId={activeTab.activePaneId}
          />
        ) : (
          <div className="empty">
            <div>No shells open</div>
            <div style={{ fontSize: 11 }}>
              <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>T</kbd> to open one
            </div>
          </div>
        )}
        <SettingsPanel />
        <HistorySearch />
        <Palette onOpenFile={(p) => void openPaths([p])} />
      </div>

      {/* Things that failed away from any panel of their own — a background save,
          the session file, writing settings — rather than being discarded. */}
      {notice && (
        <div className={`notice notice--${notice.tone}`} role="status">
          <span>{notice.text}</span>
          <button className="notice__close" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
