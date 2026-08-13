import { useStore, type SidebarView } from '../state/store'

/**
 * The icon rail down the left edge, which chooses what the sidebar shows.
 *
 * Icons are inline SVG rather than a font or an image set: the app already themes
 * itself from CSS variables, and a path that inherits `currentColor` follows the
 * theme for free, including the three colourblind-safe ones.
 */
interface Entry {
  view: SidebarView
  label: string
  hint: string
  icon: React.JSX.Element
}

const ENTRIES: Entry[] = [
  {
    view: 'explorer',
    label: 'Explorer',
    hint: 'Explorer (Ctrl+B)',
    icon: (
      <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h3.2l1.4 1.8h6.4A1.5 1.5 0 0 1 17 5.3v9.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z" />
    )
  },
  {
    view: 'scm',
    label: 'Source Control',
    hint: 'Source Control (Ctrl+Shift+G)',
    icon: (
      <>
        <circle cx="5.5" cy="4.5" r="2.1" />
        <circle cx="5.5" cy="14.5" r="2.1" />
        <circle cx="14" cy="9.5" r="2.1" />
        <path d="M5.5 6.6v5.8M7.6 5.6h2.6a2 2 0 0 1 2 2v.6M12.2 11.4v.6a2 2 0 0 1-2 2H7.6" />
      </>
    )
  }
]

export function ActivityBar(): React.JSX.Element {
  const open = useStore((s) => s.sidebarOpen)
  const view = useStore((s) => s.sidebarView)
  const show = useStore((s) => s.showSidebarView)
  const status = useStore((s) => s.gitStatus)

  // One badge per changed path, not per list entry: a file that is both staged and
  // modified again is one thing needing attention, and VS Code counts it once.
  const pending = status
    ? new Set(
        [...status.staged, ...status.changes, ...status.conflicts].map((c) => c.path)
      ).size
    : 0

  return (
    <div className="activity" role="tablist" aria-label="Views">
      {ENTRIES.map((entry) => {
        const active = open && view === entry.view
        return (
          <button
            key={entry.view}
            role="tab"
            aria-selected={active}
            aria-label={entry.label}
            title={entry.hint}
            className={`activity__item ${active ? 'activity__item--active' : ''}`}
            data-view={entry.view}
            onClick={() => show(entry.view)}
          >
            <svg viewBox="0 0 20 20" className="activity__icon" aria-hidden="true">
              {entry.icon}
            </svg>
            {entry.view === 'scm' && pending > 0 && (
              <span className="activity__badge">{pending > 99 ? '99+' : pending}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
