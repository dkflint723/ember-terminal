import { useEffect, useState } from 'react'
import { useStore } from '../state/store'

/**
 * The Direction D title bar: the side-slot toggle, the search, the mode switch,
 * the panel toggle, the window buttons. The tab strip is gone from here — sessions
 * live in the sidebar now, where they have room to say which directory and branch
 * they are standing on instead of a truncated name in 150px.
 */
export function TitleBar(): React.JSX.Element {
  const mode = useStore((s) => s.mode)
  const sessionsOpen = useStore((s) => s.sessionsOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const panelOpen = useStore((s) => s.panelOpen)
  const openPalette = useStore((s) => s.openPalette)

  const [maximized, setMaximized] = useState(false)
  useEffect(() => window.ember.onWindowState((s) => setMaximized(s.maximized)), [])

  /*
   * One slot, one toggle. The button opens whatever the side slot holds in the
   * current mode — the session list in a terminal, the file sidebar in an IDE —
   * which is also exactly what Ctrl+B does, so the picture and the chord agree.
   */
  const slotOpen = mode === 'terminal' ? sessionsOpen : sidebarOpen
  const toggleSlot = (): void => {
    const s = useStore.getState()
    if (s.mode === 'terminal') s.toggleSessions()
    else s.toggleSidebar()
  }

  const panelShown = panelOpen && mode === 'ide'
  const togglePanel = (): void => {
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

  return (
    <div className="titlebar">
      <button
        className="titlebar__icon"
        aria-label="Toggle the side bar"
        aria-pressed={slotOpen}
        title="Toggle the side bar (Ctrl+B)"
        onClick={toggleSlot}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <rect x="1.5" y="2.5" width="4.5" height="11" rx="2" fill="currentColor" opacity={slotOpen ? 0.85 : 0.25} />
        </svg>
      </button>

      {/*
        The search is a door, not a box: it opens the palette with sessions, files
        and commands merged, which is where the typing actually happens. A live
        input here would be a second implementation of the same list, one drag
        region away from the first.
      */}
      <div className="titlebar__search">
        <button
          className="titlebar__searchbox"
          aria-label="Search sessions, files and commands"
          onClick={() => openPalette('global')}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="6.8" cy="6.8" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10 10l3.6 3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span>Search sessions, files, commands…</span>
        </button>
      </div>

      <div className="titlebar__layout">
        {/*
          The switch the app is built around. Named rather than drawn, because it
          changes what the window is, which is worth a word.
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
                <rect
                  x="1.6"
                  y="2.6"
                  width="12.8"
                  height="10.8"
                  rx="2"
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
        <button
          className={`titlebar__split ${panelShown ? 'titlebar__split--on' : ''}`}
          aria-label="Toggle the panel"
          aria-pressed={panelShown}
          title="Toggle the panel (Ctrl+J)"
          onClick={togglePanel}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <rect
              x="1.5"
              y="2.5"
              width="13"
              height="11"
              rx="2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            {/* Filled while the region is open, outlined while it is not, so the
                icon reports the layout as well as changes it. */}
            <rect x="2.5" y="9" width="11" height="3.5" rx="1" fill="currentColor" opacity={panelShown ? 0.85 : 0.25} />
          </svg>
        </button>
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
