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
  /** Why the file list is empty, when the reason is not that the folder is. */
  const [listError, setListError] = useState<string | null>(null)

  // Handed to the command list, which is not a component and so has no props.
  useEffect(() => setPaletteFileOpener(onOpenFile), [onOpenFile])

  // Listed when the palette opens rather than kept current: a workspace file list
  // goes stale slowly, and walking the tree in the background forever to keep it
  // fresh would cost more than it saves.
  useEffect(() => {
    if (mode !== 'files' || !treeRoot) return
    let live = true
    setLoading(true)
    void window.ember.listFiles(treeRoot).then((found) => {
      if (!live) return
      setFiles(found.ok ? found.files : [])
      // "No files" is a fact about the folder; a failure is a fact about the app,
      // and the two used to look identical here.
      setListError(found.ok ? null : found.error)
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
        empty={
          loading
            ? 'Listing files…'
            : listError
              ? `Could not list files: ${listError}`
              : treeRoot
                ? 'No files'
                : 'Open a folder first'
        }
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

/**
 * Run one of Monaco's own actions against the editor the user is in.
 *
 * Driven through the action registry rather than reimplemented: formatting,
 * renaming and go-to-definition are all served by the language server through
 * providers the editor already knows about, so the work is in reaching the right
 * editor, not in doing the thing.
 *
 * The palette has closed by the time this runs, so focus is put back first —
 * several of these act on the cursor, and an action run against an editor that
 * does not have focus lands in the wrong place or nowhere at all.
 */
function runEditorAction(actionId: string): void {
  void (async () => {
    const { monaco } = await import('../editor/monaco')
    const editors = monaco.editor.getEditors()
    const editor = editors.find((e) => e.hasTextFocus()) ?? editors[0]
    if (!editor) return
    editor.focus()
    await editor.getAction(actionId)?.run()
  })()
}

/**
 * How a command opens a file, supplied by the app.
 *
 * The command list is a plain function rather than a component, so the one thing it
 * cannot do for itself is reach the app's own file-opening path — which knows about
 * language detection and where a new editor pane goes.
 */
let openFile: (filePath: string) => void = () => {}

export function setPaletteFileOpener(fn: (filePath: string) => void): void {
  openFile = fn
}

function commands(): Command[] {
  const s = useStore.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId)

  // splitPane falls back to the tab's own terminal when an editor is active, so
  // these no longer have to work that out for themselves.
  const split = (direction: 'row' | 'column', before = false): void => {
    if (tab) s.splitPane(tab.id, tab.activePaneId, direction, before)
  }

  // Editor commands are offered only when there is an editor to run them against,
  // rather than listed always and failing quietly when there is not.
  const hasEditor = Object.values(s.panes).some((p) => p.kind === 'editor')
  const editorCommands: Command[] = hasEditor
    ? [
        {
          id: 'editor.format',
          label: 'Format Document',
          hint: 'Shift+Alt+F',
          run: () => runEditorAction('editor.action.formatDocument')
        },
        {
          id: 'file.saveAll',
          label: 'File: Save All',
          hint: 'Ctrl+Alt+S',
          run: () => void s.saveAllDocuments()
        },
        {
          id: 'editor.gotoLine',
          label: 'Go to Line/Column',
          hint: 'Ctrl+G',
          run: () => runEditorAction('editor.action.gotoLine')
        },
        {
          id: 'editor.gotoSymbol',
          label: 'Go to Symbol in Editor',
          hint: 'Ctrl+Shift+O',
          run: () => runEditorAction('editor.action.quickOutline')
        },
        {
          id: 'editor.definition',
          label: 'Go to Definition',
          hint: 'F12',
          run: () => runEditorAction('editor.action.revealDefinition')
        },
        {
          id: 'editor.references',
          label: 'Go to References',
          hint: 'Shift+F12',
          run: () => runEditorAction('editor.action.goToReferences')
        },
        {
          id: 'editor.rename',
          label: 'Rename Symbol',
          hint: 'F2',
          run: () => runEditorAction('editor.action.rename')
        },
        {
          id: 'editor.comment',
          label: 'Toggle Line Comment',
          hint: 'Ctrl+/',
          run: () => runEditorAction('editor.action.commentLine')
        },
        {
          id: 'editor.wordWrap',
          label: 'View: Toggle Word Wrap',
          hint: 'Alt+Z',
          run: () => runEditorAction('editor.action.toggleWordWrap')
        }
      ]
    : []

  return [
    ...editorCommands,
    {
      id: 'file.openFolder',
      label: 'File: Open Folder…',
      run: () => {
        void (async () => {
          const picked = await window.ember.openFolderDialog(s.treeRoot ?? undefined)
          if (!picked) return
          s.setTreeRoot(picked)
          s.showSidebarView('explorer')
        })()
      }
    },
    // One command per folder rather than a mode of its own: the palette already
    // filters by typing, and a folder is found by its name either way.
    ...s.settings.recentFolders
      .filter((folder) => folder !== s.treeRoot)
      .map((folder) => ({
        id: `file.recent:${folder}`,
        label: `Open Recent: ${folder.split(/[\\/]/).filter(Boolean).pop() ?? folder}`,
        hint: folder,
        run: () => {
          s.setTreeRoot(folder)
          s.showSidebarView('explorer')
        }
      })),
    { id: 'view.explorer', label: 'View: Explorer', hint: 'Ctrl+B', run: () => s.showSidebarView('explorer') },
    { id: 'view.search', label: 'View: Search', hint: 'Ctrl+Shift+F', run: () => s.showSidebarView('search') },
    { id: 'view.scm', label: 'View: Source Control', hint: 'Ctrl+Shift+G', run: () => s.showSidebarView('scm') },
    { id: 'view.github', label: 'View: GitHub', hint: 'Ctrl+Shift+H', run: () => s.showSidebarView('github') },
    // Ctrl+O worked but was reachable only by knowing about it. A command that
    // exists and cannot be found is close to one that does not exist.
    {
      id: 'file.open',
      label: 'File: Open File…',
      hint: 'Ctrl+O',
      run: () => {
        void (async () => {
          const res = await window.ember.openFileDialog()
          if (res.ok) openFile(res.path)
        })()
      }
    },
    { id: 'view.problems', label: 'View: Problems', hint: 'Ctrl+Shift+M', run: () => s.showSidebarView('problems') },
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
      run: () => split('row')
    },
    {
      id: 'terminal.splitLeft',
      label: 'Terminal: Split Left',
      run: () => split('row', true)
    },
    {
      id: 'terminal.splitDown',
      label: 'Terminal: Split Down',
      hint: 'Ctrl+Shift+E',
      run: () => split('column')
    },
    {
      id: 'terminal.splitUp',
      label: 'Terminal: Split Up',
      run: () => split('column', true)
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
