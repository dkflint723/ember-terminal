import { useEffect } from 'react'
import type { SessionLayout, SessionPane, SessionSnapshot } from '@shared/types'
import { useStore, type LayoutNode, type Pane, type Tab } from './store'

/**
 * Writing the workspace down, and putting it back.
 *
 * Saved on a debounce as things change rather than only on quit, because the case
 * that most needs a session file is the one where nothing gets to run on the way
 * out: a crash, a power cut, a forced restart.
 */
const SAVE_DEBOUNCE_MS = 1200
/** Unsaved buffers go in the file, so an enormous one is dropped rather than stored. */
const MAX_UNSAVED_BYTES = 4 * 1024 * 1024

/**
 * Diff panes are left out entirely.
 *
 * A diff is a view of two revisions at a moment — a staged change that has since
 * been committed, or a proposal from a Claude Code session that ended. Putting one
 * back would show a comparison that is no longer true, against a proposal nobody is
 * waiting on. They are pruned from the layout, not just skipped, or the tree would
 * refer to panes that were never restored.
 */
function pruneLayout(node: LayoutNode, keep: (paneId: string) => boolean): SessionLayout | null {
  if (node.type === 'leaf') return keep(node.paneId) ? { type: 'leaf', paneId: node.paneId } : null

  const children: SessionLayout[] = []
  const sizes: number[] = []
  node.children.forEach((child, i) => {
    const pruned = pruneLayout(child, keep)
    if (pruned) {
      children.push(pruned)
      sizes.push(node.sizes[i] ?? 1)
    }
  })

  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  const total = sizes.reduce((a, b) => a + b, 0)
  return { type: 'split', direction: node.direction, children, sizes: sizes.map((s) => s / total) }
}

function collect(node: SessionLayout, out: string[] = []): string[] {
  if (node.type === 'leaf') out.push(node.paneId)
  else node.children.forEach((c) => collect(c, out))
  return out
}

export function snapshot(): SessionSnapshot {
  const state = useStore.getState()
  const keep = (paneId: string): boolean => state.panes[paneId]?.kind !== 'diff'

  const tabs: SessionSnapshot['tabs'] = []
  const wanted = new Set<string>()
  for (const tab of state.tabs) {
    const root = pruneLayout(tab.root, keep)
    if (!root) continue
    const ids = collect(root)
    ids.forEach((id) => wanted.add(id))
    tabs.push({
      id: tab.id,
      root,
      activePaneId: ids.includes(tab.activePaneId) ? tab.activePaneId : ids[0]
    })
  }

  const panes: SessionPane[] = []
  for (const id of wanted) {
    const pane = state.panes[id]
    if (!pane) continue
    if (pane.kind === 'terminal') {
      panes.push({
        kind: 'terminal',
        id: pane.id,
        profileId: pane.profileId,
        cwd: pane.cwd,
        title: pane.title
      })
    } else if (pane.kind === 'editor') {
      panes.push({
        kind: 'editor',
        id: pane.id,
        activeIndex: pane.activeIndex,
        documents: pane.documents.map((doc) => ({
          filePath: doc.filePath,
          title: doc.title,
          language: doc.language,
          eol: doc.eol,
          // Only when it differs from disk, and only if it is a sane size to keep.
          ...(doc.dirty && doc.savedContent.length <= MAX_UNSAVED_BYTES
            ? { unsaved: currentText(doc.filePath) ?? doc.savedContent }
            : {})
        }))
      })
    }
  }

  return {
    version: 1,
    treeRoot: state.treeRoot,
    sidebarOpen: state.sidebarOpen,
    sidebarView: state.sidebarView,
    activeTabId: tabs.find((t) => t.id === state.activeTabId)?.id ?? tabs[0]?.id ?? null,
    tabs,
    panes
  }
}

/**
 * Reads a document's live text. Supplied by the editor pane rather than imported,
 * so this module does not pull Monaco into the boot bundle — a terminal-only
 * session should not pay to load an editor it never opens.
 *
 * It reads models, not the focused editor, so an unsaved change in a tab that is
 * not on screen is saved too.
 */
let readBuffer: ((filePath: string) => string | null) | null = null

export function setBufferReader(fn: (filePath: string) => string | null): void {
  readBuffer = fn
}

function currentText(filePath: string | null): string | null {
  if (!filePath || !readBuffer) return null
  try {
    return readBuffer(filePath)
  } catch {
    return null
  }
}

