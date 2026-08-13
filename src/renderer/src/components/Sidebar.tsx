import { useStore } from '../state/store'
import { FileTree } from './FileTree'
import { SourceControl } from './SourceControl'
import { GitHubPanel } from './GitHubPanel'

interface Props {
  onOpen: (filePath: string) => void
}

const TITLES: Record<string, string> = {
  explorer: 'Explorer',
  scm: 'Source Control',
  github: 'GitHub'
}

/**
 * The panel beside the activity bar. It owns the title and the resize handle so
 * every view inside it is just a body, and switching views cannot change the frame.
 */
export function Sidebar({ onOpen }: Props): React.JSX.Element {
  const view = useStore((s) => s.sidebarView)

  return (
    <div className="sidebar" data-view={view}>
      <div className="sidebar__title">{TITLES[view]}</div>
      {view === 'scm' && <SourceControl />}
      {view === 'github' && <GitHubPanel />}
      {view === 'explorer' && <FileTree onOpen={onOpen} />}
    </div>
  )
}
