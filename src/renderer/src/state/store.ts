import { create } from 'zustand'
import { DEFAULT_SETTINGS, type GitStatus, type Settings, type ShellProfile } from '@shared/types'
import type { ResolvedTheme, ThemeSummary } from '@shared/theme'
import { DEFAULT_THEME } from '../terminal/theme'
import { lastSynced, noteSynced } from '../editor/synced'
import { isInside, pathKey, samePath } from '@shared/paths'

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
  /**
   * Ran in an earlier session and came back with the pane. Only used to draw the
   * line between then and now — the block is otherwise an ordinary one, and can be
   * copied, re-run and collapsed like any other.
   */
  restored?: boolean
}

export type PaneKind = 'terminal' | 'editor' | 'diff'

/** Which view the sidebar is showing, chosen from the activity bar. */
export type SidebarView = 'explorer' | 'search' | 'scm' | 'github' | 'problems'

/** A terminal, or the whole IDE around it. */
export type WorkspaceMode = 'terminal' | 'ide'

/** Which view the bottom panel is showing. */
export type PanelView = 'terminal' | 'problems' | 'output'

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

/** One open file. Several share a pane, switched between by the tab strip. */
export interface EditorDocument {
  filePath: string | null
  title: string
  dirty: boolean
  /** The text as loaded or last saved; compared against the buffer for dirtiness. */
  savedContent: string
  language: string
  eol: 'lf' | 'crlf'
}

export interface EditorPaneState extends BasePane {
  kind: 'editor'
  /** Never empty: a pane whose last document closes closes with it. */
  documents: EditorDocument[]
  activeIndex: number
  error: string | null
}

