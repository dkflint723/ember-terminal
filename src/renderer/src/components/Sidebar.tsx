import { useStore } from '../state/store'
import { FileTree } from './FileTree'
import { SourceControl } from './SourceControl'

interface Props {
  onOpen: (filePath: string) => void
}

/**
 * The panel beside the activity bar. It owns the title and the resize handle so
 * every view inside it is just a body, and switching views cannot change the frame.
 */
export function Sidebar({ onOpen }: Props): React.JSX.Element {
  const view = useStore((s) => s.sidebarView)

  return (
    <div className="sidebar" data-view={view}>
      <div className="sidebar__title">{view === 'scm' ? 'Source Control' : 'Explorer'}</div>
      {view === 'scm' ? <SourceControl /> : <FileTree onOpen={onOpen} />}
    </div>
  )
}
