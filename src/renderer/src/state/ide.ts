import { useEffect } from 'react'
import type { IdeCall } from '@shared/types'
import { useStore, type DiffPaneState, type EditorDocument } from './store'

/**
 * Answers Claude Code's tool calls.
 *
 * The socket is in main, but every question is about editors, so the answers are
 * here. Shapes follow the VS Code extension rather than anything invented: the CLI
 * is the client, it parses these, and a plausible-looking variation is simply wrong.
 *
 * Two conventions worth knowing. Most tools answer with a JSON document that main
 * wraps in a text content block. `openDiff` instead returns finished blocks under
 * `__content`, because its verdict is compared literally against `DIFF_REJECTED`
 * and `FILE_SAVED`.
 */

/** Diffs waiting on the user. Keyed by tab name, which is what close_tab names. */
const pendingProposals = new Map<string, { paneId: string; settle: (v: unknown) => void }>()

/** The last selection seen, so `getLatestSelection` can answer after focus moves. */
let lastSelection: unknown = null

/** Every open file across every editor pane, flattened — a pane holds several. */
interface OpenDocument extends EditorDocument {
  paneId: string
  index: number
  isActive: boolean
}

function openDocuments(): OpenDocument[] {
  const out: OpenDocument[] = []
  for (const pane of Object.values(useStore.getState().panes)) {
    if (pane.kind !== 'editor') continue
    pane.documents.forEach((doc, index) =>
      out.push({ ...doc, paneId: pane.id, index, isActive: index === pane.activeIndex })
    )
  }
  return out
}

function diffPanes(): DiffPaneState[] {
  return Object.values(useStore.getState().panes).filter(
    (p): p is DiffPaneState => p.kind === 'diff'
  )
}

function toUri(filePath: string): string {
  const forward = filePath.replace(/\\/g, '/')
  return `file:///${forward.replace(/^\//, '')}`
}

function documentFor(filePath: string): OpenDocument | undefined {
  const wanted = filePath.replace(/\\/g, '/').toLowerCase()
  return openDocuments().find(
    (d) => (d.filePath ?? '').replace(/\\/g, '/').toLowerCase() === wanted
  )
}

/**
 * Record the active editor's selection. Called by the editor pane rather than
 * polled, because a selection that is one render stale is worse than useless when
 * the whole point is "what am I looking at right now".
 */
export function recordSelection(selection: {
  filePath: string | null
  text: string
  start: { line: number; character: number }
  end: { line: number; character: number }
}): void {
  if (!selection.filePath) return
  lastSelection = {
    success: true,
    filePath: selection.filePath,
    text: selection.text,
    selection: { start: selection.start, end: selection.end, isEmpty: selection.text.length === 0 }
  }
  // The CLI keeps its own idea of context; telling it lets an `@`-mention resolve
  // to what is on screen without asking first.
  window.ember.ideNotify('selection_changed', lastSelection)
}

/** Accept or reject a proposed change. Called by the diff pane's controls. */
export async function resolveProposal(
  tabName: string,
  verdict: 'accept' | 'reject'
): Promise<void> {
  const pending = pendingProposals.get(tabName)
  if (!pending) return
  pendingProposals.delete(tabName)

  const state = useStore.getState()
  const pane = state.panes[pending.paneId]
  const diff = pane?.kind === 'diff' ? pane : null

  if (verdict === 'reject') {
    pending.settle({ __content: [{ type: 'text', text: 'DIFF_REJECTED' }] })
  } else if (diff) {
    const target = diff.proposal?.targetPath ?? diff.filePath
    const written = await window.ember.writeFile(target, diff.modified)
    if (!written.ok) {
      // Report the failure rather than claiming a save that did not happen — the
      // CLI would otherwise carry on believing the file is on disk as proposed.
      pending.settle({ success: false, message: written.error })
      return
    }
    pending.settle({
      __content: [
        { type: 'text', text: 'FILE_SAVED' },
        { type: 'text', text: diff.modified }
      ]
    })
  }

  // The pane has served its purpose either way; leaving it would accumulate one
  // stale diff per proposal.
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  if (tab) state.closePane(tab.id, pending.paneId)
}

