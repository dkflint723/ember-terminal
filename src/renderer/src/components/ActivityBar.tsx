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
    icon: <path d="M1.5 3.5h4.2l1.6 1.8h7.2v7.2h-13z" />
  },
  {
    view: 'search',
    label: 'Search',
    hint: 'Search (Ctrl+Shift+F)',
    icon: (
      <>
        <circle cx="6.8" cy="6.8" r="4.2" />
        <path d="M10 10l3.6 3.6" />
      </>
    )
  },
  {
    view: 'scm',
    label: 'Source Control',
    hint: 'Source Control (Ctrl+Shift+G)',
    icon: (
      <>
        <circle cx="4.5" cy="3.5" r="1.6" />
        <circle cx="4.5" cy="12.5" r="1.6" />
        <circle cx="11.5" cy="3.5" r="1.6" />
        <path d="M4.5 5.1v5.8M11.5 5.1v1.3a2.8 2.8 0 0 1-2.8 2.8H4.5" />
      </>
    )
  },
  {
    view: 'github',
    label: 'GitHub',
    hint: 'GitHub (Ctrl+Shift+H)',
    icon: (
      // A pull request, drawn on the same grid as the branch beside it: the
      // design ships no PR glyph, so this one borrows its circles and weight.
      <>
        <circle cx="4.5" cy="3.5" r="1.6" />
        <circle cx="4.5" cy="12.5" r="1.6" />
        <circle cx="11.5" cy="12.5" r="1.6" />
        <path d="M4.5 5.1v5.8M11.5 10.9V6.3a2.8 2.8 0 0 0-2.8-2.8H7.6" />
      </>
    )
  },
  {
    view: 'debug',
    label: 'Debug',
    hint: 'Debug (F5 runs the active file)',
    icon: (
      // A play triangle wearing a bug's back: run, but watched.
      <>
        <path d="M5 3.4v9.2L12.6 8z" />
        <path d="M3.2 5.2 1.6 4M3.2 8H1.2M3.2 10.8 1.6 12" />
      </>
    )
  },
  {
    view: 'run',
    label: 'Scripts',
    hint: 'Scripts (Ctrl+Shift+R)',
    icon: (
      // A play inside a list: the project's own commands, run from here.
      <>
        <path d="M2 3.5h6M2 8h4M2 12.5h4" />
        <path d="M9.5 5.5v7l5.5-3.5z" />
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
        <path d="M8 2.2 14.6 13.4H1.4z" />
        <path d="M8 6.6v3" />
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
            <svg viewBox="0 0 16 16" className="activity__icon" aria-hidden="true">
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
        <svg
          viewBox="0 0 16 16"
          className="activity__icon activity__icon--gear"
          aria-hidden="true"
        >
          {/* A cog, not a sun: the teeth grow out of the ring instead of floating
              around a dot, which is the whole difference between the two. */}
          <circle cx="8" cy="8" r="4.2" />
          <circle cx="8" cy="8" r="1.7" />
          <path d="M8 1.9v1.9M8 12.2v1.9M1.9 8h1.9M12.2 8h1.9M3.7 3.7l1.35 1.35M10.95 10.95l1.35 1.35M12.3 3.7l-1.35 1.35M5.05 10.95l-1.35 1.35" />
        </svg>
      </button>
    </div>
  )
}