/** Rebuild the workspace. Returns false when there was nothing usable to restore. */
export async function restore(snapshotIn: SessionSnapshot | null): Promise<boolean> {
  if (!snapshotIn || snapshotIn.tabs.length === 0 || snapshotIn.panes.length === 0) return false

  const panes: Record<string, Pane> = {}
  const { languageForPath } = await import('../editor/monaco')

  /**
   * A directory in a session file is a claim about the past, and the past moves:
   * temp folders get cleaned up, projects get renamed, drives get unplugged. Each
   * one is checked once — several panes usually share a directory — and anything
   * gone is replaced rather than restored, or the shell fails to start and the
   * sidebar roots itself at nothing.
   */
  const existence = new Map<string, boolean>()
  const stillThere = async (dir: string): Promise<boolean> => {
    const known = existence.get(dir)
    if (known !== undefined) return known
    const found = await window.ember.directoryExists(dir)
    existence.set(dir, found)
    return found
  }

  for (const saved of snapshotIn.panes) {
    if (saved.kind === 'terminal') {
      const cwd = (await stillThere(saved.cwd)) ? saved.cwd : window.ember.homeDir
      panes[saved.id] = {
        id: saved.id,
        kind: 'terminal',
        profileId: saved.profileId,
        // The title follows the directory, so a fallback must not keep the old name.
        title: cwd === saved.cwd ? saved.title : cwd.split(/[\\/]/).filter(Boolean).pop() || 'Shell',
        cwd,
        blocks: [],
        mode: 'blocks',
        integration: 'pending',
        awaitingSecret: false,
        exited: false,
        exitCode: null
      }
      continue
    }

    // Editor documents are re-read from disk, so a file changed by something else
    // since the session was written comes back as it is now rather than as it was.
    const documents = []
    for (const doc of saved.documents) {
      let savedContent = ''
      if (doc.filePath) {
        const read = await window.ember.readFile(doc.filePath)
        // A file that has since been deleted or renamed is dropped rather than
        // restored as an empty buffer that would overwrite it if saved.
        if (!read.ok && doc.unsaved === undefined) continue
        savedContent = read.ok ? read.content : ''
      }
      documents.push({
        filePath: doc.filePath,
        title: doc.title,
        savedContent,
        language: doc.language || languageForPath(doc.filePath ?? ''),
        eol: doc.eol,
        dirty: doc.unsaved !== undefined && doc.unsaved !== savedContent
      })
      if (doc.unsaved !== undefined) pendingUnsaved.set(doc.filePath ?? '', doc.unsaved)
    }
    if (documents.length === 0) continue

    panes[saved.id] = {
      id: saved.id,
      kind: 'editor',
      documents,
      activeIndex: Math.min(saved.activeIndex, documents.length - 1),
      error: null
    }
  }

  // A layout referring to a pane that could not be rebuilt would render nothing,
  // so tabs are pruned to what actually exists.
  const tabs: Tab[] = []
  for (const tab of snapshotIn.tabs) {
    const root = pruneLayout(tab.root as LayoutNode, (id) => panes[id] !== undefined)
    if (!root) continue
    const ids = collect(root)
    tabs.push({
      id: tab.id,
      root: root as LayoutNode,
      activePaneId: ids.includes(tab.activePaneId) ? tab.activePaneId : ids[0]
    })
  }
  if (tabs.length === 0) return false

  // A root that has gone is dropped rather than restored: the explorer, source
  // control, the language servers and the Claude Code lockfile all key off it, and
  // every one of them would be pointing at nothing.
  const root =
    snapshotIn.treeRoot && (await stillThere(snapshotIn.treeRoot)) ? snapshotIn.treeRoot : null

  useStore.setState({
    panes,
    tabs,
    activeTabId: tabs.find((t) => t.id === snapshotIn.activeTabId)?.id ?? tabs[0].id,
    treeRoot: root,
    sidebarOpen: snapshotIn.sidebarOpen,
    sidebarView: snapshotIn.sidebarView
  })
  return true
}

/**
 * Unsaved text, waiting for its editor to mount. The pane creates Monaco's model,
 * so the content cannot be pushed in until it exists.
 */
export const pendingUnsaved = new Map<string, string>()

/** Save on a debounce whenever the shape of the workspace changes. */
export function useSessionAutosave(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return

    let timer: number | undefined
    const schedule = (): void => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => void window.ember.sessionSave(snapshot()), SAVE_DEBOUNCE_MS)
    }

    const unsubscribe = useStore.subscribe(schedule)
    // The last word, and the only one guaranteed to include a final edit: the
    // debounce may not have fired when the window goes away.
    const onLeave = (): void => void window.ember.sessionSave(snapshot())
    window.addEventListener('beforeunload', onLeave)
    window.addEventListener('pagehide', onLeave)

    return () => {
      if (timer) window.clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('beforeunload', onLeave)
      window.removeEventListener('pagehide', onLeave)
    }
  }, [enabled])
}
