import { useEffect, useMemo, useState } from 'react'
import { pathKey } from '@shared/paths'
import { monaco } from '../editor/monaco'
import { useStore, workspaceRoot } from '../state/store'

interface Props {
  onOpen: (filePath: string, line: number, column: number) => void
}

export interface Problem {
  file: string
  line: number
  column: number
  severity: number
  message: string
  source: string | null
  code: string | null
}

/**
 * Every diagnostic across every open file.
 *
 * Read from Monaco's markers rather than asked of the language servers, because
 * the markers are what the servers already put there and what the squiggles are
 * drawn from — so this list and the editor can never disagree about what is wrong.
 *
 * It only covers files that are open. A whole-project problem list would mean
 * asking servers to analyse files nobody has looked at, which is a different and
 * much more expensive feature than showing what is already known.
 */
export function useProblems(): Problem[] {
  const [problems, setProblems] = useState<Problem[]>([])

  useEffect(() => {
    const read = (): void => {
      const markers = monaco.editor.getModelMarkers({})
      setProblems(
        markers
          .filter((m) => m.resource.scheme === 'file')
          .map((m) => ({
            file: m.resource.fsPath,
            line: m.startLineNumber,
            column: m.startColumn,
            severity: m.severity,
            message: m.message,
            source: m.source ?? null,
            code: typeof m.code === 'string' ? m.code : (m.code?.value ?? null)
          }))
          // Worst first within a file, then by position, so the thing most worth
          // looking at is the thing at the top.
          .sort(
            (a, b) =>
              a.file.localeCompare(b.file) || b.severity - a.severity || a.line - b.line
          )
      )
    }

    read()
    const sub = monaco.editor.onDidChangeMarkers(() => read())
    return () => sub.dispose()
  }, [])

  return problems
}

/** Monaco's numeric severities. 8 is an error, 4 a warning, below that advice. */
function severityWord(severity: number): string {
  if (severity === 8) return 'error'
  if (severity === 4) return 'warning'
  return 'info'
}

export function ProblemsPanel({ onOpen }: Props): React.JSX.Element {
  const problems = useProblems()
  const treeRoot = useStore(workspaceRoot)
  const panes = useStore((s) => s.panes)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  /*
   * How the file is really spelled, rather than how its marker spells it.
   *
   * Model URIs are built from a lowercased path, so that two spellings of one file
   * on a case-insensitive filesystem cannot become two buffers. That lowercasing
   * comes back out on every marker, and it showed: the panel labelled problems
   * `c:/users/…` where the rest of the app says `C:\Users\…`, and because the
   * lowercased path never matched the workspace root, every problem was named by
   * its full absolute path instead of a short relative one. The open document —
   * and a problem is only ever reported for an open document — knows the answer.
   */
  const spelling = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const pane of Object.values(panes)) {
      if (pane.kind !== 'editor') continue
      for (const doc of pane.documents) {
        if (doc.filePath) byKey.set(pathKey(doc.filePath), doc.filePath)
      }
    }
    return (file: string): string => byKey.get(pathKey(file)) ?? file
  }, [panes])

  const groups = useMemo(() => {
    const byFile = new Map<string, Problem[]>()
    for (const problem of problems) {
      const list = byFile.get(problem.file) ?? []
      list.push(problem)
      byFile.set(problem.file, list)
    }
    return [...byFile]
  }, [problems])

  if (problems.length === 0) {
    return <div className="probs probs--empty">No problems in the open files.</div>
  }

  // Compared without regard to case, because the workspace root and the path a
  // file was opened by need not agree on the spelling of a drive letter.
  const relative = (full: string): string => {
    const slashed = spelling(full).replace(/\\/g, '/')
    if (!treeRoot) return slashed
    const root = treeRoot.replace(/\\/g, '/').replace(/\/$/, '')
    return pathKey(slashed).startsWith(`${pathKey(root)}/`) ? slashed.slice(root.length + 1) : slashed
  }

  const errors = problems.filter((p) => p.severity === 8).length
  const warnings = problems.filter((p) => p.severity === 4).length

  return (
    <div className="probs">
      <div className="probs__summary">
        {errors > 0 && <span className="git--deleted">{errors} error{errors === 1 ? '' : 's'}</span>}
        {warnings > 0 && (
          <span className="gh__checks--pending">
            {warnings} warning{warnings === 1 ? '' : 's'}
          </span>
        )}
        <span className="scm__count">{problems.length}</span>
      </div>

      <div className="probs__body">
        {groups.map(([file, list]) => {
          const shut = collapsed.has(file)
          return (
            <div key={file}>
              <button
                className="find__file"
                title={spelling(file)}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(file)) next.delete(file)
                    else next.add(file)
                    return next
                  })
                }
              >
                <span className="tree__twisty">{shut ? '▸' : '▾'}</span>
                <span className="find__name">{relative(file).split('/').pop()}</span>
                <span className="find__dir">{relative(file).split('/').slice(0, -1).join('/')}</span>
                <span className="scm__count">{list.length}</span>
              </button>

              {!shut &&
                list.map((problem, i) => (
                  <button
                    key={`${problem.line}:${problem.column}:${i}`}
                    className="probs__row"
                    title={problem.message}
                    onClick={() => onOpen(spelling(problem.file), problem.line, problem.column - 1)}
                  >
                    {/*
                      A glyph as well as a colour, and a name for a screen reader.
                      Severity was carried by colour alone, which no palette can fix
                      for a colour vision deficiency — and in one of the shipped
                      colourblind-safe themes error and warning were the identical
                      colour, so the distinction was invisible to everyone.
                    */}
                    <span
                      className={`probs__dot probs__dot--${severityWord(problem.severity)}`}
                      aria-label={severityWord(problem.severity)}
                      title={severityWord(problem.severity)}
                    >
                      {problem.severity === 8 ? '✕' : problem.severity === 4 ? '⚠' : 'ⓘ'}
                    </span>
                    <span className="probs__message">{problem.message.split('\n')[0]}</span>
                    <span className="probs__where">
                      {problem.source ? `${problem.source} ` : ''}
                      {problem.line}:{problem.column}
                    </span>
                  </button>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
