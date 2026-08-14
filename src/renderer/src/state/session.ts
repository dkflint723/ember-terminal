import { useEffect } from 'react'
import type { SessionLayout, SessionPane, SessionSnapshot } from '@shared/types'
import { useStore, type EditorDocument, type LayoutNode, type Pane, type Tab } from './store'

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
    // Both regions, saved separately. A tab with no shells left is not a tab; a tab
    // with no editors is simply one where nothing has been opened yet.
    const root = pruneLayout(tab.shells, keep)
    if (!root) continue
    const editors = tab.editors ? pruneLayout(tab.editors, keep) : null
    const ids = [...collect(root), ...(editors ? collect(editors) : [])]
    ids.forEach((id) => wanted.add(id))
    tabs.push({
      editors: editors ?? undefined,
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
          ...unsavedFor(doc)
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
 * The unsaved text to write down for a document, if there is any.
 *
 * Two things went wrong here before, both of which destroyed work.
 *
 * The text came from `currentText(...) ?? doc.savedContent`, and savedContent is
 * what is on disk — the one value that can never be the unsaved version. A restored
 * tab only gets a Monaco model once it is looked at, so a tab restored and left
 * alone had no model, fell through to the disk text, and wrote that down as its
 * "unsaved" content. On the next restore that reads back as identical to disk, so
 * the document is not dirty and the edit is gone. Two relaunches without clicking
 * the tab and the work had quietly evaporated.
 *
 * The size guard also measured savedContent rather than the text being stored, so
 * an edit was kept or dropped according to the size of the wrong string.
 *
 * When there is no model, the text carried in from the previous session is still
 * held in `pendingUnsaved` — unconsumed precisely because nobody opened the tab —
 * so it is passed along rather than invented.
 */
function unsavedFor(doc: EditorDocument): { unsaved?: string } {
  if (!doc.dirty) return {}
  const live = currentText(doc.filePath) ?? pendingUnsaved.get(doc.filePath ?? '')
  if (live === undefined || live === doc.savedContent) return {}
  return live.length <= MAX_UNSAVED_BYTES ? { unsaved: live } : {}
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
      // The line endings come back off the file too, not from the snapshot. They
      // are what the editor's buffer is normalised to and therefore what a save
      // writes back, so a file converted to CRLF between sessions would otherwise
      // be restored as LF, look unsaved the moment it was opened, and have every
      // line of it rewritten by the next Ctrl+S.
      let eol = doc.eol
      if (doc.filePath) {
        const read = await window.ember.readFile(doc.filePath)
        // A file that has since been deleted or renamed is dropped rather than
        // restored as an empty buffer that would overwrite it if saved.
        if (!read.ok && doc.unsaved === undefined) continue
        savedContent = read.ok ? read.content : ''
        if (read.ok) eol = read.eol
      }
      documents.push({
        filePath: doc.filePath,
        title: doc.title,
        savedContent,
        language: doc.language || languageForPath(doc.filePath ?? ''),
        eol,
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
    const alive = (id: string): boolean => panes[id] !== undefined
    const root = pruneLayout(tab.root as LayoutNode, alive)
    if (!root) continue
    // Sessions written before the editor area was its own region have no `editors`,
    // and come back as a tab whose files are simply not open — which is what the
    // old snapshot could still be honestly read as.
    const editors = tab.editors ? pruneLayout(tab.editors as LayoutNode, alive) : null
    const ids = [...collect(root), ...(editors ? collect(editors) : [])]
    tabs.push({
      id: tab.id,
      shells: root as LayoutNode,
      editors: (editors as LayoutNode) ?? null,
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
    /*
     * A session with files open comes back as an IDE.
     *
     * Restored editors are put straight into the tab's editor region rather than
     * going through openFile, so nothing along the way asked for the mode that
     * region is visible in. The window came back a plain terminal with its files
     * loaded, present in the state and on screen nowhere — which reads as the
     * restore having quietly dropped them.
     */
    mode: tabs.some((t) => t.editors) ? 'ide' : 'terminal',
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

/**
 * Whether unsaved text is actually being written down.
 *
 * Closing the window only needs to warn about unsaved work that closing would
 * lose. With session restore on and the snapshot succeeding, it would not be lost —
 * it comes back — so a warning there is a prompt for nothing, several times a day.
 * With restore off, or with the snapshot failing because it grew too large, the
 * work really is about to go, and that is the case worth interrupting for.
 */
let preserving = false
let failing = false

export function unsavedWorkIsPreserved(): boolean {
  return preserving && !failing
}

/** Save on a debounce whenever the shape of the workspace changes. */
export function useSessionAutosave(enabled: boolean): void {
  useEffect(() => {
    /*
     * Restore switched off means nothing is written down, so unsaved work really
     * does go when the window closes — which is what makes the prompt worth having.
     *
     * The file it had already written is also removed. Leaving it meant the tabs
     * and the unsaved buffer text from the last session sat on disk indefinitely
     * after someone had explicitly asked the app to stop remembering.
     */
    if (!enabled) {
      preserving = false
      window.ember.sessionClear()
      return
    }

    let timer: number | undefined
    /*
     * Said once, not every 1.2 seconds.
     *
     * The result used to be dropped, so a workspace that had stopped being saved —
     * usually because an unsaved buffer pushed the snapshot over the size limit —
     * looked exactly like one that was being saved, right up until the window
     * closed and took the work with it. Repeating the same complaint on every
     * keystroke would be its own problem, so it is reported when the outcome
     * changes rather than when it recurs.
     */
    const save = async (): Promise<void> => {
      const res = await window.ember.sessionSave(snapshot())
      preserving = res.ok
      if (!res.ok && !failing) {
        failing = true
        useStore
          .getState()
          .setNotice(
            `The workspace is no longer being saved: ${res.error ?? 'unknown error'}`,
            'error'
          )
      } else if (res.ok && failing) {
        failing = false
        useStore.getState().setNotice('The workspace is being saved again.')
      }
    }

    const schedule = (): void => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => void save(), SAVE_DEBOUNCE_MS)
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
