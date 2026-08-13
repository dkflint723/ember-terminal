import { create } from 'zustand'
import { DEFAULT_SETTINGS, type GitStatus, type Settings, type ShellProfile } from '@shared/types'
import type { ResolvedTheme, ThemeSummary } from '@shared/theme'
import { DEFAULT_THEME } from '../terminal/theme'

/** One command and everything it printed — the unit the UI is built around. */
export interface Block {
  id: string
  command: string
  /** Serialized HTML of the command's output, filled in when it finishes. */
  output: string
  status: 'running' | 'done' | 'failed'
  exitCode: number | null
  cwd: string
  startedAt: number
  durationMs: number | null
  collapsed: boolean
  /**
   * True when the command took over the screen (vim, htop). We keep a
   * placeholder rather than a snapshot, since the final frame is meaningless
   * once the program has restored the screen.
   */
  interactive: boolean
}

export type PaneKind = 'terminal' | 'editor' | 'diff'

/** Which view the sidebar is showing, chosen from the activity bar. */
export type SidebarView = 'explorer' | 'scm'

/**
 * Whether this pane's shell reports command boundaries.
 *
 * `absent` is not an error state — it means the pane falls back to being an
 * ordinary full-screen terminal. Shells like cmd.exe have no integration hook at
 * all, and a user's own prompt can displace ours, so the block UI has to be
 * something the pane can do without.
 */
export type IntegrationState = 'pending' | 'ready' | 'absent'

interface BasePane {
  id: string
  kind: PaneKind
}

export interface TerminalPaneState extends BasePane {
  kind: 'terminal'
  profileId: string
  title: string
  cwd: string
  blocks: Block[]
  /** `raw` hands the keyboard straight to the pty for full-screen programs. */
  mode: 'blocks' | 'raw'
  integration: IntegrationState
  /**
   * The running program appears to be asking for a secret, so input must be
   * masked and kept out of history.
   */
  awaitingSecret: boolean
  exited: boolean
  exitCode: number | null
}

/** Reserved so the pane tree does not need reshaping when editors land. */
export interface EditorPaneState extends BasePane {
  kind: 'editor'
  filePath: string | null
  title: string
  dirty: boolean
  /** The text as loaded or last saved; compared against the buffer for dirtiness. */
  savedContent: string
  language: string
  eol: 'lf' | 'crlf'
  error: string | null
}

/**
 * Two revisions of one file, side by side. Read-only: the content is a snapshot
 * taken when the diff was opened, and editing a blob out of the object database is
 * not a thing git can accept back.
 */
export interface DiffPaneState extends BasePane {
  kind: 'diff'
  /** Repository-relative, as git names it. */
  filePath: string
  title: string
  original: string
  modified: string
  originalLabel: string
  modifiedLabel: string
  language: string
  staged: boolean
  /**
   * Set when Claude Code proposed this change and is blocked on a verdict. The
   * right-hand side is then not a revision that exists anywhere — it is what the
   * file would become — and the pane grows accept and reject controls.
   */
  proposal?: { tabName: string; targetPath: string }
}

export type Pane = TerminalPaneState | EditorPaneState | DiffPaneState

export type LayoutNode =
  | { type: 'leaf'; paneId: string }
  | { type: 'split'; direction: 'row' | 'column'; children: LayoutNode[]; sizes: number[] }

export interface Tab {
  id: string
  root: LayoutNode
  activePaneId: string
}

interface Store {
  tabs: Tab[]
  activeTabId: string | null
  panes: Record<string, Pane>
  profiles: ShellProfile[]
  settings: Settings
  theme: ResolvedTheme
  themes: ThemeSummary[]
  settingsOpen: boolean
  historyOpen: boolean
  sidebarOpen: boolean
  sidebarView: SidebarView
  /** Root of the file tree; null until a terminal reports a directory. */
  treeRoot: string | null
  /**
   * Last read of the repository containing the tree root, shared because both
   * sidebar views need it: source control lists it, the explorer colours by it.
   * Null when there is no repository, or before the first read.
   */
  gitStatus: GitStatus | null
  /** Command handed to a pane's input by history search, consumed on mount. */
  pendingInput: Record<string, string>

