import { useStore, type SidebarView } from '../state/store'
import { useProblems } from './ProblemsPanel'

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
    view: 'search',
    label: 'Search',
    hint: 'Search (Ctrl+Shift+F)',
    icon: (
      <>
        <circle cx="8.6" cy="8.6" r="5.1" />
        <path d="M12.4 12.4 L16.8 16.8" />
      </>
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
  },
  {
    view: 'github',
    label: 'GitHub',
    hint: 'GitHub (Ctrl+Shift+H)',
    icon: (
      // A pull request: a branch leaving a line and merging back into it.
      <>
        <circle cx="6" cy="4.5" r="2" />
        <circle cx="6" cy="15" r="2" />
        <circle cx="14" cy="9" r="2" />
        <path d="M6 6.5v6.5M14 11v1.5a2 2 0 0 1-2 2H8M14 7V5.5a2 2 0 0 0-2-2H8.2" />
      </>
    )
  },
  {
    view: 'problems',
    label: 'Problems',
    hint: 'Problems (Ctrl+Shift+M)',
    icon: (
      // A warning triangle: the one shape that means "something is wrong here"
      // without needing a colour to say it.
      <>
        <path d="M10 3.4 17.4 16.2H2.6Z" />
        <path d="M10 8v3.4M10 13.6v.1" />
      </>
    )
  }
]

export function ActivityBar(): React.JSX.Element {
  const open = useStore((s) => s.sidebarOpen)
  const view = useStore((s) => s.sidebarView)
  const show = useStore((s) => s.showSidebarView)
  const status = useStore((s) => s.gitStatus)
  const toggleSettings = useStore((s) => s.toggleSettings)
  const errorCount = useProblems().filter((p) => p.severity === 8).length

  // One badge per changed path, not per list entry: a file that is both staged and
  // modified again is one thing needing attention, and VS Code counts it once.
  const pending = status
    ? new Set(
        [...status.staged, ...status.changes, ...status.conflicts].map((c) => c.path)
      ).size
    : 0

  // A toolbar rather than a tab list: the rail holds a settings button as well as
  // the view switches, and a tab list may only contain tabs.
  return (
    <div className="activity" role="toolbar" aria-label="Views">
      {ENTRIES.map((entry) => {
        const active = open && view === entry.view
        return (
          <button
            key={entry.view}
            role="button"
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
            {/* Errors only. Warnings are worth reading but not worth a badge that
                never clears on a codebase that has always had a few. */}
            {entry.view === 'problems' && errorCount > 0 && (
              <span className="activity__badge activity__badge--bad">
                {errorCount > 99 ? '99+' : errorCount}
              </span>
            )}
          </button>
        )
      })}

      {/*
        Pinned to the bottom, where every editor with this shape puts it. Settings
        were previously reachable only through the new-tab menu or an undocumented
        Ctrl+, — which is a good way to ship a settings dialog nobody finds.
      */}
      <div className="activity__spacer" />
      <button
        className="activity__item"
        aria-label="Settings"
        title="Settings (Ctrl+,)"
        data-view="settings"
        onClick={() => toggleSettings(true)}
      >
        <svg viewBox="0 0 20 20" className="activity__icon" aria-hidden="true">
          <circle cx="10" cy="10" r="2.6" />
          <path d="M10 2.2v2M10 15.8v2M17.8 10h-2M4.2 10h-2M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4M15.5 15.5l-1.4-1.4M5.9 5.9L4.5 4.5" />
        </svg>
      </button>
    </div>
  )
}
