import { useStore, workspaceRoot } from '../state/store'
import { FileTree } from './FileTree'
import { SourceControl } from './SourceControl'
import { GitHubPanel } from './GitHubPanel'
import { SearchPanel } from './SearchPanel'
import { ProblemsPanel } from './ProblemsPanel'
import { DebugPanel } from './DebugPanel'
import { ScriptRunner } from './ScriptRunner'
import { Outline } from './Outline'

interface Props {
  onOpen: (filePath: string) => void
  /** Opens a file and reveals a position, for a search result. */
  onOpenAt: (filePath: string, line: number, column: number) => void
}

const TITLES: Record<string, string> = {
  explorer: 'Explorer',
  search: 'Search',
  scm: 'Source Control',
  github: 'GitHub',
  problems: 'Problems',
  debug: 'Debug',
  run: 'Scripts'
}

/**
 * The panel beside the activity bar. It owns the title and the resize handle so
 * every view inside it is just a body, and switching views cannot change the frame.
 */
export function Sidebar({ onOpen, onOpenAt }: Props): React.JSX.Element {
  const view = useStore((s) => s.sidebarView)
  const treeRoot = useStore(workspaceRoot)

  /*
   * The explorer is titled by the workspace, not by itself. "EXPLORER" answered a
   * question nobody asked — the tree below makes what the view is self-evident —
   * while which project this window is holding is exactly what the header is for.
   */
  const project = treeRoot ? treeRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '' : ''
  const title = view === 'explorer' && project ? project : TITLES[view]

  /*
   * And every other view says which project it is describing.
   *
   * They used to have no folder to be named after, because a window had one
   * workspace and it was the explorer's. A session now carries its own, so
   * switching sessions moves search, source control, scripts and problems to
   * another project — and in IDE mode there is no session strip on screen, which
   * left "why is search finding nothing" with nothing on screen to answer it.
   */
  const showProject = view !== 'explorer' && project.length > 0

  return (
    <div className="sidebar" data-view={view}>
      <div className="sidebar__title">
        {title}
        {showProject && (
          <span className="sidebar__project" title={treeRoot ?? undefined}>
            {project}
          </span>
        )}
      </div>
      {view === 'search' && <SearchPanel onOpen={onOpenAt} />}
      {view === 'scm' && <SourceControl />}
      {view === 'github' && <GitHubPanel />}
      {view === 'problems' && <ProblemsPanel onOpen={onOpenAt} />}
      {view === 'debug' && <DebugPanel onOpenAt={onOpenAt} />}
      {view === 'run' && <ScriptRunner />}
      {view === 'explorer' && (
        <>
          <FileTree onOpen={onOpen} />
          <Outline />
        </>
      )}
    </div>
  )
}
