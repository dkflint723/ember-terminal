import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DirEntry } from '@shared/types'
import { useStore } from '../state/store'
import { decorationFor, decorationsByPath, statusClass } from '../state/git'

interface Props {
  /** Called with a file path when the user activates a row. */
  onOpen: (filePath: string) => void
}

/** Spelled out in the row's tooltip, since the letter alone is git's shorthand. */
const STATUS_WORD: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'conflicted',
  U: 'untracked'
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
  const notePathRenamed = useStore((s) => s.notePathRenamed)
  const notePathDeleted = useStore((s) => s.notePathDeleted)

  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  /** An in-place input: creating something new, or renaming what is already there. */
  const [draft, setDraft] = useState<{
    kind: 'file' | 'directory'
    dir: string
    name: string
    original: string | null
  } | null>(null)
  const [menu, setMenu] = useState<{
    path: string
    isDirectory: boolean
    x: number
    y: number
  } | null>(null)

  const gitStatus = useStore((s) => s.gitStatus)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activePane = activeTab ? panes[activeTab.activePaneId] : undefined
  const terminalCwd = activePane?.kind === 'terminal' ? activePane.cwd : null

  /** Start the picker where the user already is, which is nearly always right. */
  const openFolder = async (): Promise<void> => {
    const picked = await window.ember.openFolderDialog(root ?? terminalCwd ?? undefined)
    if (!picked) return
    setRoot(picked)
    // Dropped rather than kept: listings are cached by path, so coming back to a
    // folder later would otherwise show what was in it when it was last open.
    setChildren({})
    setExpanded(new Set())
  }

  // Rows are keyed by absolute path; git reports repository-relative ones.
  const decorations = useMemo(
    () =>
      decorationsByPath(
        gitStatus?.root ?? null,
        gitStatus?.staged ?? [],
        gitStatus?.changes ?? [],
        gitStatus?.conflicts ?? []
      ),
    [gitStatus]
  )

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

  /** Re-read a directory after something in it changed on disk. */
  const refresh = async (dirPath: string): Promise<void> => {
    setChildren((prev) => {
      const next = { ...prev }
      delete next[dirPath]
      return next
    })
    await load(dirPath)
  }

  const parentOf = (target: string): string => target.replace(/[\\/][^\\/]*$/, '')
  const joinPath = (dir: string, name: string): string =>
    `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`

  /** Where a new entry should go: inside a directory, or beside a file. */
  const containerFor = (target: string | null): string => {
    if (!target || !root) return root ?? ''
    const entry = Object.values(children).flat().find((e) => e.path === target)
    if (entry?.isDirectory) return target
    return parentOf(target)
  }

  const beginCreate = (kind: 'file' | 'directory'): void => {
    const dir = containerFor(menu?.path ?? selected)
    if (!dir) return
    // Opened first, so the input appears in the right place immediately.
    if (!expanded.has(dir) && dir !== root) toggle(dir)
    setDraft({ kind, dir, name: '', original: null })
    setMenu(null)
  }

  const commitDraft = async (): Promise<void> => {
    if (!draft) return
    const name = draft.name.trim()
    const { dir, original, kind } = draft
    setDraft(null)
    if (!name) return

    const target = joinPath(dir, name)
    const res = original
      ? await window.ember.renamePath(original, target)
      : await window.ember.createPath(target, kind)

    if (!res.ok) {
      setError(res.error)
      return
    }
    // Editors showing the old path have to travel with it, or their next save goes
    // to a file that no longer exists.
    if (original) await notePathRenamed(original, target)
    setError(null)
    await refresh(dir)
    // A new file is almost always about to be edited.
    if (!original && kind === 'file') onOpen(joinPath(dir, name))
  }

  const remove = async (target: string): Promise<void> => {
    setMenu(null)
    if (!window.confirm(`Move ${target.split(/[\\/]/).pop()} to the Recycle Bin?`)) return
    const res = await window.ember.trashPath(target)
    if (!res.ok) {
      setError(res.error)
      return
    }
    // An open tab is now the only copy of what was in there.
    notePathDeleted(target)
    setError(null)
    await refresh(parentOf(target))
  }

  const draftRow = (dirPath: string, depth: number): React.JSX.Element | null => {
    if (!draft || draft.dir !== dirPath || draft.original) return null
    return (
      <div className="tree__row tree__row--draft" style={{ paddingLeft: 6 + depth * 12 }}>
        <span className="tree__twisty">{draft.kind === 'directory' ? '▸' : ''}</span>
        <input
          className="tree__input"
          autoFocus
          value={draft.name}
          placeholder={draft.kind === 'directory' ? 'New folder' : 'New file'}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          onBlur={() => void commitDraft()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitDraft()
            if (e.key === 'Escape') setDraft(null)
          }}
        />
      </div>
    )
  }

  const rows = (dirPath: string, depth: number): React.JSX.Element[] => {
    const entries = children[dirPath] ?? []
    const out: React.JSX.Element[] = []

    const pending = draftRow(dirPath, depth)
    if (pending) out.push(<div key={`draft-${dirPath}`}>{pending}</div>)

    for (const entry of entries) {
      // A row being renamed becomes an input in place, rather than a dialog.
      if (draft?.original === entry.path) {
        out.push(
          <div
            key={`rename-${entry.path}`}
            className="tree__row tree__row--draft"
            style={{ paddingLeft: 6 + depth * 12 }}
          >
            <span className="tree__twisty">{entry.isDirectory ? '▸' : ''}</span>
            <input
              className="tree__input"
              autoFocus
              value={draft.name}
              spellCheck={false}
              onFocus={(e) => {
                // Select the stem, not the extension: renaming rarely changes it.
                const dot = draft.name.lastIndexOf('.')
                e.target.setSelectionRange(0, dot > 0 ? dot : draft.name.length)
              }}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onBlur={() => void commitDraft()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitDraft()
                if (e.key === 'Escape') setDraft(null)
              }}
            />
          </div>
        )
        continue
      }
      const open = expanded.has(entry.path)
      const status = decorationFor(decorations, entry.path)
      out.push(
        <button
          key={entry.path}
          className={`tree__row ${entry.hidden ? 'tree__row--hidden' : ''} ${
            status ? statusClass(status) : ''
          } ${selected === entry.path ? 'tree__row--selected' : ''}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          title={status ? `${entry.path} — ${STATUS_WORD[status] ?? status}` : entry.path}
          data-git={status ?? ''}
          onClick={() => {
            setSelected(entry.path)
            if (entry.isDirectory) toggle(entry.path)
            else onOpen(entry.path)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setSelected(entry.path)
            setMenu({ path: entry.path, isDirectory: entry.isDirectory, x: e.clientX, y: e.clientY })
          }}
        >
          <span className="tree__twisty">
            {entry.isDirectory ? (open ? '▾' : '▸') : ''}
          </span>
          <span className="tree__label">{entry.name}</span>
          {loading.has(entry.path) && <span className="tree__loading">…</span>}
          {status && <span className="tree__git">{status}</span>}
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
        {/* Without this the workspace could only be set by launching with a path or
            by inheriting the terminal's directory, so there was no way to move to a
            different project from inside the app. */}
        <button className="icon-btn" title="Open folder" onClick={() => void openFolder()}>
          🗀
        </button>
        <button
          className="icon-btn"
          title="New file"
          disabled={!root}
          onClick={() => beginCreate('file')}
        >
          ＋
        </button>
        <button
          className="icon-btn"
          title="New folder"
          disabled={!root}
          onClick={() => beginCreate('directory')}
        >
          ⊞
        </button>
        <button
          className="icon-btn"
          title="Collapse all"
          disabled={expanded.size === 0}
          onClick={() => setExpanded(new Set())}
        >
          ⊟
        </button>
        <button
          className="icon-btn"
          title={terminalCwd ? `Use ${terminalCwd}` : 'No terminal directory'}
          disabled={!terminalCwd || terminalCwd === root}
          onClick={() => {
            if (!terminalCwd) return
            setRoot(terminalCwd)
            setChildren({})
            setExpanded(new Set())
          }}
        >
          ⌂
        </button>
        <button
          className="icon-btn"
          title="Refresh"
          onClick={() => {
            setChildren({})
            setExpanded(new Set())
            if (root) void load(root)
          }}
        >
          ↻
        </button>
      </div>

      {/* Anchored to the pointer, and dismissed by anything else being clicked. */}
      {menu && (
        <>
          <div className="menu__scrim" onMouseDown={() => setMenu(null)} onContextMenu={(e) => {
            e.preventDefault()
            setMenu(null)
          }} />
          <div className="menu" style={{ left: menu.x, top: menu.y }}>
            <button className="menu__item" onClick={() => beginCreate('file')}>
              New File
            </button>
            <button className="menu__item" onClick={() => beginCreate('directory')}>
              New Folder
            </button>
            <div className="menu__rule" />
            <button
              className="menu__item"
              onClick={() => {
                const name = menu.path.split(/[\\/]/).pop() ?? ''
                setDraft({
                  kind: menu.isDirectory ? 'directory' : 'file',
                  dir: parentOf(menu.path),
                  name,
                  original: menu.path
                })
                setMenu(null)
              }}
            >
              Rename
            </button>
            <button className="menu__item menu__item--danger" onClick={() => void remove(menu.path)}>
              Delete
            </button>
            <div className="menu__rule" />
            <button
              className="menu__item"
              onClick={() => {
                void navigator.clipboard.writeText(menu.path)
                setMenu(null)
              }}
            >
              Copy Path
            </button>
            <button
              className="menu__item"
              onClick={() => {
                window.ember.revealPath(menu.path)
                setMenu(null)
              }}
            >
              Reveal in File Explorer
            </button>
          </div>
        </>
      )}

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
