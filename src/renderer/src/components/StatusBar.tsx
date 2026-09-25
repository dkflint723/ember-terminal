import { ENCODING_LABELS, type TextEncodingName } from '@shared/encoding'
import { isInside, pathKey, samePath, shortenPath } from '@shared/paths'
import { setTrust, useTrustedAt } from '../state/trust'
import { activeDocument, paneIdsOf, useStore, type TerminalPaneState } from '../state/store'
import { monacoIfLoaded } from '../editor/loaded'
import { useProblems } from './ProblemsPanel'
import { useDebugStore } from '../state/debug'
import { ClaudeStatus } from './ClaudeChip'

/**
 * Language names as they are written down, for the few Monaco spells differently.
 *
 * The store holds Monaco's id, which is lower case — 'typescript', 'csharp' — and
 * raising the first letter is right for most of them: 'rust' and 'markdown' come out
 * as Rust and Markdown. It is wrong for exactly the ones below, and "Typescript" or
 * "Json" in the bar reads as a machine talking. Only those are listed: a table
 * holding every language Monaco ships would have to be maintained forever to keep
 * saying what capitalising already says.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  yaml: 'YAML',
  csharp: 'C#',
  cpp: 'C++'
}

/**
 * Offer to write a file back as UTF-8: the one change of encoding the editor makes,
 * and only when asked. The save goes through the same checked write as any other,
 * so a file that changed on disk in the meantime is still caught.
 */
function offerUtf8(filePath: string, title: string, encoding: TextEncodingName): void {
  useStore.getState().setNotice(
    `${title} is ${ENCODING_LABELS[encoding]}. Save it as UTF-8 instead?`,
    'info',
    [
      {
        label: 'Save as UTF-8',
        run: () => void useStore.getState().saveAsUtf8(filePath)
      }
    ]
  )
}

function languageName(id: string): string {
  if (!id) return ''
  return LANGUAGE_NAMES[id] ?? id[0].toUpperCase() + id.slice(1)
}

/**
 * What this file is actually indented with, read off the buffer.
 *
 * The pane is created asking for two spaces, but that is a request rather than the
 * answer: Monaco detects indentation from the text on the way in, so a file written
 * with tabs or with four spaces is edited the way it is written, and a bar printing
 * the constant would be describing the setting instead of the file. Null while there
 * is no buffer yet — the item is left out rather than guessed at, and the caret
 * arriving re-renders this with the model in place.
 */
function indentOf(filePath: string | null): { spaces: boolean; width: number } | null {
  const m = monacoIfLoaded()
  if (!filePath || !m) return null
  const model = m.monaco.editor.getModel(m.modelUri(filePath))
  if (!model) return null
  const { insertSpaces, tabSize } = model.getOptions()
  return { spaces: insertSpaces, width: tabSize }
}

/**
 * Monaco's own go-to-line, run against the editor the user is in.
 *
 * The same three lines as the palette's `runEditorAction`, deliberately: the action
 * registry is how this app reaches editor commands, and a status bar that opened its
 * own line prompt would be a second answer to a question already answered. Focus is
 * restored first because pressing a button in the bar took it away, and an action run
 * against an unfocused editor lands nowhere.
 */
function goToLine(): void {
  const editors = monacoIfLoaded()?.monaco.editor.getEditors() ?? []
  const editor = editors.find((e) => e.hasTextFocus()) ?? editors[0]
  if (!editor) return
  editor.focus()
  void editor.getAction('editor.action.gotoLine')?.run()
}

/**
 * The ambient facts, as a row of chips floating on the ground.
 *
 * They used to be a 22px solid bar. As chips each fact is its own pressable
 * object — where you are, which branch, how much is changed — and a fact with
 * nothing to say costs no space at all: the problem counts appear only once there
 * is a problem to count, where the bar showed two zeros all day.
 *
 * The left group is about the session, always. The right group has two readings:
 * with a terminal in front of you it is just the model chip; with a file it gains
 * the file's own context — caret, indentation, language — because those are the
 * facts you are working against while editing.
 */
