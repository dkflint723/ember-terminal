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
/**
 * The two layout toggles, in the idiom every editor uses: a box with the region
 * in question shaded, so the picture says which edge of the window it means.
 *
 * They toggle regions rather than splitting panes. Splitting is what Ctrl+Shift+D
 * and Ctrl+Shift+E do, and putting it here made the icons a lie — they are the
 * shape of VS Code's sidebar and panel switches, and that is what people reach for
 * them expecting.
 *
 * There was a third, for the right-hand sidebar Claude used to live in. Claude is
 * a block in the list now, so there is no region for it to open and no switch for
 * it to be.
 */
interface LayoutState {
  sidebarOpen: boolean
  panelOpen: boolean
}

const REGIONS = [
  {
    id: 'primary',
    label: 'Toggle the side bar',
    hint: 'Ctrl+B',
    fill: { x: 2.5, y: 3.5, width: 4.5, height: 9 },
    on: (l: LayoutState) => l.sidebarOpen,
    toggle: () => useStore.getState().toggleSidebar()
  },
  {
    id: 'panel',
    label: 'Toggle the panel',
    hint: 'Ctrl+J',
    fill: { x: 2.5, y: 9, width: 11, height: 3.5 },
    on: (l: LayoutState) => l.panelOpen,
    toggle: () => {
      /*
       * The panel only exists in the IDE, so asking for it is also asking for that
       * — and asking for a region is asking to see it. Toggling blindly meant the
       * first press from the terminal switched mode and hid the panel in the same
       * motion, so the button you pressed to get the panel produced no panel.
       */
      const s = useStore.getState()
      if (s.mode !== 'ide') {
        s.setMode('ide')
        s.togglePanel(true)
      } else s.togglePanel()
    }
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
  /*
   * Every selector is read before any of them is combined.
   *
   * Written as `useStore(panelOpen) && useStore(mode) === 'ide'`, the `&&` short
   * circuited: with the panel closed the second hook was never called, so the
   * component rendered fewer hooks than the time before and React tore the whole
   * tree down. Closing the panel emptied the window.
   */
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const panelOpen = useStore((s) => s.panelOpen)
  const mode = useStore((s) => s.mode)
  const layout: LayoutState = {
    sidebarOpen,
    panelOpen: panelOpen && mode === 'ide'
  }
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
            <div className="titlebar__menu" onMouseLeave={() => setMenuOpen(false)}>
              {profiles.map((p) => (
                <button
                  key={p.id}
                  className="titlebar__menu-item"
                  onClick={() => {
                    newTab(p.id)
                    setMenuOpen(false)
                  }}
                >
                  {p.name}
                </button>
              ))}
              <div className="titlebar__menu-rule" />
              <button
                className="titlebar__menu-item"
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
        {/*
          The switch the app is built around, and until now the only one with no
          button: it lived on Ctrl+Shift+I and a palette entry, so a window that had
          become an IDE stayed one — closing the file you opened left two thirds of
          the screen saying "No files open" with nothing offering the way back, and
          people restarted the app to get their terminal.

          Named rather than drawn. The two beside it toggle regions and can share
          one picture with a different part shaded; this changes what the window is,
          which is worth a word.
        */}
        <button
          className={`titlebar__mode ${mode === 'ide' ? 'titlebar__mode--ide' : ''}`}
          aria-label={mode === 'ide' ? 'Back to the terminal' : 'Turn into an IDE'}
          title={`${mode === 'ide' ? 'Back to the terminal' : 'Turn into an IDE'} (Ctrl+Shift+I)`}
          onClick={() => useStore.getState().setMode()}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            {mode === 'ide' ? (
              // A prompt, meaning the thing you get back.
              <path
                d="M3.4 4.6 7 8l-3.6 3.4M8.6 11.6h4.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              // A window with a sidebar and a panel: the shape it turns into.
              <>
                {/* Square, like the three region icons beside it. */}
                <rect
                  x="1.6"
                  y="2.6"
                  width="12.8"
                  height="10.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path d="M5.8 2.6v10.8M5.8 10.2h8.6" stroke="currentColor" strokeWidth="1.3" />
              </>
            )}
          </svg>
          {mode === 'ide' ? 'Terminal' : 'IDE'}
        </button>
        <div className="titlebar__sep" aria-hidden="true" />
        {REGIONS.map((r) => (
          <button
            key={r.id}
            className={`titlebar__split ${r.on(layout) ? 'titlebar__split--on' : ''}`}
            aria-label={r.label}
            aria-pressed={r.on(layout)}
            title={`${r.label} (${r.hint})`}
            onClick={r.toggle}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              {/* Square. The rounded outline was the last soft corner left in the
                  chrome once the blocks, the composer and the tabs lost theirs, and
                  at 15px a 1.5 radius reads as a drawing error rather than a
                  choice. */}
              <rect
                x="1.5"
                y="2.5"
                width="13"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              {/* Filled while the region is open, outlined while it is not, so the
                  three icons report the layout as well as change it. */}
              <rect {...r.fill} fill="currentColor" opacity={r.on(layout) ? 0.85 : 0.25} />
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
