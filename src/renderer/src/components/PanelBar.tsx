import { useStore, type PanelView } from '../state/store'
import { useProblems } from './ProblemsPanel'

/**
 * The strip along the top of the bottom panel.
 *
 * Names the views the panel can show and lets it be closed, which is the pair of
 * things VS Code's panel header does. The terminal is first because in this app it
 * is what the panel exists for — the other two are read-only reports.
 */
const VIEWS: { id: PanelView; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'problems', label: 'Problems' },
  { id: 'output', label: 'Output' }
]

export function PanelBar(): React.JSX.Element {
  const view = useStore((s) => s.panelView)
  const showPanelView = useStore((s) => s.showPanelView)
  const togglePanel = useStore((s) => s.togglePanel)
  const problems = useProblems()

  return (
    <div className="panel__bar" role="tablist" aria-label="Panel views">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          className={`panel__tab ${v.id === view ? 'panel__tab--active' : ''}`}
          role="tab"
          aria-selected={v.id === view}
          onClick={() => showPanelView(v.id)}
        >
          {v.label}
          {/* The count belongs on the tab, so the panel can say how much is wrong
              without the view being the one on top. It runs with the label rather
              than sitting in the sidebar's badge — a tab is not a notification, and
              borrowing .scm__count meant the panel inherited whatever the section
              headings in the explorer happened to look like. */}
          {v.id === 'problems' && problems.length > 0 && (
            <span className="panel__count">{problems.length}</span>
          )}
        </button>
      ))}
      <span className="panel__spacer" />
      <button
        className="icon-btn"
        title="Close panel (Ctrl+J)"
        aria-label="Close panel"
        onClick={() => togglePanel(false)}
      >
        ✕
      </button>
    </div>
  )
}