export function StatusBar(): React.JSX.Element | null {
  const debugStatus = useDebugStore((s) => s.status)
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)
  const profiles = useStore((s) => s.profiles)
  const workspaceGit = useStore((s) => s.gitStatus)
  const cwdGit = useStore((s) => s.cwdGit)
  const showSidebarView = useStore((s) => s.showSidebarView)
  const setNotice = useStore((s) => s.setNotice)
  const setDirPicker = useStore((s) => s.setDirPicker)
  const activeWorkspace = useStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.workspace ?? null
  )
  const workspaceTrusted = useTrustedAt(activeWorkspace)
  const cursorAt = useStore((s) => s.cursorAt)
  const problems = useProblems()

  const tab = tabs.find((t) => t.id === activeTabId)
  if (!tab) return null

  /*
   * The shell being reported is the one in front of you, or the tab's first if the
   * editor has focus — a status bar that empties out when you click into a file
   * would be reporting the focus rather than the session.
   */
  const active = panes[tab.activePaneId]
  const terminal: TerminalPaneState | undefined =
    active?.kind === 'terminal'
      ? active
      : paneIdsOf(tab)
          .map((id) => panes[id])
          .find((p): p is TerminalPaneState => p?.kind === 'terminal')
  const cwd = terminal?.cwd ?? null

  /*
   * An editor, and only an editor, adds the file context. A diff pane is
   * deliberately not one: it is two snapshots side by side with no caret to report
   * and nothing to save, so it keeps the plain reading rather than showing a
   * position that belongs to some other pane.
   */
  const editing = active?.kind === 'editor' ? active : null
  const file = editing ? activeDocument(editing) : null
  const indent = file ? indentOf(file.filePath) : null

  // The workspace status already describes this directory when the shell sits
  // inside the open folder; anything else was read for the directory itself.
  const inWorkspace =
    workspaceGit && cwd ? isInside(workspaceGit.root, cwd) || samePath(workspaceGit.root, cwd) : false
  const git = inWorkspace ? workspaceGit : cwd ? (cwdGit[pathKey(cwd)] ?? null) : null
  const branch = git ? (git.detached ? 'detached' : git.branch) : null
  const changed = git
    ? new Set([...git.staged, ...git.changes, ...git.conflicts].map((c) => c.path)).size
    : null

  const errors = problems.filter((p) => p.severity === 8).length
  const warnings = problems.filter((p) => p.severity === 4).length
  const shell = profiles.find((p) => p.id === terminal?.profileId)?.name ?? null

  /*
   * Restricted: this project may not run its own code.
   *
   * Worth a chip because it quietly changes what several ordinary gestures do —
   * Save stops reaching for the project's prettier, a script does not run — and
   * somebody who has not been told that will read it as the feature being broken
   * rather than as a decision they have not made yet.
   */
  const restricted = !!tab.workspace && !workspaceTrusted

  const copyPath = (): void => {
    if (!cwd) return
    void navigator.clipboard.writeText(cwd)
    setNotice('Path copied.', 'info')
  }

  /*
   * Built as one string rather than as JSX text, because the exact spelling matters:
   * "Ln 3, Col 9" is what an editor says, and JSX would be free to fold the newlines
   * between the pieces into whatever whitespace it liked.
   *
   * A single character under the caret is not a selection worth announcing — one
   * arrow press with shift held is as often a mistake as an intention — so the count
   * appears past that, and the bare position is left exactly as it reads when there
   * is nothing held.
   */
  const position = cursorAt
    ? `Ln ${cursorAt.line}, Col ${cursorAt.column}` +
      (cursorAt.selected > 1 ? ` (${cursorAt.selected} selected)` : '')
    : null

  return (
    // A status region rather than a toolbar: the counts change on their own, and a
    // screen reader should hear that without the bar claiming to be a set of
    // controls first.
    <div className="statusbar" role="status" aria-label="Workspace status">
      {cwd && (
        <button
          className="statusbar__item statusbar__path"
          data-status="cwd"
          aria-label={`Working directory ${cwd}. Browse it`}
          title={`${cwd}${shell ? `\n${shell}` : ''}\nClick to browse · right-click to copy`}
          onClick={() => setDirPicker(true)}
          onContextMenu={(e) => {
            // Copying the path is what this used to do, and it is still worth
            // one gesture — just not the first one. Someone reading the path is
            // usually about to go somewhere rather than to quote it.
            e.preventDefault()
            copyPath()
          }}
        >
          <svg viewBox="0 0 16 16" width="11" height="11" className="statusbar__icon" aria-hidden="true">
            <path d="M1.5 3.5h4.2l1.6 1.8h7.2v7.2h-13z" />
          </svg>
          {shortenPath(cwd, 42)}
        </button>
      )}
      {restricted && (
        <button
          className="statusbar__item"
          data-status="trust"
          aria-label="This folder is restricted. Ember will not run code from it. Trust this folder"
          title={
            'Ember will not run this folder’s prettier, its scripts or its launch configurations.\nClick to trust it.'
          }
          onClick={() => {
            const folder = tab.workspace
            if (!folder) return
            setNotice(
              'Trusting this folder lets Ember run its prettier, its scripts and its launch configurations.',
              'info',
              [{ label: 'Trust this folder', run: () => void setTrust(folder, true) }]
            )
          }}
        >
          Restricted
        </button>
      )}
      {debugStatus !== 'idle' && (
        <button
          className={`statusbar__item statusbar__debug ${debugStatus === 'stopped' ? 'statusbar__debug--paused' : ''}`}
          data-status="debug"
          aria-label="Debugging. Open the Debug view"
          title="A debug session is live — click for the Debug view"
          onClick={() => {
            const s = useStore.getState()
            if (s.mode !== 'ide') s.setMode('ide')
            s.showSidebarView('debug')
          }}
        >
          {debugStatus === 'stopped' ? '⏸ paused' : '● debugging'}
        </button>
      )}
      {branch && (
        <button
          className="statusbar__item"
          data-status="branch"
          aria-label={`Branch ${branch}. Open source control`}
          title={git?.upstream ?? 'No upstream'}
          onClick={() => showSidebarView('scm')}
        >
          <svg
            viewBox="0 0 16 16"
            width="11"
            height="11"
            className="statusbar__icon"
            strokeWidth="1.4"
            aria-hidden="true"
          >
            <circle cx="4.5" cy="3.5" r="1.6" />
            <circle cx="4.5" cy="12.5" r="1.6" />
            <circle cx="11.5" cy="3.5" r="1.6" />
            <path d="M4.5 5.1v5.8M11.5 5.1v1.3a2.8 2.8 0 0 1-2.8 2.8H4.5" />
          </svg>
          {branch}
        </button>
      )}
      {git && changed !== null && changed > 0 && (
        <button
          className="statusbar__item statusbar__num"
          data-status="changes"
          aria-label={
            `${changed} changed ${changed === 1 ? 'path' : 'paths'}` +
            (git.insertions || git.deletions
              ? `, ${git.insertions} lines added, ${git.deletions} removed`
              : '') +
            '. Open source control'
          }
          onClick={() => showSidebarView('scm')}
        >
          {changed} ●
          {(git.insertions > 0 || git.deletions > 0) && (
            <>
              <span className="statusbar__ok">+{git.insertions}</span>
              <span className="statusbar__bad">−{git.deletions}</span>
            </>
          )}
        </button>
      )}
      {/* Only once there is something to count. Two zeros standing all day made the
          one moment they changed look exactly like every other moment. */}
      {(errors > 0 || warnings > 0) && (
        <button
          className="statusbar__item statusbar__num"
          data-status="problems"
          aria-label={`${errors} errors, ${warnings} warnings. Open problems`}
          onClick={() => showSidebarView('problems')}
        >
          <span className="statusbar__bad">✕</span>
          {errors}
          <span className="statusbar__warn">⚠</span>
          {warnings}
        </button>
      )}

      <span className="statusbar__gap" />

      {file && (
        <>
          {cursorAt && (
            <button
              className="statusbar__item"
              data-status="position"
              /* The bar is a live region so the counts announce themselves as they
                 change. The caret is not that kind of fact: it changes on every
                 arrow press, and an atomic live region re-reads the whole bar each
                 time. It is opted out here rather than the region being weakened. */
              aria-live="off"
              aria-label={
                `Line ${cursorAt.line}, column ${cursorAt.column}` +
                (cursorAt.selected > 1 ? `, ${cursorAt.selected} characters selected` : '') +
                '. Go to line'
              }
              /* The indentation rides in the caret chip's tooltip rather than
                 spending a chip of its own: it is a fact about the same buffer,
                 asked about far less often than it would be looked at. */
              title={
                'Go to line' +
                (indent ? ` — ${indent.spaces ? 'Spaces' : 'Tab Size'}: ${indent.width}` : '')
              }
              data-indent={indent ? `${indent.spaces ? 'Spaces' : 'Tab Size'}: ${indent.width}` : undefined}
              onClick={goToLine}
            >
              {position}
            </button>
          )}
          <span className="statusbar__label" data-status="language">
            {languageName(file.language)}
          </span>
          {/*
            The encoding, only when it is news. A plain UTF-8 file says nothing here,
            as nearly every file is; one that is not says what it is — the reason its
            é survives a save — and offers to become UTF-8.
          */}
          {file.encoding && file.encoding !== 'utf8' && file.filePath && (
            <button
              className="statusbar__item"
              data-status="encoding"
              title={`Saved as ${ENCODING_LABELS[file.encoding]}, the way it was read. Click to save it as UTF-8.`}
              onClick={() => offerUtf8(file.filePath!, file.title, file.encoding!)}
            >
              {ENCODING_LABELS[file.encoding]}
            </button>
          )}
        </>
      )}
      <ClaudeStatus />
    </div>
  )
}
