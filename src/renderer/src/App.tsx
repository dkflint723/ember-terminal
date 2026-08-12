import { useEffect } from 'react'
import { useStore } from './state/store'
import { TitleBar } from './components/TitleBar'
import { SplitView } from './components/SplitView'
import { SettingsPanel } from './components/SettingsPanel'
import { HistorySearch } from './components/HistorySearch'
import { disposeController } from './terminal/controller'
import { activateTheme, refreshThemeList } from './state/theming'

export function App(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)
  const setProfiles = useStore((s) => s.setProfiles)
  const applySettings = useStore((s) => s.applySettings)
  const newTab = useStore((s) => s.newTab)

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
      const preferred =
        profiles.find((p) => p.id === settings.defaultProfileId)?.id ?? profiles[0].id
      if (useStore.getState().tabs.length === 0) newTab(preferred)
    })()
  }, [newTab, setProfiles, applySettings])

  // Dispose controllers for panes that have gone away, so xterm instances and
  // their offscreen render terminals are not leaked.
  useEffect(() => {
    const live = new Set(Object.keys(panes))
    return () => {
      for (const id of live) if (!useStore.getState().panes[id]) disposeController(id)
    }
  }, [panes])

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
