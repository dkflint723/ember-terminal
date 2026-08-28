import { useStore } from '../state/store'
import { FileTree } from './FileTree'
import { SourceControl } from './SourceControl'
import { GitHubPanel } from './GitHubPanel'
import { SearchPanel } from './SearchPanel'
import { ProblemsPanel } from './ProblemsPanel'
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
  problems: 'Problems'
}

/**
 * The panel beside the activity bar. It owns the title and the resize handle so
 * every view inside it is just a body, and switching views cannot change the frame.
 */
export function Sidebar({ onOpen, onOpenAt }: Props): React.JSX.Element {
  const view = useStore((s) => s.sidebarView)
  const treeRoot = useStore((s) => s.treeRoot)

  /*
   * The explorer is titled by the workspace, not by itself. "EXPLORER" answered a
   * question nobody asked — the tree below makes what the view is self-evident —
   * while which project this window is holding is exactly what the header is for.
   * The other views keep their names; they have no folder to be named after.
   */
  const title =
    view === 'explorer' && treeRoot
      ? treeRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || TITLES[view]
      : TITLES[view]

  return (
    <div className="sidebar" data-view={view}>
      <div className="sidebar__title">{title}</div>
      {view === 'search' && <SearchPanel onOpen={onOpenAt} />}
      {view === 'scm' && <SourceControl />}
      {view === 'github' && <GitHubPanel />}
      {view === 'problems' && <ProblemsPanel onOpen={onOpenAt} />}
      {view === 'explorer' && (
        <>
          <FileTree onOpen={onOpen} />
          <Outline />
        </>
      )}
    </div>
  )
}