  setProfiles(p: ShellProfile[]): void
  applySettings(s: Settings): void
  setThemes(list: ThemeSummary[]): void
  setTheme(theme: ResolvedTheme): void
  toggleSettings(open?: boolean): void
  toggleHistory(open?: boolean): void
  toggleSidebar(open?: boolean): void
  /** Show a view, opening the sidebar; picking the one already shown closes it. */
  showSidebarView(view: SidebarView): void
  setTreeRoot(path: string): void
  setGitStatus(status: GitStatus | null): void
  setPendingInput(paneId: string, text: string): void
  clearPendingInput(paneId: string): void

  newTab(profileId: string, cwd?: string): string
  closeTab(tabId: string): void
  setActiveTab(tabId: string): void
  setActivePane(tabId: string, paneId: string): void

  splitPane(tabId: string, paneId: string, direction: 'row' | 'column'): string | null
  closePane(tabId: string, paneId: string): void
  setSizes(tabId: string, path: number[], sizes: number[]): void

  editorPane(paneId: string): EditorPaneState | null
  patchEditorPane(paneId: string, patch: Partial<EditorPaneState>): void
  /** Open (or re-focus) a read-only comparison of two revisions of one file. */
  openDiffInSplit(tabId: string, diff: Omit<DiffPaneState, 'id' | 'kind'>): string | null
  /** Replace the active pane of a tab with an editor showing this file. */
  openFileInSplit(
    tabId: string,
    file: { path: string; name: string; content: string; language: string; eol: 'lf' | 'crlf' }
  ): string | null

  terminalPane(paneId: string): TerminalPaneState | null
  patchPane(paneId: string, patch: Partial<TerminalPaneState>): void

  beginBlock(paneId: string, command: string): string
  patchBlock(paneId: string, blockId: string, patch: Partial<Block>): void
  toggleBlock(paneId: string, blockId: string): void
  clearBlocks(paneId: string): void
}

const uid = (): string => crypto.randomUUID()

function makeTerminalPane(profileId: string, cwd: string): TerminalPaneState {
  return {
    id: uid(),
    kind: 'terminal',
    profileId,
    title: 'Shell',
    cwd,
    blocks: [],
    mode: 'blocks',
    integration: 'pending',
    awaitingSecret: false,
    exited: false,
    exitCode: null
  }
}

/** Walk to a node by child-index path. Returns null if the path is stale. */
function nodeAt(root: LayoutNode, path: number[]): LayoutNode | null {
  let node: LayoutNode = root
  for (const i of path) {
    if (node.type !== 'split' || !node.children[i]) return null
    node = node.children[i]
  }
  return node
}

/**
 * Remove a leaf and collapse any split left with a single child, so the tree
 * never accumulates redundant one-way splits.
 */
function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === 'leaf') return node.paneId === paneId ? null : node

  const kept: LayoutNode[] = []
  const keptSizes: number[] = []
  node.children.forEach((child, i) => {
    const next = removeLeaf(child, paneId)
    if (next) {
      kept.push(next)
      keptSizes.push(node.sizes[i] ?? 1)
    }
  })

  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]

  const total = keptSizes.reduce((a, b) => a + b, 0)
  return {
    ...node,
    children: kept,
    sizes: keptSizes.map((s) => s / total)
  }
}

function collectPaneIds(node: LayoutNode, out: string[] = []): string[] {
  if (node.type === 'leaf') out.push(node.paneId)
  else node.children.forEach((c) => collectPaneIds(c, out))
  return out
}

/** Insert `newPaneId` beside `paneId`, reusing the parent split when directions match. */
function splitAt(
  node: LayoutNode,
  paneId: string,
  direction: 'row' | 'column',
  newPaneId: string
): LayoutNode {
  if (node.type === 'leaf') {
    if (node.paneId !== paneId) return node
    return {
      type: 'split',
      direction,
      children: [{ type: 'leaf', paneId }, { type: 'leaf', paneId: newPaneId }],
      sizes: [0.5, 0.5]
    }
  }

  const idx = node.children.findIndex((c) => c.type === 'leaf' && c.paneId === paneId)
  if (idx !== -1 && node.direction === direction) {
    // Same orientation: add a sibling and give it an even share.
    const children = [...node.children]
    children.splice(idx + 1, 0, { type: 'leaf', paneId: newPaneId })
    const share = 1 / children.length
    return { ...node, children, sizes: children.map(() => share) }
  }

  return { ...node, children: node.children.map((c) => splitAt(c, paneId, direction, newPaneId)) }
}

