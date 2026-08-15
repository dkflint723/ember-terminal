import { isInside, pathKey, samePath, shortenPath } from '@shared/paths'
import { activeDocument, paneIdsOf, useStore, type TerminalPaneState } from '../state/store'
import { modelUri, monaco } from '../editor/monaco'
import { useProblems } from './ProblemsPanel'
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
  if (!filePath) return null
  const model = monaco.editor.getModel(modelUri(filePath))
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
  const editors = monaco.editor.getEditors()
  const editor = editors.find((e) => e.hasTextFocus()) ?? editors[0]
  if (!editor) return
  editor.focus()
  void editor.getAction('editor.action.gotoLine')?.run()
}

/**
 * The 22px bar along the bottom, which owns the ambient facts.
 *
 * They used to sit as chips above the input: where you are, which branch, how much
 * is uncommitted. That put standing state inside the thing you type into, so the
 * composer grew every time the app learned something new about your surroundings —
 * and the facts moved every time the composer did. Down here they have one place,
 * one type size, and the composer goes back to being an input.
 *
 * The right-hand group has two readings. With a terminal in front of you it is where
 * you are and which shell that is; with a file in front of you it becomes the file's
 * own context — the caret, the indentation, the encoding, the language — because
 * those are the facts you are working against, and the directory a shell happens to
 * be standing in is not one of them while you are editing.
 *
 * Nothing is computed here that is not already in the store or in the buffer. The
 * counts are the same ones the activity rail badges read, deliberately: two places
 * reporting different numbers for the same repository is worse than not reporting
 * at all.
 */
export function StatusBar(): React.JSX.Element | null {
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)
  const profiles = useStore((s) => s.profiles)
  const workspaceGit = useStore((s) => s.gitStatus)
  const cwdGit = useStore((s) => s.cwdGit)
  const showSidebarView = useStore((s) => s.showSidebarView)
  const setNotice = useStore((s) => s.setNotice)
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
   * An editor, and only an editor, turns the right-hand group into a file's context.
   * A diff pane is deliberately not one: it is two snapshots side by side with no
   * caret to report and nothing to save, so it keeps the terminal reading rather
   * than showing a position that belongs to some other pane.
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
      {branch && (
        <button
          className="statusbar__item"
          data-status="branch"
          aria-label={`Branch ${branch}. Open source control`}
          title={git?.upstream ?? 'No upstream'}
          onClick={() => showSidebarView('scm')}
        >
          <svg viewBox="0 0 16 16" className="statusbar__icon" aria-hidden="true">
            <circle cx="4.5" cy="3.5" r="1.6" />
            <circle cx="4.5" cy="12.5" r="1.6" />
            <circle cx="11.5" cy="3.5" r="1.6" />
            <path d="M4.5 5.1v5.8M11.5 5.1v1.3a2.8 2.8 0 0 1-2.8 2.8H4.5" />
          </svg>
          {branch}
        </button>
      )}
      {changed !== null && (
        <button
          className="statusbar__item statusbar__num"
          data-status="changes"
          aria-label={`${changed} changed ${changed === 1 ? 'path' : 'paths'}. Open source control`}
          onClick={() => showSidebarView('scm')}
        >
          ± {changed}
        </button>
      )}
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

      <span className="statusbar__gap" />

      <ClaudeStatus />
      {file ? (
        <>
          {cursorAt && (
            <button
              className="statusbar__item"
              data-status="position"
              /* The bar is a live region so the error and warning counts announce
                 themselves as they change. The caret is not that kind of fact: it
                 changes on every arrow press, and an atomic live region re-reads
                 the whole bar each time — branch, counts, model, encoding and all.
                 It is opted out here rather than the region being weakened. */
              aria-live="off"
              aria-label={
                `Line ${cursorAt.line}, column ${cursorAt.column}` +
                (cursorAt.selected > 1 ? `, ${cursorAt.selected} characters selected` : '') +
                '. Go to line'
              }
              title="Go to line"
              onClick={goToLine}
            >
              {position}
            </button>
          )}
          {indent && (
            <span className="statusbar__label statusbar__num" data-status="indent" aria-live="off">
              {`${indent.spaces ? 'Spaces' : 'Tab Size'}: ${indent.width}`}
            </span>
          )}
          {/* Everything this app reads and writes is UTF-8 — stated rather than
              detected, because a value that is always the same is not a reading,
              and a control that cannot change it should not look like one. */}
          <span className="statusbar__label">UTF-8</span>
          <span className="statusbar__label" data-status="language">
            {languageName(file.language)}
          </span>
        </>
      ) : (
        <>
          {cwd && (
            <button
              className="statusbar__item statusbar__path"
              data-status="cwd"
              aria-label={`Working directory ${cwd}. Copy path`}
              title={cwd}
              onClick={copyPath}
            >
              {shortenPath(cwd, 42)}
            </button>
          )}
          {shell && (
            <span className="statusbar__label" data-status="shell">
              {shell}
            </span>
          )}
          <span className="statusbar__label">UTF-8</span>
        </>
      )}
    </div>
  )
}
