import { useStore } from '../state/store'
import { FileTree } from './FileTree'
import { SourceControl } from './SourceControl'
import { GitHubPanel } from './GitHubPanel'
import { SearchPanel } from './SearchPanel'

interface Props {
  onOpen: (filePath: string) => void
  /** Opens a file and reveals a position, for a search result. */
  onOpenAt: (filePath: string, line: number, column: number) => void
}

const TITLES: Record<string, string> = {
  explorer: 'Explorer',
  search: 'Search',
  scm: 'Source Control',
  github: 'GitHub'
}

/**
 * The panel beside the activity bar. It owns the title and the resize handle so
 * every view inside it is just a body, and switching views cannot change the frame.
 */
export function Sidebar({ onOpen, onOpenAt }: Props): React.JSX.Element {
  const view = useStore((s) => s.sidebarView)

  return (
    <div className="sidebar" data-view={view}>
      <div className="sidebar__title">{TITLES[view]}</div>
      {view === 'search' && <SearchPanel onOpen={onOpenAt} />}
      {view === 'scm' && <SourceControl />}
      {view === 'github' && <GitHubPanel />}
      {view === 'explorer' && <FileTree onOpen={onOpen} />}
    </div>
  )
}