/** The document a pane is currently showing. */
export function activeDocument(pane: EditorPaneState): EditorDocument {
  return pane.documents[pane.activeIndex] ?? pane.documents[0]
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

/**
 * A tab holds two layouts, not one.
 *
 * Ember is a terminal that turns into an IDE, and the two modes want the same
 * panes in different places: in terminal mode the shells are the whole window and
 * there is nothing else, and in IDE mode the editors take the middle and the
 * shells drop into the panel along the bottom. Keeping them in one tree would
 * mean rebuilding it on every mode change, and a layout someone has arranged
 * would not survive the round trip. Each region keeps its own arrangement.
 */
export interface Tab {
  id: string
  /** Terminal panes: the whole window in terminal mode, the panel in IDE mode. */
  shells: LayoutNode
  /** Editor and diff panes, shown in the middle in IDE mode. Null until a file opens. */
  editors: LayoutNode | null
  activePaneId: string
}

/** Which of a tab's two layouts holds this pane. */
export function regionOf(tab: Tab, paneId: string): 'shells' | 'editors' | null {
  if (collectPaneIds(tab.shells).includes(paneId)) return 'shells'
  if (tab.editors && collectPaneIds(tab.editors).includes(paneId)) return 'editors'
  return null
}

/** Every pane in a tab, in both regions. */
export function paneIdsOf(tab: Tab): string[] {
  return [...collectPaneIds(tab.shells), ...(tab.editors ? collectPaneIds(tab.editors) : [])]
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
  /*
   * Terminal or IDE.
   *
   * The app opens as a terminal and nothing else, because that is what it is for.
   * One key turns it into the editor, sidebars and panel of an IDE, and the same
   * key turns it back. Both modes are the same session — the same shells, the
   * same open files — arranged differently.
   */
  mode: WorkspaceMode
  /** The bottom panel, and which of its views is on top. Only shown in IDE mode. */
  panelOpen: boolean
  panelView: PanelView
  /** The right-hand sidebar, which holds Claude. Only shown in IDE mode. */
  secondaryOpen: boolean
  /** Region sizes, as a fraction of the window. */
  panelHeight: number
  secondaryWidth: number
  /** Root of the file tree; null until a terminal reports a directory. */
  treeRoot: string | null
  /**
   * Last read of the repository containing the tree root, shared because both
   * sidebar views need it: source control lists it, the explorer colours by it.
   * Null when there is no repository, or before the first read.
   */
  gitStatus: GitStatus | null
  /**
   * The repository each shell is standing in, keyed by its directory.
   *
   * Separate from `gitStatus`, which describes the workspace: a terminal is often
   * somewhere else entirely, and in a plain terminal session there is no workspace
   * to describe. Keyed by directory rather than by pane so that several panes in one
   * project share a single answer.
   */
  cwdGit: Record<string, GitStatus | null>
  /** Why git could not be read at all, when that is not simply "no repository". */
  gitError: string | null
  /**
   * The commit message being written.
   *
   * In the store rather than in the panel because the sidebar unmounts a view when
   * you switch away from it, and a half-written commit message is exactly the kind
   * of thing someone leaves to go and look at a diff.
   */
  commitDraft: string
  /** Command handed to a pane's input by history search, consumed on mount. */
  pendingInput: Record<string, string>
  /**
   * A request to put a pane's composer into ask-Claude mode.
   *
   * Routed through the store because Ctrl+K is advertised in the composer footer
   * but can be pressed from anywhere — including an editor pane, where Monaco
   * would otherwise take it as a chord prefix and swallow the next keystroke. The
   * counter makes repeated presses distinguishable, so it still toggles.
   */
  askRequest: { paneId: string; n: number } | null
  /**
   * Bumped to open the model-and-effort switcher from somewhere that is not the
   * chip itself — the palette, for anyone who reaches for that first. A counter
   * rather than a flag, for the same reason as the ask request: asking twice has
   * to register as twice.
   */
  aiPickerRequest: number
  /** Which overlay is open: file quick-open, the command palette, or neither. */
  paletteMode: 'files' | 'commands' | null
  /**
   * Something the user needs told, with nowhere of its own to appear.
   *
   * Several things that can fail happen away from any particular panel — a
   * background save, the session file, writing settings — and each of them used to
   * discard its own result. Silence is the wrong answer for all of them: a
   * workspace that has quietly stopped being saved looks exactly like one that is
   * being saved.
   */
  notice: { text: string; tone: 'info' | 'error' } | null

  setProfiles(p: ShellProfile[]): void
  applySettings(s: Settings): void
  setThemes(list: ThemeSummary[]): void
  setTheme(theme: ResolvedTheme): void
  toggleSettings(open?: boolean): void
  /** Say something once. Passing null clears it. */
  setNotice(text: string | null, tone?: 'info' | 'error'): void
  toggleHistory(open?: boolean): void
  toggleSidebar(open?: boolean): void
  /** Show a view, opening the sidebar; picking the one already shown closes it. */
  showSidebarView(view: SidebarView): void
  /**
   * Switch between the terminal and the IDE. Passing a mode sets it outright.
   *
   * Anything that only makes sense in an IDE — opening a file, revealing a search
   * result — calls this with 'ide' rather than quietly doing nothing, so the app
   * arrives where the action can be seen.
   */
  setMode(mode?: WorkspaceMode): void
  togglePanel(open?: boolean): void
  /** Show a panel view, opening the panel; picking the one already shown closes it. */
  showPanelView(view: PanelView): void
  toggleSecondary(open?: boolean): void
  setRegionSize(region: 'panel' | 'secondary', fraction: number): void
  setTreeRoot(path: string): void
  setGitStatus(status: GitStatus | null): void
  /** File a directory's repository status, or the absence of one. */
  setCwdGit(cwd: string, status: GitStatus | null): void
  /** Why git could not be read, when the reason is not simply "no repository here". */
  setGitError(error: string | null): void
  setCommitDraft(text: string): void
  setPendingInput(paneId: string, text: string): void
  clearPendingInput(paneId: string): void
  requestAsk(paneId: string): void
  /** Open the Claude model-and-effort switcher. */
  requestAiPicker(): void
  openPalette(mode: 'files' | 'commands'): void
  closePalette(): void

  /** Opens a tab and returns its *pane* id, which is what callers need to write to. */
  newTab(profileId: string, cwd?: string): string
  /** `alreadyConfirmed` is for closePane, which has asked about the same documents. */
  closeTab(tabId: string, alreadyConfirmed?: boolean): void
  setActiveTab(tabId: string): void
  setActivePane(tabId: string, paneId: string): void

  /** `before` puts the new pane on the leading side: left of, or above, the source. */
  splitPane(
    tabId: string,
    paneId: string,
    direction: 'row' | 'column',
    before?: boolean
  ): string | null
  closePane(tabId: string, paneId: string): void
  /** The tab whose layout contains this pane, which is not always the active one. */
  tabIdForPane(paneId: string): string | null
  /** Titles of the unsaved documents held by these panes, for a close prompt. */
  dirtyDocumentsIn(paneIds: string[]): string[]
  setSizes(tabId: string, region: 'shells' | 'editors', path: number[], sizes: number[]): void

  editorPane(paneId: string): EditorPaneState | null
  patchEditorPane(paneId: string, patch: Partial<EditorPaneState>): void
  /** Update an open diff in place, after the thing it is showing has changed. */
  patchDiffPane(paneId: string, patch: Partial<DiffPaneState>): void
  /** Patch one document in a pane, by default the one on screen. */
  patchDocument(paneId: string, patch: Partial<EditorDocument>, index?: number): void
  /** Record what a file now looks like on disk, in every pane showing that file. */
  settleSaved(filePath: string, content: string, dirty: boolean): void
  setActiveDocument(paneId: string, index: number): void
  /** Close a tab; closing the last one closes the pane with it. */
  closeDocument(tabId: string, paneId: string, index: number): void
  /** Move an editor tab within its pane, keeping the same document active. */
  moveDocument(paneId: string, from: number, to: number): void
  /** Re-read these files into any editor showing them, leaving edited ones alone. */
  reloadFromDisk(paths: string[]): Promise<void>
  /** Follow a renamed file or folder, so open editors keep pointing at it. */
  notePathRenamed(from: string, to: string): Promise<void>
  /** Mark editors for a deleted file or folder as holding the only copy left. */
  notePathDeleted(target: string): void
  /** Write every edited document to disk, including ones not on screen. */
  saveAllDocuments(): Promise<{ saved: number; failed: number }>
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

/**
 * Ask before closing something that holds unsaved work.
 *
 * In the store rather than in a component because every way of closing converges
 * here, and the one that did ask was the only one anybody had thought about.
 * Returns true when there is nothing to lose or the user accepted losing it.
 */
function confirmDiscarding(titles: string[]): boolean {
  if (titles.length === 0) return true
  const names = titles.slice(0, 4).join(', ')
  const rest = titles.length > 4 ? ` and ${titles.length - 4} more` : ''
  return window.confirm(
    `${names}${rest} ${titles.length === 1 ? 'has' : 'have'} unsaved changes. Close anyway?`
  )
}

export function collectPaneIds(node: LayoutNode, out: string[] = []): string[] {
  if (node.type === 'leaf') out.push(node.paneId)
  else node.children.forEach((c) => collectPaneIds(c, out))
  return out
}

/**
 * Insert `newPaneId` beside `paneId`, reusing the parent split when directions
 * match. `before` puts the new pane on the leading side — which is what makes
 * "split left" and "split up" different from their opposites rather than just
 * differently worded.
 */
function splitAt(
  node: LayoutNode,
  paneId: string,
  direction: 'row' | 'column',
  newPaneId: string,
  before = false
): LayoutNode {
  if (node.type === 'leaf') {
    if (node.paneId !== paneId) return node
    const self: LayoutNode = { type: 'leaf', paneId }
    const added: LayoutNode = { type: 'leaf', paneId: newPaneId }
    return {
      type: 'split',
      direction,
      children: before ? [added, self] : [self, added],
      sizes: [0.5, 0.5]
    }
  }

  const idx = node.children.findIndex((c) => c.type === 'leaf' && c.paneId === paneId)
  if (idx !== -1 && node.direction === direction) {
    // Same orientation: add a sibling and give it an even share.
    const children = [...node.children]
    children.splice(before ? idx : idx + 1, 0, { type: 'leaf', paneId: newPaneId })
    const share = 1 / children.length
    return { ...node, children, sizes: children.map(() => share) }
  }

  return {
    ...node,
    children: node.children.map((c) => splitAt(c, paneId, direction, newPaneId, before))
  }
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
  // A terminal until asked to be more than one.
  mode: 'terminal',
  panelOpen: true,
  panelView: 'terminal',
  secondaryOpen: false,
  panelHeight: 0.35,
  secondaryWidth: 0.26,
  treeRoot: null,
  gitStatus: null,
  cwdGit: {},
  gitError: null,
  commitDraft: '',
  pendingInput: {},
  askRequest: null,
  aiPickerRequest: 0,
  paletteMode: null,
  notice: null,

  setProfiles: (profiles) => set({ profiles }),
  applySettings: (settings) => set({ settings }),
  setThemes: (themes) => set({ themes }),
  setTheme: (theme) => set({ theme }),
  toggleSettings: (open) => set((s) => ({ settingsOpen: open ?? !s.settingsOpen })),

  setNotice: (text, tone = 'info') => set({ notice: text === null ? null : { text, tone } }),
  toggleHistory: (open) => set((s) => ({ historyOpen: open ?? !s.historyOpen })),
  toggleSidebar: (open) => set((s) => ({ sidebarOpen: open ?? !s.sidebarOpen })),

  showSidebarView: (view) =>
    set((s) => ({
      // Clicking the icon of the view already showing collapses the sidebar, which
      // is what makes the activity bar a toggle rather than only a selector.
      sidebarOpen: !(s.sidebarOpen && s.sidebarView === view),
      sidebarView: view
    })),

  /*
   * Entering the IDE opens the explorer if nothing else is open, because an IDE
   * with every region collapsed is a terminal with extra steps — and the point of
   * the switch is to see the difference it made.
   */
  setMode: (mode) =>
    set((s) => {
      const next = mode ?? (s.mode === 'ide' ? 'terminal' : 'ide')
      if (next === s.mode) return s
      const bare = next === 'ide' && !s.sidebarOpen && !s.secondaryOpen
      return { mode: next, sidebarOpen: bare ? true : s.sidebarOpen }
    }),

  togglePanel: (open) => set((s) => ({ panelOpen: open ?? !s.panelOpen })),

  showPanelView: (view) =>
    set((s) => ({
      panelOpen: !(s.panelOpen && s.panelView === view),
      panelView: view
    })),

  toggleSecondary: (open) => set((s) => ({ secondaryOpen: open ?? !s.secondaryOpen })),

  // Clamped, because a region dragged to the edge of the window cannot be dragged
  // back — there is nothing left of it to take hold of.
  setRegionSize: (region, fraction) =>
    set(() => {
      const size = Math.min(0.8, Math.max(0.12, fraction))
      return region === 'panel' ? { panelHeight: size } : { secondaryWidth: size }
    }),

  setTreeRoot: (treeRoot) => {
    // Servers are started once per language and told their root in the handshake,
    // so moving the workspace has to be passed on or they go on answering about
    // the folder that was open before.
    if (treeRoot && get().treeRoot !== treeRoot) {
      window.ember.lspSetRoot(treeRoot)
      // Recorded here rather than at each place that opens a folder, so every route
      // in — the picker, the palette, the terminal's directory — is remembered.
      void window.ember.noteRecentFolder(treeRoot).then((next) => get().applySettings(next))
    }
    set({ treeRoot })
  },
  setGitStatus: (gitStatus) => set({ gitStatus }),

  setCwdGit: (cwd, status) =>
    set((s) => {
      const key = pathKey(cwd)
      // Written only when the answer actually changed. This is polled, and a store
      // that publishes an identical object every three seconds re-renders every
      // pane and re-schedules the session write for nothing.
      const before = s.cwdGit[key]
      if (before === status) return {}
      if (before && status && before.branch === status.branch && before.root === status.root) {
        const count = (g: GitStatus): number =>
          g.staged.length + g.changes.length + g.conflicts.length
        if (count(before) === count(status) && before.ahead === status.ahead) return {}
      }
      return { cwdGit: { ...s.cwdGit, [key]: status } }
    }),
  setGitError: (gitError) => set({ gitError }),
  setCommitDraft: (commitDraft) => set({ commitDraft }),
  openPalette: (paletteMode) => set({ paletteMode }),
  closePalette: () => set({ paletteMode: null }),

  requestAsk: (paneId) =>
    set((s) => ({ askRequest: { paneId, n: (s.askRequest?.n ?? 0) + 1 } })),

  requestAiPicker: () => set((s) => ({ aiPickerRequest: s.aiPickerRequest + 1 })),

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
      shells: { type: 'leaf', paneId: pane.id },
      editors: null,
      activePaneId: pane.id
    }
    set((s) => ({
      panes: { ...s.panes, [pane.id]: pane },
      tabs: [...s.tabs, tab],
      activeTabId: tab.id
    }))
    return pane.id
  },

  closeTab: (tabId, alreadyConfirmed = false) => {
    const { tabs, panes } = get()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    // A tab can hold several editors, so this asks about all of them at once
    // rather than once per pane on the way down. Skipped when closePane has
    // already asked about the same documents on its way here.
    if (!alreadyConfirmed && !confirmDiscarding(get().dirtyDocumentsIn(paneIdsOf(tab)))) {
      return
    }

    for (const id of paneIdsOf(tab)) window.ember.kill(id)

    const nextPanes = { ...panes }
    for (const id of paneIdsOf(tab)) delete nextPanes[id]

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

  splitPane: (tabId, paneId, direction, before = false) => {
    const { tabs, panes } = get()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return null

    /*
     * A split gives you another of whatever you were looking at.
     *
     * It used to mean "another shell" no matter what had focus, so asking for a
     * split from an editor moved a terminal somewhere else in the tab — an answer
     * to a question nobody had asked, and no way at all to put two files side by
     * side. An editor now splits into an editor on the same file.
     *
     * Two views of one file are safe because they are genuinely one file: the
     * buffer is a Monaco model keyed by URI, so both edit the same text, and
     * `settleSaved` keeps every pane's record of what is on disk in step. What is
     * copied below is only this pane's view of the document, not the text.
     */
    const from = panes[paneId]
    if (from?.kind === 'editor') {
      const document = activeDocument(from)
      if (!document) return null
      const pane: EditorPaneState = {
        id: uid(),
        kind: 'editor',
        documents: [{ ...document }],
        activeIndex: 0,
        error: null
      }
      set({
        panes: { ...panes, [pane.id]: pane },
        tabs: tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                editors: t.editors
                  ? splitAt(t.editors, from.id, direction, pane.id, before)
                  : { type: 'leaf', paneId: pane.id },
                activePaneId: pane.id
              }
            : t
        )
      })
      return pane.id
    }

    // A terminal split duplicates a shell. Asked for from anything else — a diff,
    // say — fall back to the tab's own terminal rather than doing nothing at all.
    const here = new Set(paneIdsOf(tab))
    const source =
      panes[paneId]?.kind === 'terminal'
        ? panes[paneId]
        : Object.values(panes).find((p) => p.kind === 'terminal' && here.has(p.id))
    if (!source || source.kind !== 'terminal') return null

    // Inherit the source pane's shell and directory: splitting is almost always
    // "another one of these, here".
    const pane = makeTerminalPane(source.profileId, source.cwd)
    set({
      panes: { ...panes, [pane.id]: pane },
      tabs: tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              shells: splitAt(t.shells, source.id, direction, pane.id, before),
              activePaneId: pane.id
            }
          : t
      )
    })
    return pane.id
  },

  tabIdForPane: (paneId) =>
    get().tabs.find((t) => paneIdsOf(t).includes(paneId))?.id ?? null,

  /*
   * Counted once per file, not once per view of it.
   *
   * A file can be open in two panes — that is what splitting an editor does — and
   * both hold the same buffer. Listing them separately would warn about two
   * unsaved files when there is one, and name it twice in the same sentence.
   */
  dirtyDocumentsIn: (paneIds) => {
    const panes = get().panes
    const seen = new Set<string>()
    const out: string[] = []
    for (const id of paneIds) {
      const pane = panes[id]
      if (pane?.kind !== 'editor') continue
      for (const doc of pane.documents) {
        if (!doc.dirty) continue
        const key = doc.filePath ? pathKey(doc.filePath) : `${pane.id}:${doc.title}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(doc.title)
      }
    }
    return out
  },

  closePane: (tabId, paneId) => {
    const { tabs, panes } = get()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    /*
     * Ask before taking unsaved work with it.
     *
     * The tab strip's own close button asked, but nothing else did — Close Pane,
     * Ctrl+Shift+W and closing a whole tab all went straight through and removed
     * editors holding unsaved edits without a word. The check belongs here because
     * this is where every one of those paths converges.
     */
    if (!confirmDiscarding(get().dirtyDocumentsIn([paneId]))) return
    // Closing a pane through the wrong tab used to remove it from the pane map and
    // kill its process while the tab that really owns it kept a leaf pointing at it,
    // leaving that tab with a hole where a pane should be.
    const region = regionOf(tab, paneId)
    if (!region) return

    const from = region === 'shells' ? tab.shells : tab.editors!
    const nextRoot = removeLeaf(from, paneId)

    /*
     * The last editor closing empties the middle; the last shell closing ends the
     * tab. They are not the same thing: a tab is a shell that may also have files
     * open, so closing every file leaves a working terminal, while closing every
     * terminal leaves nothing for the tab to be.
     */
    if (!nextRoot && region === 'shells') {
      // Already asked above, about the only pane this tab had.
      get().closeTab(tabId, true)
      return
    }

    window.ember.kill(paneId)
    const nextPanes = { ...panes }
    delete nextPanes[paneId]

    set({
      panes: nextPanes,
      tabs: tabs.map((t) => {
        if (t.id !== tabId) return t
        const next: Tab =
          region === 'shells' ? { ...t, shells: nextRoot! } : { ...t, editors: nextRoot }
        const remaining = paneIdsOf(next)
        return {
          ...next,
          activePaneId: remaining.includes(next.activePaneId) ? next.activePaneId : remaining[0]
        }
      })
    })
  },

  setSizes: (tabId, region, path, sizes) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const root = region === 'shells' ? t.shells : t.editors
        if (!root) return t
        const node = nodeAt(root, path)
        if (!node || node.type !== 'split') return t
        const next = replaceNode(root, path, { ...node, sizes })
        return region === 'shells' ? { ...t, shells: next } : { ...t, editors: next }
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

  patchDiffPane: (paneId, patch) =>
    set((s) => {
      const pane = s.panes[paneId]
      if (!pane || pane.kind !== 'diff') return s
      return { panes: { ...s.panes, [paneId]: { ...pane, ...patch } } }
    }),

  openFileInSplit: (tabId, file) => {
    const { tabs, panes } = get()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return null

    // Opening a file is a request to be an IDE. Putting it in a region that is not
    // on screen would look exactly like nothing happening.
    get().setMode('ide')

    const document: EditorDocument = {
      filePath: file.path,
      title: file.name,
      dirty: false,
      savedContent: file.content,
      language: file.language,
      eol: file.eol
    }

    /**
     * An editor already showing this file wins: opening the same path twice should
     * go to it rather than make a second copy that can diverge.
     *
     * Which tab it is in matters. Marking a pane active in a tab whose layout does
     * not contain it leaves that tab pointing at something it cannot render — the
     * file appears not to open at all, and the tab can no longer be split, because
     * splitting works from the active pane. So a pane found elsewhere is revealed
     * by switching to its own tab. The current tab is searched first so a file open
     * in two tabs reveals the copy already in front of the user.
     */
    for (const candidate of [tab, ...tabs.filter((t) => t.id !== tabId)]) {
      const here = new Set(paneIdsOf(candidate))
      for (const pane of Object.values(panes)) {
        if (pane.kind !== 'editor' || !here.has(pane.id)) continue
        const index = pane.documents.findIndex((d) => samePath(d.filePath, file.path))
        if (index === -1) continue
        /*
         * Opening a file is also the moment to notice it changed.
         *
         * Every caller reads the file before calling this, and revealing an already
         * open tab used to throw that text away — which is the stale-buffer overwrite
         * in its most ordinary form. Something rewrites the file, the user clicks it
         * in the explorer to see the new version, gets the old one with no unsaved
         * marker, and saves over it. Carrying `savedContent` forward is enough on its
         * own: the editor pane reconciles its buffer against it, bringing an untouched
         * one up to date and marking an edited one unsaved against the new content.
         */
        const documents = pane.documents.map((d, i) =>
          i === index ? { ...d, savedContent: file.content, eol: file.eol } : d
        )
        set({
          panes: { ...panes, [pane.id]: { ...pane, documents, activeIndex: index } },
          tabs: tabs.map((t) => (t.id === candidate.id ? { ...t, activePaneId: pane.id } : t)),
          activeTabId: candidate.id
        })
        return pane.id
      }
    }

    // Otherwise it becomes a tab in this tab's editor pane if there is one. Only
    // the first file opens a split — after that the terminal keeps the space it
    // has, which is the point of tabs.
    const here = new Set(paneIdsOf(tab))
    /*
     * The focused pane first, and only then the first one found.
     *
     * With the editor split in two, a file opened while the right half has focus
     * belongs in the right half. Taking the first editor pane in the tab put every
     * file into the left one regardless of where the user was working, which makes
     * a split editor almost useless — you cannot put a second file beside the first.
     */
    const focused = panes[tab.activePaneId]
    const host =
      focused?.kind === 'editor' && here.has(focused.id)
        ? focused
        : Object.values(panes).find(
            (p): p is EditorPaneState => p.kind === 'editor' && here.has(p.id)
          )
    if (host) {
      const documents = [...host.documents, document]
      set({
        panes: { ...panes, [host.id]: { ...host, documents, activeIndex: documents.length - 1 } },
        tabs: tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: host.id } : t))
      })
      return host.id
    }

    const pane: EditorPaneState = {
      id: uid(),
      kind: 'editor',
      documents: [document],
      activeIndex: 0,
      error: null
    }

    // The first editor opens beside the current pane, so the terminal stays
    // visible — the point of editing here rather than in a separate window.
    set({
      panes: { ...panes, [pane.id]: pane },
      tabs: tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              // First editor in this tab, so it becomes the editor area outright.
              // Only reached when the tab has none; a tab that does reuses it above.
              editors: t.editors
                ? splitAt(t.editors, collectPaneIds(t.editors)[0], 'row', pane.id)
                : { type: 'leaf', paneId: pane.id },
              activePaneId: pane.id
            }
          : t
      )
    })
    return pane.id
  },

  moveDocument: (paneId, from, to) =>
    set((s) => {
      const pane = s.panes[paneId]
      if (pane?.kind !== 'editor') return {}
      if (from === to || from < 0 || to < 0) return {}
      if (from >= pane.documents.length || to >= pane.documents.length) return {}

      const documents = [...pane.documents]
      const [moved] = documents.splice(from, 1)
      documents.splice(to, 0, moved)

      // The active index points at a position, not a document, so reordering has to
      // carry it — otherwise dragging a tab silently switches which file is shown.
      const active = pane.documents[pane.activeIndex]
      const activeIndex = Math.max(
        0,
        documents.findIndex((d) => d === active)
      )
      return { panes: { ...s.panes, [paneId]: { ...pane, documents, activeIndex } } }
    }),

  /**
   * Pull these files back off disk into the editors showing them.
   *
   * A document with unsaved edits is left exactly as it is: the user's own work is
   * worth more than whatever changed underneath it, and overwriting it to reflect
   * a replacement would destroy the thing they had not saved yet.
   *
   * The saved content is updated before the model, because dirtiness is derived by
   * comparing the two — the other order would mark a freshly reloaded file dirty.
   */
  reloadFromDisk: async (paths) => {
    const wanted = new Set(paths.map(pathKey))
    const { modelUri, monaco } = await import('../editor/monaco')

    for (const pane of Object.values(get().panes)) {
      if (pane.kind !== 'editor') continue
      for (let index = 0; index < pane.documents.length; index++) {
        const doc = pane.documents[index]
        if (!doc.filePath || doc.dirty || !wanted.has(pathKey(doc.filePath))) continue

        const res = await window.ember.readFile(doc.filePath)
        if (!res.ok) continue
        // Re-found by path after the read, since a tab closed in the meantime would
        // leave this index pointing at some other document.
        const current = get().editorPane(pane.id)
        const at = current?.documents.findIndex((d) => samePath(d.filePath, doc.filePath)) ?? -1
        if (at === -1) continue
        get().patchDocument(pane.id, { savedContent: res.content, eol: res.eol }, at)
        const model = monaco.editor.getModel(modelUri(doc.filePath))
        if (model && model.getValue() !== res.content) {
          // The replacement can have brought different line endings with it, and the
          // model's are what the next save writes back.
          model.setEOL(
            res.eol === 'crlf'
              ? monaco.editor.EndOfLineSequence.CRLF
              : monaco.editor.EndOfLineSequence.LF
          )
          model.setValue(res.content)
        }
        // Recorded so that closing this tab and opening it again still knows the
        // buffer matches disk rather than treating it as unsaved work.
        if (model) noteSynced(doc.filePath, model.getValue())
      }
    }
  },

  /**
   * Follow a file or folder the user renamed in the explorer.
   *
   * A document holds the path it will be saved to, and nothing used to update it:
   * renaming a file with its tab open left the editor pointing at a path that no
   * longer existed, and the next save — or an auto-save the user never asked for —
   * recreated the old file with the edits in it, leaving the renamed one behind
   * holding the text from before. The buffer has to travel with the name.
   *
   * Monaco keys models by URI, so the buffer is copied to a model at the new path
   * rather than renamed in place; anything the old path was known to agree with is
   * copied across with it, since the text is the same text.
   */
  notePathRenamed: async (from, to) => {
    const { modelUri, monaco, languageForPath } = await import('../editor/monaco')
    const moved = new Map<string, string>()

    for (const pane of Object.values(get().panes)) {
      if (pane.kind !== 'editor') continue
      for (let index = 0; index < pane.documents.length; index++) {
        const doc = pane.documents[index]
        // A folder rename moves everything under it, which is the case that looks
        // like nothing happened until a save lands somewhere unexpected.
        if (!doc.filePath || !isInside(from, doc.filePath)) continue
        const next = to + doc.filePath.slice(from.length)

        if (!moved.has(pathKey(doc.filePath))) {
          moved.set(pathKey(doc.filePath), next)
          const source = monaco.editor.getModel(modelUri(doc.filePath))
          if (source) {
            const text = source.getValue()
            const crlf = source.getEOL() === '\r\n'
            // A model can already exist at the destination — renaming a file back to
            // a name used earlier in the session is enough — and creating a second
            // one for the same URI throws.
            const existing = monaco.editor.getModel(modelUri(next))
            if (existing) {
              existing.setEOL(
                crlf
                  ? monaco.editor.EndOfLineSequence.CRLF
                  : monaco.editor.EndOfLineSequence.LF
              )
              existing.setValue(text)
            } else {
              monaco.editor.createModel(text, languageForPath(next), modelUri(next))
            }
            const agreed = lastSynced(doc.filePath)
            if (agreed !== undefined) noteSynced(next, agreed)
          }
        }

        get().patchDocument(
          pane.id,
          {
            filePath: next,
            title: next.split(/[\\/]/).pop() ?? next,
            language: languageForPath(next)
          },
          index
        )
      }
    }
  },

  /**
   * Say out loud that a deleted file's buffer is now the only copy of it.
   *
   * The text is deliberately kept — someone who deletes a file with edits open has
   * not necessarily decided to lose the edits — but it is marked unsaved, because
   * a tab that looks saved while nothing on disk backs it is the state where work
   * disappears without anyone being asked. Saving it afterwards recreates the file,
   * which is a decision the unsaved marker makes visible first.
   */
  notePathDeleted: (target) =>
    set((s) => {
      const panes = { ...s.panes }
      let touched = false
      for (const pane of Object.values(s.panes)) {
        if (pane.kind !== 'editor') continue
        const documents = pane.documents.map((d) =>
          d.filePath && isInside(target, d.filePath) && !d.dirty ? { ...d, dirty: true } : d
        )
        if (documents.some((d, i) => d !== pane.documents[i])) {
          panes[pane.id] = { ...pane, documents }
          touched = true
        }
      }
      return touched ? { panes } : {}
    }),

  /**
   * Save every edited document.
   *
   * The text comes from the models rather than the store, because the store holds
   * what was last read from disk — the edits live in Monaco. Models are keyed by
   * file URI and exist whether or not their tab is on screen, so a document edited
   * and then left behind another tab is saved too, which is the whole point of a
   * Save All.
   */
  saveAllDocuments: async () => {
    const { modelUri, monaco } = await import('../editor/monaco')
    let saved = 0
    const failures: string[] = []
    // One write per file, however many panes are showing it: they share a buffer,
    // so the second write would be the same bytes and the count would report one
    // file as two.
    const written = new Set<string>()

    for (const pane of Object.values(get().panes)) {
      if (pane.kind !== 'editor') continue
      for (let index = 0; index < pane.documents.length; index++) {
        const doc = pane.documents[index]
        if (!doc.dirty || !doc.filePath) continue
        if (written.has(pathKey(doc.filePath))) continue
        written.add(pathKey(doc.filePath))

        const content = monaco.editor.getModel(modelUri(doc.filePath))?.getValue()
        if (content === undefined) {
          failures.push(doc.title)
          continue
        }
        const res = await window.ember.writeFile(doc.filePath, content)
        if (!res.ok) {
          failures.push(doc.title)
          continue
        }
        // Re-found by path rather than reused: the write is awaited, and a tab
        // closed in the meantime would leave this index pointing at a different
        // document, which would then be marked saved when it is not.
        const current = get().editorPane(pane.id)
        const at = current?.documents.findIndex((d) => d.filePath === doc.filePath) ?? -1
        if (at !== -1) get().patchDocument(pane.id, { savedContent: content, dirty: false }, at)
        // And in every other pane on this file, which this loop now skips.
        get().settleSaved(doc.filePath, content, false)
        // Recorded even when the tab has gone: the model outlives it, and this is
        // what stops a later reopen mistaking a saved buffer for unsaved work.
        noteSynced(doc.filePath, content)
        saved += 1
      }
    }
    /*
     * Say when a save did not happen.
     *
     * The count was returned and both callers dropped it, so a Save All that wrote
     * nothing at all looked exactly like one that wrote everything — while the tabs
     * stayed dirty and the reason went nowhere. Naming the files matters because
     * the usual cause is one of them: read-only, locked, or gone.
     */
    if (failures.length > 0) {
      const names = failures.slice(0, 3).join(', ')
      const rest = failures.length > 3 ? ` and ${failures.length - 3} more` : ''
      get().setNotice(`Could not save ${names}${rest}.`, 'error')
    } else if (saved > 0) {
      get().setNotice(`Saved ${saved} ${saved === 1 ? 'file' : 'files'}.`)
    }
    return { saved, failed: failures.length }
  },

  patchDocument: (paneId, patch, index) =>
    set((s) => {
      const pane = s.panes[paneId]
      if (!pane || pane.kind !== 'editor') return s
      const at = index ?? pane.activeIndex
      if (!pane.documents[at]) return s
      const documents = pane.documents.map((d, i) => (i === at ? { ...d, ...patch } : d))
      return { panes: { ...s.panes, [paneId]: { ...pane, documents } } }
    }),

  /*
   * A file can be open in more than one editor pane — two tabs each showing it is
   * enough — and every pane kept its own record of what that file looked like on
   * disk. The text itself was never at risk, because the buffer is a Monaco model
   * keyed by URI and so is genuinely shared. The bookkeeping around it was not:
   * saving in one pane settled only that pane, and the other went on reporting
   * unsaved changes for a file that matched disk exactly. The same file read as
   * modified in one tab and clean in another, and there was no way to clear it
   * short of closing the tab.
   *
   * Dirtiness is passed in rather than assumed false, for the reason spelled out
   * where saves are written: a keystroke can land while the file is being written,
   * and that text is genuinely ahead of disk.
   */
  settleSaved: (filePath, content, dirty) =>
    set((s) => {
      const panes = { ...s.panes }
      let touched = false
      for (const pane of Object.values(s.panes)) {
        if (pane.kind !== 'editor') continue
        if (!pane.documents.some((d) => samePath(d.filePath, filePath))) continue
        panes[pane.id] = {
          ...pane,
          documents: pane.documents.map((d) =>
            samePath(d.filePath, filePath) ? { ...d, savedContent: content, dirty } : d
          )
        }
        touched = true
      }
      return touched ? { panes } : s
    }),

  setActiveDocument: (paneId, index) =>
    set((s) => {
      const pane = s.panes[paneId]
      if (!pane || pane.kind !== 'editor' || !pane.documents[index]) return s
      return { panes: { ...s.panes, [paneId]: { ...pane, activeIndex: index } } }
    }),

  closeDocument: (tabId, paneId, index) => {
    const pane = get().editorPane(paneId)
    if (!pane) return

    if (pane.documents.length <= 1) {
      get().closePane(tabId, paneId)
      return
    }

    const documents = pane.documents.filter((_, i) => i !== index)
    // Keep looking at the same document where possible; closing the active one
    // falls to its neighbour rather than jumping to the start.
    const activeIndex =
      pane.activeIndex > index
        ? pane.activeIndex - 1
        : Math.min(pane.activeIndex, documents.length - 1)
    set((s) => ({ panes: { ...s.panes, [paneId]: { ...pane, documents, activeIndex } } }))
  },

  openDiffInSplit: (tabId, diff) => {
    const { tabs, panes } = get()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return null

    // A diff lives in the editor area, same as a file.
    get().setMode('ide')

    // One pane per file-and-side, refreshed in place. Opening the same diff twice
    // should show the current content, not a second pane holding a stale snapshot.
    // Found by tab, for the same reason as openFileInSplit: a pane can only be made
    // active in the tab that actually contains it.
    for (const candidate of [tab, ...tabs.filter((t) => t.id !== tabId)]) {
      const here = new Set(paneIdsOf(candidate))
      const existing = Object.values(panes).find(
        (p) =>
          p.kind === 'diff' &&
          here.has(p.id) &&
          p.filePath === diff.filePath &&
          p.staged === diff.staged
      )
      if (!existing) continue
      set({
        panes: { ...panes, [existing.id]: { ...existing, ...diff } },
        tabs: tabs.map((t) => (t.id === candidate.id ? { ...t, activePaneId: existing.id } : t)),
        activeTabId: candidate.id
      })
      return existing.id
    }

    const pane: DiffPaneState = { id: uid(), kind: 'diff', ...diff }
    set({
      panes: { ...panes, [pane.id]: pane },
      tabs: tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              // First editor in this tab, so it becomes the editor area outright.
              // Only reached when the tab has none; a tab that does reuses it above.
              editors: t.editors
                ? splitAt(t.editors, collectPaneIds(t.editors)[0], 'row', pane.id)
                : { type: 'leaf', paneId: pane.id },
              activePaneId: pane.id
            }
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

  // Forgotten on disk as well as on screen. A Clear that left them to come back at
  // the next launch would be a strange kind of clear.
  clearBlocks: (paneId) => {
    window.ember.clearBlocks(paneId)
    get().patchPane(paneId, { blocks: [] })
  }
}))