function replaceNode(node: LayoutNode, path: number[], next: LayoutNode): LayoutNode {
  if (path.length === 0) return next
  if (node.type !== 'split') return node
  const [head, ...rest] = path
  const children = node.children.map((c, i) => (i === head ? replaceNode(c, rest, next) : c))
  return { ...node, children }
}

export const useStore = create<Store>((set, get) => ({
  tabs: [],
  activeTabId: null,
  panes: {},
  profiles: [],
  settings: DEFAULT_SETTINGS,
  theme: DEFAULT_THEME,
  themes: [],
  settingsOpen: false,
  historyOpen: false,
  sidebarOpen: false,
  sidebarView: 'explorer',
  treeRoot: null,
  gitStatus: null,
  pendingInput: {},

  setProfiles: (profiles) => set({ profiles }),
  applySettings: (settings) => set({ settings }),
  setThemes: (themes) => set({ themes }),
  setTheme: (theme) => set({ theme }),
  toggleSettings: (open) => set((s) => ({ settingsOpen: open ?? !s.settingsOpen })),
  toggleHistory: (open) => set((s) => ({ historyOpen: open ?? !s.historyOpen })),
  toggleSidebar: (open) => set((s) => ({ sidebarOpen: open ?? !s.sidebarOpen })),

  showSidebarView: (view) =>
    set((s) => ({
      // Clicking the icon of the view already showing collapses the sidebar, which
      // is what makes the activity bar a toggle rather than only a selector.
      sidebarOpen: !(s.sidebarOpen && s.sidebarView === view),
      sidebarView: view
    })),

  setTreeRoot: (treeRoot) => set({ treeRoot }),
  setGitStatus: (gitStatus) => set({ gitStatus }),
  setPendingInput: (paneId, text) =>
    set((s) => ({ pendingInput: { ...s.pendingInput, [paneId]: text } })),
  clearPendingInput: (paneId) =>
    set((s) => {
      const next = { ...s.pendingInput }
      delete next[paneId]
      return { pendingInput: next }
    }),

  newTab: (profileId, cwd) => {
    const pane = makeTerminalPane(profileId, cwd ?? window.ember.homeDir)
    const tab: Tab = {
      id: uid(),
      root: { type: 'leaf', paneId: pane.id },
      activePaneId: pane.id
    }
    set((s) => ({
      panes: { ...s.panes, [pane.id]: pane },
      tabs: [...s.tabs, tab],
      activeTabId: tab.id
    }))
    return pane.id
  },

  closeTab: (tabId) => {
    const { tabs, panes } = get()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return

    for (const id of collectPaneIds(tab.root)) window.ember.kill(id)

    const nextPanes = { ...panes }
    for (const id of collectPaneIds(tab.root)) delete nextPanes[id]

    const idx = tabs.findIndex((t) => t.id === tabId)
    const nextTabs = tabs.filter((t) => t.id !== tabId)
    const nextActive =
      get().activeTabId === tabId
        ? (nextTabs[idx] ?? nextTabs[idx - 1])?.id ?? null
        : get().activeTabId

    set({ tabs: nextTabs, panes: nextPanes, activeTabId: nextActive })
  },

  setActiveTab: (activeTabId) => set({ activeTabId }),

  setActivePane: (tabId, paneId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t))
    })),

  splitPane: (tabId, paneId, direction) => {
    const { tabs, panes } = get()
    const tab = tabs.find((t) => t.id === tabId)
    const source = panes[paneId]
    if (!tab || !source || source.kind !== 'terminal') return null

    // Inherit the source pane's shell and directory: splitting is almost always
    // "another one of these, here".
    const pane = makeTerminalPane(source.profileId, source.cwd)
    set({
      panes: { ...panes, [pane.id]: pane },
      tabs: tabs.map((t) =>
        t.id === tabId
          ? { ...t, root: splitAt(t.root, paneId, direction, pane.id), activePaneId: pane.id }
          : t
      )
    })
    return pane.id
  },

  closePane: (tabId, paneId) => {
    const { tabs, panes } = get()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return

    const nextRoot = removeLeaf(tab.root, paneId)
    if (!nextRoot) {
      get().closeTab(tabId)
      return
    }

    window.ember.kill(paneId)
    const nextPanes = { ...panes }
    delete nextPanes[paneId]

    const remaining = collectPaneIds(nextRoot)
    set({
      panes: nextPanes,
      tabs: tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              root: nextRoot,
              activePaneId: remaining.includes(t.activePaneId) ? t.activePaneId : remaining[0]
            }
          : t
      )
    })
  },

  setSizes: (tabId, path, sizes) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const node = nodeAt(t.root, path)
        if (!node || node.type !== 'split') return t
        return { ...t, root: replaceNode(t.root, path, { ...node, sizes }) }
      })
    })),

  editorPane: (paneId) => {
    const p = get().panes[paneId]
    return p && p.kind === 'editor' ? p : null
  },

  patchEditorPane: (paneId, patch) =>
    set((s) => {
      const pane = s.panes[paneId]
      if (!pane || pane.kind !== 'editor') return s
      return { panes: { ...s.panes, [paneId]: { ...pane, ...patch } } }
    }),

  openFileInSplit: (tabId, file) => {
    const { tabs, panes } = get()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return null

    // Reuse an editor already showing this file rather than opening a duplicate.
    const existing = Object.values(panes).find(
      (p) => p.kind === 'editor' && p.filePath === file.path
    )
    if (existing) {
      set({
        tabs: tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: existing.id } : t))
      })
      return existing.id
    }

    const pane: EditorPaneState = {
      id: uid(),
      kind: 'editor',
      filePath: file.path,
      title: file.name,
      dirty: false,
      savedContent: file.content,
      language: file.language,
      eol: file.eol,
      error: null
    }

    // Editors open beside the current pane, so the terminal stays visible — the
    // point of editing here rather than in a separate window.
    set({
      panes: { ...panes, [pane.id]: pane },
      tabs: tabs.map((t) =>
        t.id === tabId
          ? { ...t, root: splitAt(t.root, tab.activePaneId, 'row', pane.id), activePaneId: pane.id }
          : t
      )
    })
    return pane.id
  },

  openDiffInSplit: (tabId, diff) => {
    const { tabs, panes } = get()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return null

    // One pane per file-and-side, refreshed in place. Opening the same diff twice
    // should show the current content, not a second pane holding a stale snapshot.
    const existing = Object.values(panes).find(
      (p) => p.kind === 'diff' && p.filePath === diff.filePath && p.staged === diff.staged
    )
    if (existing) {
      set({
        panes: { ...panes, [existing.id]: { ...existing, ...diff } },
        tabs: tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: existing.id } : t))
      })
      return existing.id
    }

    const pane: DiffPaneState = { id: uid(), kind: 'diff', ...diff }
    set({
      panes: { ...panes, [pane.id]: pane },
      tabs: tabs.map((t) =>
        t.id === tabId
          ? { ...t, root: splitAt(t.root, tab.activePaneId, 'row', pane.id), activePaneId: pane.id }
          : t
      )
    })
    return pane.id
  },

  terminalPane: (paneId) => {
    const p = get().panes[paneId]
    return p && p.kind === 'terminal' ? p : null
  },

  patchPane: (paneId, patch) =>
    set((s) => {
      const pane = s.panes[paneId]
      if (!pane || pane.kind !== 'terminal') return s
      return { panes: { ...s.panes, [paneId]: { ...pane, ...patch } } }
    }),

  beginBlock: (paneId, command) => {
    const id = uid()
    set((s) => {
      const pane = s.panes[paneId]
      if (!pane || pane.kind !== 'terminal') return s
      const block: Block = {
        id,
        command,
        output: '',
        status: 'running',
        exitCode: null,
        cwd: pane.cwd,
        startedAt: Date.now(),
        durationMs: null,
        collapsed: false,
        interactive: false
      }
      // Cap history so a long-lived pane cannot grow without bound.
      const blocks = [...pane.blocks, block].slice(-400)
      return { panes: { ...s.panes, [paneId]: { ...pane, blocks } } }
    })
    return id
  },

  patchBlock: (paneId, blockId, patch) =>
    set((s) => {
      const pane = s.panes[paneId]
      if (!pane || pane.kind !== 'terminal') return s
      return {
        panes: {
          ...s.panes,
          [paneId]: {
            ...pane,
            blocks: pane.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b))
          }
        }
      }
    }),

  toggleBlock: (paneId, blockId) => {
    const pane = get().terminalPane(paneId)
    const block = pane?.blocks.find((b) => b.id === blockId)
    if (!block) return
    get().patchBlock(paneId, blockId, { collapsed: !block.collapsed })
  },

  clearBlocks: (paneId) => get().patchPane(paneId, { blocks: [] })
}))
