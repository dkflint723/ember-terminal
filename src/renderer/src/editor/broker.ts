import { isInside, samePath } from '@shared/paths'
import { useStore, workspaceRoot } from '../state/store'
import { languageForPath, modelUri, monaco } from './monaco'
import { parkModel } from './models'
import { lastSynced, noteSynced } from './synced'

/**
 * Files a language server names, made into something the editor can show.
 *
 * Monaco shows and edits only files it holds a model for, and it holds one only
 * for files open in a tab. So a references answer that pointed into a file on
 * disk showed nothing at all, and a rename whose edit reached one failed as a
 * whole — not even the open file changed. Shift+F12 and F2 worked only across
 * files that happened to be open, which is the opposite of what they are for.
 *
 * So before such an answer reaches the editor, every file it names is read from
 * disk and loaded as a model: registered as agreeing with disk, as a tab's model
 * is when its file is read, so opening it later behaves as opening any file does.
 * A model loaded only to be shown goes to the parking lot after a while, like one
 * whose tab has closed; one a rename changed is opened as a tab, because a change
 * with no tab could be neither seen nor saved, and would be lost at quit.
 */

/** The requests whose answers name other files. */
export const NAMES_FILES = new Set([
  'textDocument/references',
  'textDocument/definition',
  'textDocument/declaration',
  'textDocument/typeDefinition',
  'textDocument/implementation',
  'textDocument/rename'
])

/** How long a model loaded only to be shown stays before it is parked. */
const SHOWN_FOR_MS = 120_000
/*
 * At most this many files loaded for one answer. A references search for a name
 * used all over a large project named thousands of files, and each would have been
 * read, held, and opened with the language server before the list could appear.
 * Past this many, the rest are left as they were before: named, and not shown.
 */
const MOST_PER_ANSWER = 50
/** Files read at once. */
const READ_AT_ONCE = 4

/** Every `file:` URI an answer names, whether as a location or as an edit's target. */
export function fileUrisIn(result: unknown): string[] {
  const found = new Set<string>()
  const add = (uri: unknown): void => {
    if (typeof uri === 'string' && uri.startsWith('file:')) found.add(uri)
  }
  const locations = Array.isArray(result) ? result : result && typeof result === 'object' && 'uri' in result ? [result] : []
  for (const item of locations as { uri?: unknown; targetUri?: unknown }[]) {
    add(item?.uri)
    add(item?.targetUri)
  }
  const edit = result as { changes?: Record<string, unknown>; documentChanges?: unknown[] } | null
  if (edit && typeof edit === 'object' && !Array.isArray(edit)) {
    for (const uri of Object.keys(edit.changes ?? {})) add(uri)
    for (const change of edit.documentChanges ?? []) {
      // A file created by the edit is not there to read; only edits to files that are.
      add((change as { textDocument?: { uri?: unknown } })?.textDocument?.uri)
    }
  }
  return [...found]
}

/** Whether any editor pane has this file open. */
function openInATab(filePath: string): boolean {
  return Object.values(useStore.getState().panes).some(
    (p) => p.kind === 'editor' && p.documents.some((d) => samePath(d.filePath, filePath))
  )
}

/**
 * Load a model for each file URI that has none. Returns the paths loaded, which
 * are the ones no tab had. A file that cannot be read is left out: Monaco then
 * leaves that entry out of what it shows, as it did before, and nothing else.
 */
