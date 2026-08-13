import { useEffect } from 'react'
import { useStore } from './state/store'
import { TitleBar } from './components/TitleBar'
import { SplitView } from './components/SplitView'
import { SettingsPanel } from './components/SettingsPanel'
import { HistorySearch } from './components/HistorySearch'
import { ActivityBar } from './components/ActivityBar'
import { Sidebar } from './components/Sidebar'
import { disposeController } from './terminal/controller'
import { activateTheme, refreshThemeList } from './state/theming'
import { useGitStatusPolling } from './state/git'
import { useIdeBridge } from './state/ide'

export function App(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const setProfiles = useStore((s) => s.setProfiles)
  const applySettings = useStore((s) => s.applySettings)
  const newTab = useStore((s) => s.newTab)

  // Mounted here rather than in the source-control view: the explorer colours its
  // rows from the same status, and that has to work while the view is closed.
  useGitStatusPolling()
  // Answers Claude Code's tool calls, and keeps the published workspace root current.
  useIdeBridge()

  // The workspace root defaults to the active terminal's directory, but does not
  // follow it afterwards — re-rooting under someone mid-browse would be hostile.
  // It lives here rather than in the explorer because source control needs a root
  // too, and would otherwise have none until the explorer had been opened once.
  const rootTab = tabs.find((t) => t.id === activeTabId)
  const rootPane = rootTab ? panes[rootTab.activePaneId] : undefined
  const terminalCwd = rootPane?.kind === 'terminal' ? rootPane.cwd : null
  useEffect(() => {
    const s = useStore.getState()
    if (!s.treeRoot && terminalCwd) s.setTreeRoot(terminalCwd)
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

      // Theme before the first pane, so no terminal is ever created with the
      // wrong palette and then repainted.
      await Promise.all([activateTheme(settings.themeId), refreshThemeList()])

      if (profiles.length === 0) return

      // Read before the first tab exists, so the workspace root can be seeded from
      // a file argument. A new terminal reports the home directory until its shell
      // says otherwise, and that placeholder would otherwise claim the root first.
      const startup = await window.ember.startupFiles()
      if (startup.length > 0) {
        const dir = startup[0].replace(/[\\/][^\\/]*$/, '')
        if (dir && dir !== startup[0]) useStore.getState().setTreeRoot(dir)
      }

      const preferred =
        profiles.find((p) => p.id === settings.defaultProfileId)?.id ?? profiles[0].id
      if (useStore.getState().tabs.length === 0) newTab(preferred)

      // Files named on the command line open once the first tab exists, since an
      // editor pane is created beside an existing pane.
      await openPaths(startup)
    })()
  }, [newTab, setProfiles, applySettings])

  useEffect(() => window.ember.onOpenFiles((paths) => void openPaths(paths)), [])

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
      if (!res.ok) continue
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
        {sidebarOpen && <Sidebar onOpen={(p) => void openPaths([p])} />}
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
      </div>
    </div>
  )
}
