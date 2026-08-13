import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { QuickPick, type QuickPickItem } from './QuickPick'

interface Props {
  /** Opens a file and reveals a position; shared with search results. */
  onOpenFile: (filePath: string) => void
}

/**
 * Quick open and the command palette.
 *
 * Both live here because they are one overlay in two modes, which is also how they
 * behave: typing `>` in quick open is how VS Code users get to commands, and that
 * only works if the same box can be either.
 */
export function Palette({ onOpenFile }: Props): React.JSX.Element | null {
  const mode = useStore((s) => s.paletteMode)
  const close = useStore((s) => s.closePalette)
  const treeRoot = useStore((s) => s.treeRoot)
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  // Listed when the palette opens rather than kept current: a workspace file list
  // goes stale slowly, and walking the tree in the background forever to keep it
  // fresh would cost more than it saves.
  useEffect(() => {
    if (mode !== 'files' || !treeRoot) return
    let live = true
    setLoading(true)
    void window.ember.listFiles(treeRoot).then((found) => {
      if (!live) return
      setFiles(found)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [mode, treeRoot])

  if (!mode) return null

  if (mode === 'files') {
    const root = (treeRoot ?? '').replace(/\\/g, '/')
    const items: QuickPickItem[] = files.map((full) => {
      const relative = full.replace(/\\/g, '/').replace(`${root}/`, '')
      const parts = relative.split('/')
      return {
        id: full,
        label: parts.pop() ?? relative,
        detail: parts.join('/'),
        // Matched against the whole relative path, so `src/ed/pane` works.
        haystack: relative
      }
    })

    return (
      <QuickPick
        placeholder="Go to file…"
        items={items}
        empty={loading ? 'Listing files…' : treeRoot ? 'No files' : 'Open a folder first'}
        onPick={(item) => {
          close()
          onOpenFile(item.id)
        }}
        onClose={close}
      />
    )
  }

  return (
    <QuickPick
      placeholder="Type a command…"
      items={commandItems()}
      onPick={(item) => {
        close()
        // Run after the overlay is gone, so a command that moves focus is not
        // fighting an input that is still mounted.
        window.setTimeout(() => runCommand(item.id), 0)
      }}
      onClose={close}
    />
  )
}

/**
 * Everything the palette can do.
 *
 * Deliberately a flat list rather than a registry components contribute to: the app
 * is small enough that one readable list beats indirection, and a command that is
 * hard to find in this file would be hard to find in the palette too.
 */
interface Command {
  id: string
  label: string
  hint?: string
  run: () => void
}

function commands(): Command[] {
  const s = useStore.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId)

  return [
    { id: 'view.explorer', label: 'View: Explorer', hint: 'Ctrl+B', run: () => s.showSidebarView('explorer') },
    { id: 'view.search', label: 'View: Search', hint: 'Ctrl+Shift+F', run: () => s.showSidebarView('search') },
    { id: 'view.scm', label: 'View: Source Control', hint: 'Ctrl+Shift+G', run: () => s.showSidebarView('scm') },
    { id: 'view.github', label: 'View: GitHub', hint: 'Ctrl+Shift+H', run: () => s.showSidebarView('github') },
    { id: 'view.settings', label: 'Preferences: Settings', hint: 'Ctrl+,', run: () => s.toggleSettings(true) },
    { id: 'view.history', label: 'Terminal: Search History', hint: 'Ctrl+R', run: () => s.toggleHistory(true) },
    {
      id: 'terminal.new',
      label: 'Terminal: New Tab',
      hint: 'Ctrl+Shift+T',
      run: () => s.newTab(s.profiles[0]?.id ?? '')
    },
    {
      id: 'terminal.splitRight',
      label: 'Terminal: Split Right',
      hint: 'Ctrl+Shift+D',
      run: () => tab && s.splitPane(tab.id, tab.activePaneId, 'row')
    },
    {
      id: 'terminal.splitDown',
      label: 'Terminal: Split Down',
      hint: 'Ctrl+Shift+E',
      run: () => tab && s.splitPane(tab.id, tab.activePaneId, 'column')
    },
    {
      id: 'pane.close',
      label: 'Close Pane',
      hint: 'Ctrl+Shift+W',
      run: () => tab && s.closePane(tab.id, tab.activePaneId)
    },
    {
      id: 'ai.ask',
      label: 'Ask Claude',
      hint: 'Ctrl+K',
      run: () => {
        const target = Object.values(s.panes).find((p) => p.kind === 'terminal')?.id
        if (target) s.requestAsk(target)
      }
    }
  ]
}

function commandItems(): QuickPickItem[] {
  return commands().map((c) => ({ id: c.id, label: c.label, hint: c.hint }))
}

function runCommand(id: string): void {
  commands().find((c) => c.id === id)?.run()
}
