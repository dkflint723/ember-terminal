import { useEffect, useRef, useState } from 'react'
import { isInside, pathKey, samePath } from '@shared/paths'
import { activeDocument, paneIdsOf, useStore, type CommandBlock, type Tab } from '../state/store'

/**
 * The sessions, as cards in the side slot.
 *
 * They were tabs in the title bar: 150px each, name only, and a menu that had to
 * hang off the strip to offer a second shell. Here each session has room to say
 * where it is standing and on which branch — which is what actually tells two
 * shells apart once both are called by the same folder name — and the strip's
 * clipped dropdown becomes an ordinary menu under the + button.
 *
 * Terminal mode only. The side slot is one slot: sessions when the window is a
 * terminal, files when it is an IDE.
 */
export function SessionList(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)
  const profiles = useStore((s) => s.profiles)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const newTab = useStore((s) => s.newTab)
  const toggleSettings = useStore((s) => s.toggleSettings)
  const workspaceGit = useStore((s) => s.gitStatus)
  const cwdGit = useStore((s) => s.cwdGit)

  const [filter, setFilter] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuWrap = useRef<HTMLDivElement>(null)

  // Escape or a click anywhere else closes the profile menu — a menu that only
  // closed when the pointer happened to leave it stayed on screen indefinitely.
  useEffect(() => {
    if (!menuOpen) return
    const dismiss = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e instanceof MouseEvent && menuWrap.current?.contains(e.target as Node)) return
      setMenuOpen(false)
    }
    window.addEventListener('keydown', dismiss, true)
    window.addEventListener('mousedown', dismiss, true)
    return () => {
      window.removeEventListener('keydown', dismiss, true)
      window.removeEventListener('mousedown', dismiss, true)
    }
  }, [menuOpen])

  const renameTab = useStore((s) => s.renameTab)
  const moveTab = useStore((s) => s.moveTab)
  /*
   * Drag state, by tab id rather than index: the list on screen is filtered,
   * so a position in it says nothing about a position in the store. Where the
   * drag began lives in a ref because nothing renders off it; which card is
   * hovered lives in state because the insertion mark does.
   */
  const dragFrom = useRef<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  /** Which card is being renamed, and the text as it is typed. */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const titleFor = (tab: Tab): string => {
    if (tab.name) return tab.name
    const pane = panes[tab.activePaneId]
    if (!pane) return 'Shell'
    if (pane.kind === 'diff') return pane.title || 'Untitled'
    if (pane.kind === 'editor') return activeDocument(pane).title || 'Untitled'
    // A pane with no integration never reports a cwd, so name it after its shell
    // rather than leaving the placeholder.
    if (pane.title === 'Shell') {
      return profiles.find((p) => p.id === pane.profileId)?.name ?? pane.title
    }
    return pane.title
  }

  /*
   * The card's second line: the branch where the session stands, read the same two
   * ways the status chips read it, so the card and the chip can never disagree
   * about the same shell. A session outside any repository names its shell instead
   * — that is the other fact that tells two cards apart.
   */
  const subtitleFor = (tab: Tab): { branch: boolean; text: string } => {
    const pane = panes[tab.activePaneId]
    if (pane?.kind !== 'terminal') return { branch: false, text: '' }
    const inWorkspace = workspaceGit
      ? isInside(workspaceGit.root, pane.cwd) || samePath(workspaceGit.root, pane.cwd)
      : false
    const git = inWorkspace ? workspaceGit : (cwdGit[pathKey(pane.cwd)] ?? null)
    if (git) return { branch: true, text: git.detached ? 'detached' : (git.branch ?? '') }
    return { branch: false, text: profiles.find((p) => p.id === pane.profileId)?.name ?? '' }
  }

  /*
   * What a card's shells are doing while you look elsewhere: a breathing dot
   * when a command is running anywhere in the tab, a red one when the last
   * command finished badly in a tab that is not on screen. The active tab shows
   * its failures as blocks, so the red mark stays off it — and restored blocks
   * from an earlier app session are records, not news.
   */
  const activityFor = (tab: Tab): 'running' | 'failed' | null => {
    let last: CommandBlock | null = null
    for (const id of paneIdsOf(tab)) {
      const pane = panes[id]
      if (pane?.kind !== 'terminal') continue
      for (const b of pane.blocks) {
        if (b.kind !== 'command') continue
        if (b.status === 'running') return 'running'
        if (!last || b.startedAt > last.startedAt) last = b
      }
    }
    if (tab.id === activeTabId) return null
    return last?.status === 'failed' && !last.restored ? 'failed' : null
  }

  const shown = tabs.filter((t) => {
    if (!filter.trim()) return true
    const sub = subtitleFor(t).text
    return `${titleFor(t)} ${sub}`.toLowerCase().includes(filter.trim().toLowerCase())
  })

  return (
    <aside className="sessions" aria-label="Sessions">
      <div className="sessions__top">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className="sessions__glass">
          <circle cx="6.8" cy="6.8" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10 10l3.6 3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          className="sessions__search"
          placeholder="Search tabs…"
          aria-label="Filter sessions"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.stopPropagation()
              setFilter('')
            }
          }}
        />
        <div className="sessions__newwrap" ref={menuWrap}>
          <button
            className="sessions__new"
            title="New tab"
            aria-label="New tab"
            onClick={() => {
              // A single profile needs no menu.
              if (profiles.length <= 1) newTab(profiles[0]?.id ?? '')
              else setMenuOpen((o) => !o)
            }}
          >
            ＋
          </button>
          {menuOpen && (
            <div className="titlebar__menu sessions__menu">
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
      </div>

      {/*
        A real tab list, as the title-bar strip was: arrows move the selection,
        Delete closes, and only the active card is a tab stop.
      */}
      <div className="sessions__list" role="tablist" aria-label="Terminal tabs">
        {shown.map((t) => {
          const sub = subtitleFor(t)
          const activity = activityFor(t)
          return (
            <div
              key={t.id}
              className={`sessions__card ${t.id === activeTabId ? 'sessions__card--on' : ''} ${dragOver === t.id && dragFrom.current !== t.id ? 'sessions__card--over' : ''}`}
              role="tab"
              draggable
              onDragStart={(e) => {
                dragFrom.current = t.id
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                // Without this the browser refuses the drop outright.
                e.preventDefault()
                if (dragOver !== t.id) setDragOver(t.id)
              }}
              onDragLeave={() => setDragOver((over) => (over === t.id ? null : over))}
              onDrop={(e) => {
                e.preventDefault()
                const held = dragFrom.current
                dragFrom.current = null
                setDragOver(null)
                if (!held || held === t.id) return
                // Indices resolved against the store's own order at drop time —
                // the filtered view's positions would move the wrong card.
                const all = useStore.getState().tabs
                const from = all.findIndex((x) => x.id === held)
                const to = all.findIndex((x) => x.id === t.id)
                if (from !== -1 && to !== -1) moveTab(from, to)
              }}
              onDragEnd={() => {
                dragFrom.current = null
                setDragOver(null)
              }}
              aria-selected={t.id === activeTabId}
              tabIndex={t.id === activeTabId ? 0 : -1}
              onMouseDown={() => setActiveTab(t.id)}
              onKeyDown={(e) => {
                const index = shown.findIndex((x) => x.id === t.id)
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const next = shown[index + (e.key === 'ArrowDown' ? 1 : -1)]
                  if (next) setActiveTab(next.id)
                } else if (e.key === 'Delete') {
                  e.preventDefault()
                  closeTab(t.id)
                }
              }}
            >
              <span className="sessions__icon" aria-hidden="true">&gt;_</span>
              <span className="sessions__text">
                {renaming === t.id ? (
                  <input
                    className="sessions__rename"
                    aria-label="Rename session"
                    autoFocus
                    value={draft}
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        renameTab(t.id, draft)
                        setRenaming(null)
                      }
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    onBlur={() => {
                      renameTab(t.id, draft)
                      setRenaming(null)
                    }}
                  />
                ) : (
                  <span
                    className="sessions__name"
                    onDoubleClick={(e) => {
                      // The card's own double-click would just select it twice;
                      // on the name it means "let me say what this one is".
                      e.stopPropagation()
                      setDraft(t.name ?? '')
                      setRenaming(t.id)
                    }}
                    title="Double-click to rename"
                  >
                    {titleFor(t)}
                  </span>
                )}
                {sub.text && (
                  <span className="sessions__branch">
                    {sub.branch && (
                      <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                          <circle cx="4.5" cy="3.5" r="1.6" />
                          <circle cx="4.5" cy="12.5" r="1.6" />
                          <circle cx="11.5" cy="3.5" r="1.6" />
                          <path d="M4.5 5.1v5.8M11.5 5.1v1.3a2.8 2.8 0 0 1-2.8 2.8H4.5" />
                        </g>
                      </svg>
                    )}
                    {sub.text}
                  </span>
                )}
              </span>
              {activity && (
                <span
                  className={`sessions__dot sessions__dot--${activity}`}
                  title={activity === 'running' ? 'A command is running' : 'The last command failed'}
                />
              )}
              <button
                className="sessions__close"
                title="Close tab"
                aria-label={`Close ${titleFor(t)}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                ✕
              </button>
            </div>
          )
        })}
        {shown.length === 0 && <div className="sessions__none">Nothing matches</div>}
      </div>
    </aside>
  )
}
