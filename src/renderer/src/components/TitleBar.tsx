import { useEffect, useState } from 'react'
import { activeDocument, useStore } from '../state/store'

/**
 * The three splits worth a button.
 *
 * Left and right are genuinely different — one puts the new shell before the
 * current one, the other after — which is why the store takes a side rather than
 * only a direction. Splitting upward exists as well but nobody reaches for it, so
 * it stays in the palette rather than taking a fourth slot here.
 */
const SPLITS = [
  {
    id: 'left',
    label: 'Split left',
    hint: 'new pane on the left',
    direction: 'row' as const,
    before: true,
    fill: { x: 2.5, y: 3.5, width: 5.5, height: 9 }
  },
  {
    id: 'right',
    label: 'Split right',
    hint: 'Ctrl+Shift+D',
    direction: 'row' as const,
    before: false,
    fill: { x: 8, y: 3.5, width: 5.5, height: 9 }
  },
  {
    id: 'down',
    label: 'Split down',
    hint: 'Ctrl+Shift+E',
    direction: 'column' as const,
    before: false,
    fill: { x: 2.5, y: 8.5, width: 11, height: 4 }
  }
]

export function TitleBar(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)
  const profiles = useStore((s) => s.profiles)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const newTab = useStore((s) => s.newTab)
  const splitPane = useStore((s) => s.splitPane)
  const toggleSettings = useStore((s) => s.toggleSettings)

  const [maximized, setMaximized] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => window.ember.onWindowState((s) => setMaximized(s.maximized)), [])

  /*
   * Escape or a click anywhere else closes the profile menu.
   *
   * It only closed when the pointer happened to leave it, so a menu opened and left
   * alone stayed on screen over the app with no way to dismiss it from the keyboard
   * at all.
   */
  useEffect(() => {
    if (!menuOpen) return
    const dismiss = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e instanceof MouseEvent && (e.target as HTMLElement)?.closest('.titlebar__newwrap')) return
      setMenuOpen(false)
    }
    window.addEventListener('keydown', dismiss, true)
    window.addEventListener('mousedown', dismiss, true)
    return () => {
      window.removeEventListener('keydown', dismiss, true)
      window.removeEventListener('mousedown', dismiss, true)
    }
  }, [menuOpen])

  const titleFor = (tabId: string): string => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return 'Shell'
    const pane = panes[tab.activePaneId]
    if (!pane) return 'Shell'
    // The file name, not its full path — a path fills the tab and truncates the
    // part that identifies the file.
    if (pane.kind === 'diff') return pane.title || 'Untitled'
    if (pane.kind === 'editor') return activeDocument(pane).title || 'Untitled'
    // A pane with no integration never reports a cwd, so name it after its shell
    // rather than leaving the placeholder.
    if (pane.title === 'Shell') {
      return profiles.find((p) => p.id === pane.profileId)?.name ?? pane.title
    }
    return pane.title
  }

  return (
    <div className="titlebar">
      {/*
        A real tab list. These were plain divs with mouse handlers, so the strip
        could not be reached or operated from the keyboard at all, and the close
        button — bound to mousedown alone — ignored Enter and Space even once it
        had focus.
      */}
      <div className="titlebar__tabs" role="tablist" aria-label="Terminal tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? 'tab--active' : ''}`}
            role="tab"
            aria-selected={t.id === activeTabId}
            // Only the selected tab is a tab stop; the arrows move between them,
            // which is how a tab list is expected to behave.
            tabIndex={t.id === activeTabId ? 0 : -1}
            onMouseDown={() => setActiveTab(t.id)}
            onKeyDown={(e) => {
              const index = tabs.findIndex((x) => x.id === t.id)
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const next = tabs[index + (e.key === 'ArrowRight' ? 1 : -1)]
                if (next) setActiveTab(next.id)
              } else if (e.key === 'Delete') {
                e.preventDefault()
                closeTab(t.id)
              }
            }}
          >
            <span className="tab__label">{titleFor(t.id)}</span>
            <button
              className="tab__close"
              title="Close tab"
              aria-label={`Close ${titleFor(t.id)}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/*
        Outside the tab strip, deliberately.

        The strip scrolls horizontally, and a box that scrolls in one axis clips in
        both — so this menu, which hangs below a 36px-tall strip, was rendered and
        then clipped entirely out of view. The button appeared to do nothing at all.
        Out here it is also still reachable once there are more tabs than fit.
      */}
      <div className="titlebar__newwrap">
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

      <div className="titlebar__spacer" />

      {/*
        Split controls, in the layout-icon idiom every editor uses: a box with the
        new pane's share filled in, so the picture says where it lands rather than
        relying on the tooltip.
      */}
      <div className="titlebar__layout">
        {SPLITS.map((s) => (
          <button
            key={s.id}
            className="titlebar__split"
            aria-label={s.label}
            title={`${s.label} (${s.hint})`}
            disabled={!activeTabId}
            onClick={() => {
              const tab = tabs.find((t) => t.id === activeTabId)
              if (tab) splitPane(tab.id, tab.activePaneId, s.direction, s.before)
            }}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <rect
                x="1.5"
                y="2.5"
                width="13"
                height="11"
                rx="1.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <rect {...s.fill} fill="currentColor" opacity="0.85" />
            </svg>
          </button>
        ))}
      </div>

      {/* Named, because the glyphs are drawing characters that a screen reader
          announces as nothing useful. */}
      <div className="titlebar__controls">
        <button
          className="caption-btn"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => window.ember.windowAction('minimize')}
        >
          ─
        </button>
        <button
          className="caption-btn"
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => window.ember.windowAction('maximize')}
        >
          {maximized ? '❐' : '□'}
        </button>
        <button
          className="caption-btn caption-btn--close"
          aria-label="Close window"
          title="Close"
          onClick={() => window.ember.windowAction('close')}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
