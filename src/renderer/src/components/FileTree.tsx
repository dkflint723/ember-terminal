import { useCallback, useEffect, useState } from 'react'
import type { DirEntry } from '@shared/types'
import { useStore } from '../state/store'

interface Props {
  /** Called with a file path when the user activates a row. */
  onOpen: (filePath: string) => void
}

/**
 * A lazily-loaded directory tree.
 *
 * Children are fetched when a folder is expanded and cached per path, so opening a
 * repo root does not walk node_modules. Expansion state lives here rather than in
 * the store because it is view state — closing the sidebar should forget it.
 */
export function FileTree({ onOpen }: Props): React.JSX.Element {
  const root = useStore((s) => s.treeRoot)
  const setRoot = useStore((s) => s.setTreeRoot)
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)

  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<Set<string>>(new Set())

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activePane = activeTab ? panes[activeTab.activePaneId] : undefined
  const terminalCwd = activePane?.kind === 'terminal' ? activePane.cwd : null

  const load = useCallback(async (dirPath: string): Promise<void> => {
    setLoading((prev) => new Set(prev).add(dirPath))
    const res = await window.ember.readDir(dirPath)
    setLoading((prev) => {
      const next = new Set(prev)
      next.delete(dirPath)
      return next
    })
    if (!res.ok) {
      setError(res.error)
      return
    }
    setError(null)
    setChildren((prev) => ({ ...prev, [res.path]: res.entries }))
  }, [])

  // The root defaults to the active terminal's directory, but does not follow it
  // afterwards: re-rooting under someone mid-browse would be hostile.
  useEffect(() => {
    if (!root && terminalCwd) setRoot(terminalCwd)
  }, [root, terminalCwd, setRoot])

  useEffect(() => {
    if (root && !children[root]) void load(root)
  }, [root, children, load])

  const toggle = (dirPath: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else {
        next.add(dirPath)
        if (!children[dirPath]) void load(dirPath)
      }
      return next
    })
  }

  const rows = (dirPath: string, depth: number): React.JSX.Element[] => {
    const entries = children[dirPath] ?? []
    const out: React.JSX.Element[] = []

    for (const entry of entries) {
      const open = expanded.has(entry.path)
      out.push(
        <button
          key={entry.path}
          className={`tree__row ${entry.hidden ? 'tree__row--hidden' : ''}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          title={entry.path}
          onClick={() => (entry.isDirectory ? toggle(entry.path) : onOpen(entry.path))}
        >
          <span className="tree__twisty">
            {entry.isDirectory ? (open ? '▾' : '▸') : ''}
          </span>
          <span className="tree__label">{entry.name}</span>
          {loading.has(entry.path) && <span className="tree__loading">…</span>}
        </button>
      )
      if (entry.isDirectory && open) out.push(...rows(entry.path, depth + 1))
    }
    return out
  }

  const shortRoot = root ? (root.split(/[\\/]/).filter(Boolean).pop() ?? root) : null

  return (
    <div className="tree">
      <div className="tree__head">
        <span className="tree__root" title={root ?? ''}>
          {shortRoot ?? 'No folder'}
        </span>
        <button
          className="block__action"
          title={terminalCwd ? `Use ${terminalCwd}` : 'No terminal directory'}
          disabled={!terminalCwd || terminalCwd === root}
          onClick={() => {
            if (!terminalCwd) return
            setRoot(terminalCwd)
            setChildren({})
            setExpanded(new Set())
          }}
        >
          use cwd
        </button>
        <button
          className="block__action"
          title="Reload"
          onClick={() => {
            setChildren({})
            setExpanded(new Set())
            if (root) void load(root)
          }}
        >
          ↻
        </button>
      </div>

      <div className="tree__body">
        {error && <div className="tree__error">{error}</div>}
        {root && rows(root, 0)}
        {root && (children[root]?.length ?? 0) === 0 && !error && !loading.has(root) && (
          <div className="tree__empty">Empty folder</div>
        )}
      </div>
    </div>
  )
}
