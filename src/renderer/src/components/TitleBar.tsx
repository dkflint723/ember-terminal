import { useEffect, useState } from 'react'
import { useStore } from '../state/store'

export function TitleBar(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)
  const profiles = useStore((s) => s.profiles)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const newTab = useStore((s) => s.newTab)
  const toggleSettings = useStore((s) => s.toggleSettings)

  const [maximized, setMaximized] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => window.ember.onWindowState((s) => setMaximized(s.maximized)), [])

  const titleFor = (tabId: string): string => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return 'Shell'
    const pane = panes[tab.activePaneId]
    if (!pane) return 'Shell'
    // The file name, not its full path — a path fills the tab and truncates the
    // part that identifies the file.
    if (pane.kind !== 'terminal') return pane.title || 'Untitled'
    // A pane with no integration never reports a cwd, so name it after its shell
    // rather than leaving the placeholder.
    if (pane.title === 'Shell') {
      return profiles.find((p) => p.id === pane.profileId)?.name ?? pane.title
    }
    return pane.title
  }

  return (
    <div className="titlebar">
      <div className="titlebar__tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? 'tab--active' : ''}`}
            onMouseDown={() => setActiveTab(t.id)}
          >
            <span className="tab__label">{titleFor(t.id)}</span>
            <button
              className="tab__close"
              title="Close tab"
              onMouseDown={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}

        <div style={{ position: 'relative' }}>
          <button
            className="titlebar__new"
            title="New tab"
            onClick={() => {
              // A single profile needs no menu.
              if (profiles.length <= 1) newTab(profiles[0]?.id ?? '')
              else setMenuOpen((o) => !o)
            }}
          >
            ＋
          </button>

          {menuOpen && (
            <div
              style={{
                position: 'absolute',
                top: 30,
                left: 0,
                zIndex: 30,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-strong)',
                borderRadius: 6,
                padding: 4,
                minWidth: 190,
                WebkitAppRegion: 'no-drag'
              } as React.CSSProperties}
              onMouseLeave={() => setMenuOpen(false)}
            >
              {profiles.map((p) => (
                <button
                  key={p.id}
                  className="block__action"
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px' }}
                  onClick={() => {
                    newTab(p.id)
                    setMenuOpen(false)
                  }}
                >
                  {p.name}
                </button>
              ))}
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
              <button
                className="block__action"
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px' }}
                onClick={() => {
                  toggleSettings(true)
                  setMenuOpen(false)
                }}
              >
                Settings…
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="titlebar__spacer" />

      <div className="titlebar__controls">
        <button className="caption-btn" onClick={() => window.ember.windowAction('minimize')}>
          ─
        </button>
        <button className="caption-btn" onClick={() => window.ember.windowAction('maximize')}>
          {maximized ? '❐' : '□'}
        </button>
        <button
          className="caption-btn caption-btn--close"
          onClick={() => window.ember.windowAction('close')}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