export async function ensureModels(uris: string[]): Promise<string[]> {
  const missing = uris
    .map((uri) => monaco.Uri.parse(uri))
    .filter((parsed) => parsed.scheme === 'file' && !monaco.editor.getModel(modelUri(parsed.fsPath)))
    .map((parsed) => parsed.fsPath)
    .slice(0, MOST_PER_ANSWER)
  const loaded: string[] = []
  const loadOne = async (filePath: string): Promise<void> => {
    const res = await window.ember.readFile(filePath)
    // Loaded meanwhile — another answer, or a tab opened while this one was reading.
    if (!res.ok || monaco.editor.getModel(modelUri(filePath))) return
    const model = monaco.editor.createModel(res.content, languageForPath(res.path), modelUri(filePath))
    model.setEOL(res.eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
    noteSynced(filePath, model.getValue(), res.stamp)
    loaded.push(filePath)
    setTimeout(() => void letGo(filePath), SHOWN_FOR_MS)
  }
  for (let i = 0; i < missing.length; i += READ_AT_ONCE) {
    await Promise.all(missing.slice(i, i + READ_AT_ONCE).map(loadOne))
  }
  return loaded
}

/*
 * A model loaded to be shown, let go of — unless it holds a change. A rename's edit
 * to a file that never got its tab (the edit landed late, or the tab could not be
 * opened) would otherwise have been parked and later thrown away with nothing to say
 * so: no tab, so nothing asked about it at quit. Such a file is opened instead.
 */
async function letGo(filePath: string): Promise<void> {
  const model = monaco.editor.getModel(modelUri(filePath))
  if (!model || openInATab(filePath)) return
  if (model.getValue() !== lastSynced(filePath)) {
    await openTabs([filePath], undefined)
    return
  }
  parkModel(filePath, false)
}

/**
 * After a rename: open, as tabs, the files it changed that had none, and say which
 * files it changed. Waited for by watching the models, since Monaco applies the
 * edit only after the answer has reached it.
 */
export function afterRename(result: unknown): void {
  const touched = fileUrisIn(result).map((uri) => monaco.Uri.parse(uri).fsPath)
  if (touched.length < 2) return
  // Each file's version now, before the edit is applied, so the notice can say which
  // files it actually changed rather than which ones it was meant to.
  const before = new Map(touched.map((p) => [p, monaco.editor.getModel(modelUri(p))?.getVersionId()]))
  const origin = monaco.editor.getEditors().find((e) => e.hasTextFocus())
  // Every file it touches that has no tab — loaded for this answer, or earlier for
  // another one: a references search before the rename has loaded the same file.
  const waiting = new Set(touched.filter((filePath) => !openInATab(filePath)))
  const opened: string[] = []
  const finish = (): void => {
    for (const d of disposers) d.dispose()
    clearTimeout(giveUp)
    void openTabs(opened, origin).then(async () => {
      const changed = touched.filter((p) => {
        const version = monaco.editor.getModel(modelUri(p))?.getVersionId()
        return version !== undefined && version !== before.get(p)
      })
      // A rename that was not applied — typed over, or refused — says nothing.
      if (changed.length === 0) return
      // Named as they are spelled on disk, not as the server lower-cased them.
      const spelled = await Promise.all(changed.map((p) => window.ember.diskSpelling(p)))
      const names = spelled.map((p) => p.split(/[\\/]/).pop()).join(', ')
      useStore
        .getState()
        .setNotice(
          opened.length > 0
            ? `Renamed in ${changed.length} files: ${names}. ${opened.length === 1 ? 'One was' : `${opened.length} were`} not open and ${opened.length === 1 ? 'is' : 'are'} now, unsaved.`
            : `Renamed in ${changed.length} files: ${names}.`,
          'info'
        )
    })
  }
  const disposers = [...waiting].flatMap((filePath) => {
    const model = monaco.editor.getModel(modelUri(filePath))
    if (!model) {
      waiting.delete(filePath)
      return []
    }
    return [
      model.onDidChangeContent(() => {
        if (!waiting.delete(filePath)) return
        opened.push(filePath)
        if (waiting.size === 0) finish()
      })
    ]
  })
  // A rename that is cancelled, or leaves a file as it was, changes nothing to wait for.
  const giveUp = setTimeout(finish, waiting.size > 0 ? 3000 : 0)
}

/**
 * A workspace edit the server asks the editor to make (`workspace/applyEdit`).
 *
 * Refactorings such as extract to constant come back from the TypeScript server as a
 * command, and running it makes the server send the edit this way. Declined, the
 * refactoring was offered and did nothing. Applied here, as one undoable step per
 * file; a file the edit changes that had no tab is opened, unsaved, as after a
 * rename. Creating, renaming or deleting files is not done — the whole edit is
 * declined, rather than half of it made.
 */
export async function applyWorkspaceEdit(edit: unknown): Promise<{ applied: boolean; failureReason?: string }> {
  const e = (edit ?? {}) as {
    changes?: Record<string, LspTextEdit[]>
    documentChanges?: { kind?: string; textDocument?: { uri?: string; version?: number | null }; edits?: LspTextEdit[] }[]
  }
  if ((e.documentChanges ?? []).some((c) => typeof c.kind === 'string')) {
    return { applied: false, failureReason: 'Ember does not create, rename or delete files for a language server.' }
  }
  /*
   * The protocol gives an edit two ways to be written, and `documentChanges` wins
   * when both are there. Some servers send both; taking both applied every edit
   * twice, which Monaco refuses outright as overlapping.
   */
  const byUri = new Map<string, LspTextEdit[]>()
  const versions = new Map<string, number>()
  if (e.documentChanges) {
    for (const change of e.documentChanges) {
      const uri = change.textDocument?.uri
      if (typeof uri !== 'string') continue
      byUri.set(uri, [...(byUri.get(uri) ?? []), ...(change.edits ?? [])])
      if (typeof change.textDocument?.version === 'number') versions.set(uri, change.textDocument.version)
    }
  } else {
    for (const [uri, edits] of Object.entries(e.changes ?? {})) byUri.set(uri, [...edits])
  }
  if (byUri.size === 0) return { applied: true }

  /*
   * Only in the workspace. A server may name any file it can read — a profile, a
   * git hook — and such a change would sit in a tab, one Save All away from disk.
   */
  const root = workspaceRoot(useStore.getState())
  const outside = [...byUri.keys()].map((uri) => monaco.Uri.parse(uri).fsPath).filter((p) => !root || !isInside(root, p))
  if (outside.length > 0) {
    return { applied: false, failureReason: `Ember applies a language server's edits only inside the open folder; ${outside[0]} is not.` }
  }

  await ensureModels([...byUri.keys()])
  const models = [...byUri.keys()].map((uri) => monaco.editor.getModel(modelUri(monaco.Uri.parse(uri).fsPath)))
  // All or nothing: a file that could not be read leaves every file as it was.
  if (models.some((m) => !m)) return { applied: false, failureReason: 'A file the edit changes could not be read.' }

  /*
   * Checked, every file, before any is touched. An edit the server worked out against
   * an older version of a file — typed into while it thought — lands at the wrong
   * offsets, and edits that overlap are refused by Monaco part-way through, leaving
   * some files changed while the server is told none were.
   */
  const uris = [...byUri.keys()]
  for (let i = 0; i < uris.length; i += 1) {
    const expected = versions.get(uris[i])
    if (expected !== undefined && expected !== models[i]!.getVersionId()) {
      return { applied: false, failureReason: 'A file changed while the language server was working on it.' }
    }
    const sorted = [...byUri.get(uris[i])!].sort(
      (a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character
    )
    for (let j = 1; j < sorted.length; j += 1) {
      const prev = sorted[j - 1].range.end
      const next = sorted[j].range.start
      if (prev.line > next.line || (prev.line === next.line && prev.character > next.character)) {
        return { applied: false, failureReason: 'The language server sent edits that overlap.' }
      }
    }
  }

  const origin = monaco.editor.getEditors().find((ed) => ed.hasTextFocus())
  const changed: string[] = []
  ;[...byUri.values()].forEach((edits, i) => {
    const model = models[i]!
    model.pushStackElement()
    model.pushEditOperations(
      [],
      edits.map((te) => ({
        range: new monaco.Range(
          te.range.start.line + 1,
          te.range.start.character + 1,
          te.range.end.line + 1,
          te.range.end.character + 1
        ),
        text: te.newText
      })),
      () => null
    )
    model.pushStackElement()
    changed.push(model.uri.fsPath)
  })
  const untabbed = changed.filter((p) => !openInATab(p))
  await openTabs(untabbed, untabbed.length > 0 ? origin : undefined)
  if (changed.length > 1 || untabbed.length > 0) {
    const spelled = await Promise.all(changed.map((p) => window.ember.diskSpelling(p)))
    const names = spelled.map((p) => p.split(/[\\/]/).pop()).join(', ')
    useStore
      .getState()
      .setNotice(
        untabbed.length > 0
          ? `Changed ${names}. ${untabbed.length === 1 ? 'One was' : `${untabbed.length} were`} not open and ${untabbed.length === 1 ? 'is' : 'are'} now, unsaved.`
          : `Changed ${names}.`,
        'info'
      )
  }
  return { applied: true }
}

interface LspTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  newText: string
}

/** Open each file as a tab, then give focus back to the editor the rename was made in. */
async function openTabs(paths: string[], origin: monaco.editor.ICodeEditor | undefined): Promise<void> {
  if (paths.length === 0) return
  const originPath = origin?.getModel()?.uri.fsPath
  for (const given of [...paths, ...(originPath ? [originPath] : [])]) {
    /*
     * In the spelling it has on disk. A language server hands paths back lower-cased,
     * and a tab opened by that spelling showed usercard.tsx for UserCard.tsx — and
     * saving it renamed the file on disk to match.
     */
    const filePath = await window.ember.diskSpelling(given)
    const res = await window.ember.readFile(filePath)
    if (!res.ok) continue
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return
    s.openFileInSplit(tab.id, {
      path: res.path,
      name: res.name,
      content: res.content,
      language: languageForPath(res.path),
      eol: res.eol,
      stamp: res.stamp,
      encoding: res.encoding
    })
  }
}