async function handle(call: IdeCall): Promise<unknown> {
  const state = useStore.getState()
  const args = call.args

  switch (call.name) {
    case 'getWorkspaceFolders': {
      const root = state.treeRoot
      return {
        success: true,
        folders: root
          ? [{ name: root.split(/[\\/]/).filter(Boolean).pop() ?? root, uri: toUri(root), path: root, index: 0 }]
          : [],
        rootPath: root,
        workspaceFile: null
      }
    }

    case 'getOpenEditors':
      return {
        tabs: openDocuments().map((d) => ({
          uri: d.filePath ? toUri(d.filePath) : null,
          path: d.filePath,
          isActive: d.isActive,
          label: d.title,
          languageId: d.language,
          isDirty: d.dirty
        }))
      }

    case 'getCurrentSelection':
    case 'getLatestSelection':
      return lastSelection ?? { success: false, message: 'No active editor found' }

    case 'checkDocumentDirty': {
      const doc = documentFor(String(args.filePath ?? ''))
      if (!doc) return { success: false, message: 'Document not open in the editor.' }
      return { success: true, filePath: doc.filePath, isDirty: doc.dirty }
    }

    case 'saveDocument': {
      const doc = documentFor(String(args.filePath ?? ''))
      if (!doc || !doc.filePath) {
        return { success: false, message: 'Document not open in the editor.' }
      }
      // Saved from the store's copy of the buffer, which the pane keeps current.
      const res = await window.ember.writeFile(doc.filePath, doc.savedContent)
      return res.ok
        ? { success: true, filePath: doc.filePath }
        : { success: false, message: res.error }
    }

    case 'openFile': {
      const filePath = String(args.filePath ?? '')
      const res = await window.ember.readFile(filePath)
      if (!res.ok) return { success: false, message: res.error }

      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) return { success: false, message: 'No tab is open.' }

      const { languageForPath } = await import('../editor/monaco')
      state.openFileInSplit(tab.id, {
        path: res.path,
        name: res.name,
        content: res.content,
        language: languageForPath(res.path),
        eol: res.eol
      })
      return { success: true, filePath: res.path }
    }

    case 'openDiff': {
      const target = String(args.new_file_path ?? args.old_file_path ?? '')
      const tabName = String(args.tab_name ?? `✻ ${target.split(/[\\/]/).pop() ?? 'diff'}`)
      const proposed = String(args.new_file_contents ?? '')

      // The left-hand side is what is on disk now. A file being created has none,
      // and an empty original is the honest way to show that.
      const existing = await window.ember.readFile(target)
      const original = existing.ok ? existing.content : ''

      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) return { success: false, message: 'No tab is open.' }

      const { languageForPath } = await import('../editor/monaco')
      const paneId = state.openDiffInSplit(tab.id, {
        filePath: target,
        title: tabName,
        original,
        modified: proposed,
        originalLabel: existing.ok ? 'Current' : 'New file',
        modifiedLabel: 'Proposed',
        language: languageForPath(target),
        staged: false,
        proposal: { tabName, targetPath: target }
      })
      if (!paneId) return { success: false, message: 'Could not open a diff.' }

      // Deliberately unresolved: the CLI is waiting on a person, and this is the
      // one tool call whose answer is a decision rather than a lookup.
      return new Promise((settle) => {
        pendingProposals.set(tabName, { paneId, settle })
      })
    }

    case 'close_tab': {
      const tabName = String(args.tab_name ?? '')
      const pending = pendingProposals.get(tabName)
      if (pending) {
        pendingProposals.delete(tabName)
        pending.settle({ __content: [{ type: 'text', text: 'TAB_CLOSED' }] })
        const tab = state.tabs.find((t) => t.id === state.activeTabId)
        if (tab) state.closePane(tab.id, pending.paneId)
      }
      return { success: true }
    }

    case 'closeAllDiffTabs': {
      const panes = diffPanes()
      for (const [tabName, pending] of pendingProposals) {
        pending.settle({ __content: [{ type: 'text', text: 'TAB_CLOSED' }] })
        pendingProposals.delete(tabName)
      }
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (tab) for (const pane of panes) state.closePane(tab.id, pane.id)
      return { success: true, closed: panes.length }
    }

    case 'getDiagnostics': {
      const { monaco } = await import('../editor/monaco')
      const wanted = args.uri ? String(args.uri).toLowerCase() : null
      const byFile = new Map<string, unknown[]>()

      for (const marker of monaco.editor.getModelMarkers({})) {
        const uri = marker.resource.toString()
        if (wanted && uri.toLowerCase() !== wanted) continue
        const list = byFile.get(uri) ?? []
        list.push({
          message: marker.message,
          severity: SEVERITY[marker.severity] ?? 'Information',
          source: marker.source,
          code: marker.code,
          range: {
            start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
            end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 }
          }
        })
        byFile.set(uri, list)
      }
      return [...byFile].map(([uri, diagnostics]) => ({ uri, diagnostics }))
    }

    // Advertised so the IDE does not look broken, but there is no notebook kernel
    // here for code to run on. The terminal beside it is the answer to this.
    case 'executeCode':
      return { success: false, message: 'Ember has no notebook kernel; run it in a terminal pane.' }

    default:
      return { success: false, message: `Unknown tool: ${call.name}` }
  }
}

/** Monaco's numeric severities, in the words the CLI expects to read. */
const SEVERITY: Record<number, string> = { 8: 'Error', 4: 'Warning', 2: 'Information', 1: 'Hint' }

/**
 * Mount the handler and keep the published workspace root current, so a CLI that
 * reads the lockfile sees the folder the user is actually working in.
 */
export function useIdeBridge(): void {
  const treeRoot = useStore((s) => s.treeRoot)

  useEffect(() => {
    window.ember.ideWorkspace(treeRoot ? [treeRoot] : [])
  }, [treeRoot])

  useEffect(
    () =>
      window.ember.onIdeCall((call) => {
        void handle(call)
          .then((result) => window.ember.ideResult(call.id, result))
          .catch((err) =>
            window.ember.ideResult(call.id, {
              success: false,
              message: err instanceof Error ? err.message : 'Tool failed.'
            })
          )
      }),
    []
  )
}
