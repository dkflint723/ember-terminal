import { samePath } from '@shared/paths'
import { useStore } from '../state/store'
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
