import { useEffect } from 'react'
import type { IdeCall } from '@shared/types'
import { useStore, type DiffPaneState, type EditorDocument } from './store'
import { noteSynced } from '../editor/synced'

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
    /*
     * Tell any editor showing that file what just happened to it.
     *
     * Without this the file changed on disk while a tab went on holding the old
     * text and still believing it matched — so the user's next save wrote the old
     * text back and silently undid the change they had just accepted. Accepting a
     * diff and then losing it to an ordinary Ctrl+S is about the worst outcome this
     * integration could have.
     */
    await reconcileAcceptedDiff(target, diff.modified)

    pending.settle({
      __content: [
        { type: 'text', text: 'FILE_SAVED' },
        { type: 'text', text: diff.modified }
      ]
    })
  }

  // The pane has served its purpose either way; leaving it would accumulate one
  // stale diff per proposal. It is closed through the tab that actually holds it:
  // a proposal can outlive the user's attention, and by the time they accept or
  // reject it the tab in front of them may not be the one Claude opened it in.
  const owner = state.tabIdForPane(pending.paneId)
  if (owner) state.closePane(owner, pending.paneId)
}

/**
 * Bring open editors into line with a file Claude Code just wrote.
 *
 * A document whose buffer still matches what was on disk before is updated in
 * place, so the editor shows what was accepted. One with genuine unsaved edits of
 * the user's own keeps them — but is left marked unsaved against the new content,
 * so saving is a deliberate overwrite rather than a silent revert.
 */
async function reconcileAcceptedDiff(filePath: string, written: string): Promise<void> {
  const { modelUri, monaco } = await import('../editor/monaco')
  const state = useStore.getState()
  const key = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

  for (const pane of Object.values(state.panes)) {
    if (pane.kind !== 'editor') continue
    for (let index = 0; index < pane.documents.length; index++) {
      const doc = pane.documents[index]
      if (!doc.filePath || key(doc.filePath) !== key(filePath)) continue

      const model = monaco.editor.getModel(modelUri(doc.filePath))
      const untouched = !model || model.getValue() === doc.savedContent
      state.patchDocument(pane.id, { savedContent: written, dirty: !untouched }, index)
      if (untouched && model) {
        if (model.getValue() !== written) model.setValue(written)
        // A buffer brought into line with what was accepted agrees with disk again,
        // and has to be recorded as such or closing and reopening the file would
        // read it as unsaved work and stop showing what Claude wrote.
        noteSynced(doc.filePath, model.getValue())
      }
    }
  }
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
      /*
       * The live buffer, not the store's copy of it.
       *
       * `savedContent` is what was last read from or written to disk — the one
       * value that is never the unsaved work being asked for. Saving it wrote the
       * old text back over anything newer and reported success, so a Claude Code
       * session that asked Ember to save reverted the file it was working on.
       * saveAllDocuments in the store already reads the model; this now matches.
       */
      const { modelUri, monaco } = await import('../editor/monaco')
      const content = monaco.editor.getModel(modelUri(doc.filePath))?.getValue()
      if (content === undefined) {
        return { success: false, message: 'That document has no editor buffer to save.' }
      }

      const res = await window.ember.writeFile(doc.filePath, content)
      if (!res.ok) return { success: false, message: res.error }
      noteSynced(doc.filePath, content)

      // Dirtiness is derived by comparing against what is on disk, so the saved
      // content has to move with it or the document stays reported as dirty.
      const state = useStore.getState()
      for (const pane of Object.values(state.panes)) {
        if (pane.kind !== 'editor') continue
        const index = pane.documents.findIndex((d) => d.filePath === doc.filePath)
        if (index !== -1) state.patchDocument(pane.id, { savedContent: content, dirty: false }, index)
      }
      return { success: true, filePath: doc.filePath }
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
        const owner = state.tabIdForPane(pending.paneId)
        if (owner) state.closePane(owner, pending.paneId)
      }
      return { success: true }
    }

    case 'closeAllDiffTabs': {
      const panes = diffPanes()
      for (const [tabName, pending] of pendingProposals) {
        pending.settle({ __content: [{ type: 'text', text: 'TAB_CLOSED' }] })
        pendingProposals.delete(tabName)
      }
      // Diff panes can be spread across several tabs, so each is closed through
      // whichever tab holds it.
      for (const pane of panes) {
        const owner = state.tabIdForPane(pane.id)
        if (owner) state.closePane(owner, pane.id)
      }
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
