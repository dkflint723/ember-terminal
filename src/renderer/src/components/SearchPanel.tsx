import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SearchHit } from '@shared/types'
import { useStore } from '../state/store'

/**
 * Search across the workspace.
 *
 * Debounced rather than searched per keystroke: ripgrep is fast, but spawning it
 * on every character and killing it again wastes work and makes results flicker
 * between partial answers.
 */
const DEBOUNCE_MS = 250

interface Props {
  /** Opens a file and puts the cursor on a match. */
  onOpen: (filePath: string, line: number, column: number) => void
}

export function SearchPanel({ onOpen }: Props): React.JSX.Element {
  const treeRoot = useStore((s) => s.treeRoot)
  const [text, setText] = useState('')
  const [include, setInclude] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [replacement, setReplacement] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const box = useRef<HTMLInputElement>(null)
  const panes = useStore((s) => s.panes)
  const reloadFromDisk = useStore((s) => s.reloadFromDisk)

  // Files with unsaved edits are not replaced in. The edit is made on disk, and a
  // file whose editor holds newer text would either lose that text or silently
  // disagree with what is on screen.
  const unsaved = useMemo(() => {
    const set = new Set<string>()
    for (const pane of Object.values(panes)) {
      if (pane.kind !== 'editor') continue
      for (const doc of pane.documents) if (doc.dirty && doc.filePath) set.add(doc.filePath)
    }
    return set
  }, [panes])

  useEffect(() => {
    box.current?.focus()
  }, [])

  // A report of the last replacement describes results that no longer exist once
  // the query moves on.
  useEffect(() => setNote(null), [text, include, caseSensitive, wholeWord, regex])

  const run = useCallback(async (): Promise<void> => {
    if (!treeRoot || !text.trim()) {
      setHits([])
      setError(null)
      setTruncated(false)
      return
    }
    setSearching(true)
    const res = await window.ember.search({
      root: treeRoot,
      text,
      caseSensitive,
      wholeWord,
      regex,
      include
    })
    setSearching(false)
    if (res.ok) {
      setHits(res.hits)
      setTruncated(res.truncated)
      setError(null)
    } else {
      setHits([])
      setTruncated(false)
      setError(res.error)
    }
  }, [treeRoot, text, caseSensitive, wholeWord, regex, include])

  useEffect(() => {
    const timer = window.setTimeout(() => void run(), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [run])

  /**
   * Replace the matches in `scope`, or every match when no file is named.
   *
   * The hits are sent as they are: they are what the user is looking at, and the
   * results they were found in are the only description of the change that is
   * guaranteed to agree with what is on screen.
   */
  const replaceIn = async (scope?: string): Promise<void> => {
    const targets = hits.filter((h) => (!scope || h.path === scope) && !unsaved.has(h.path))
    const held = new Set(
      hits.filter((h) => (!scope || h.path === scope) && unsaved.has(h.path)).map((h) => h.path)
    )
    if (targets.length === 0) {
      setNote(
        held.size > 0 ? 'Save those files first — they have unsaved changes.' : 'Nothing to replace.'
      )
      return
    }

    setReplacing(true)
    const res = await window.ember.replaceInFiles({
      hits: targets,
      replacement,
      pattern: text,
      regex,
      caseSensitive
    })
    setReplacing(false)

    if (!res.ok) {
      setNote(res.error ?? 'The replacement could not be completed.')
      return
    }

    await reloadFromDisk([...new Set(targets.map((h) => h.path))])
    const parts = [
      `Replaced ${res.replaced} ${res.replaced === 1 ? 'match' : 'matches'} in ${res.files} ${
        res.files === 1 ? 'file' : 'files'
      }`
    ]
    // Both of these are the user's to know about: one is work not done, and the
    // other is a result that had gone out of date before it was acted on.
    if (held.size > 0) parts.push(`${held.size} with unsaved changes skipped`)
    if (res.stale > 0) parts.push(`${res.stale} no longer matched`)
    setNote(`${parts.join(', ')}.`)
    await run()
  }

  // Grouped by file, in the order ripgrep found them, so results stay stable as
  // more arrive rather than reshuffling under the pointer.
  const groups = useMemo(() => {
    const byFile = new Map<string, SearchHit[]>()
    for (const hit of hits) {
      const list = byFile.get(hit.path) ?? []
      list.push(hit)
      byFile.set(hit.path, list)
    }
    return [...byFile]
  }, [hits])

  if (!treeRoot) return <div className="find find--empty">Open a folder to search it.</div>

  const relative = (full: string): string =>
    full.replace(/\\/g, '/').replace(`${treeRoot.replace(/\\/g, '/')}/`, '')

  return (
    <div className="find">
      <div className="find__controls">
        <input
          ref={box}
          className="find__box"
          placeholder="Search"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
            if (e.key === 'Escape') setText('')
          }}
        />
        <div className="find__toggles">
          {/* Letter labels rather than icons: Aa, ab and .* are what these mean in
              every editor, and they survive a theme with no icon font. */}
          <button
            className={`find__toggle ${caseSensitive ? 'find__toggle--on' : ''}`}
            title="Match case"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
          <button
            className={`find__toggle ${wholeWord ? 'find__toggle--on' : ''}`}
            title="Match whole word"
            onClick={() => setWholeWord((v) => !v)}
          >
            ab
          </button>
          <button
            className={`find__toggle ${regex ? 'find__toggle--on' : ''}`}
            title="Use a regular expression"
            onClick={() => setRegex((v) => !v)}
          >
            .*
          </button>
        </div>
        <div className="find__row">
          <input
            className="find__box"
            placeholder="Replace"
            value={replacement}
            spellCheck={false}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void replaceIn()
            }}
          />
          <button
            className="find__replace"
            title="Replace all"
            disabled={replacing || hits.length === 0}
            onClick={() => void replaceIn()}
          >
            {replacing ? '…' : 'Replace All'}
          </button>
        </div>
        <input
          className="find__box find__box--glob"
          placeholder="Files to include, e.g. *.ts"
          value={include}
          spellCheck={false}
          onChange={(e) => setInclude(e.target.value)}
        />
      </div>

      <div className="find__summary">
        {error && <span className="find__error">{error}</span>}
        {!error && searching && <span>Searching…</span>}
        {!error && !searching && text.trim().length > 0 && (
          <span>
            {hits.length === 0
              ? 'No results'
              : `${hits.length} ${hits.length === 1 ? 'result' : 'results'} in ${groups.length} ${
                  groups.length === 1 ? 'file' : 'files'
                }`}
            {truncated && ' (showing the first 2000)'}
          </span>
        )}
        {note && <span className="find__note">{note}</span>}
      </div>

      <div className="find__body">
        {groups.map(([file, fileHits]) => {
          const shut = collapsed.has(file)
          return (
            <div key={file} className="find__group">
              {/* Two siblings rather than one nested inside the other: a button
                  inside a button is not something a browser will lay out. */}
              <div className="find__filerow">
                <button
                  className="find__file"
                  title={file}
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
                  <span className="find__dir">
                    {relative(file).split('/').slice(0, -1).join('/')}
                  </span>
                  <span className="scm__count">{fileHits.length}</span>
                </button>
                <button
                  className="find__replace find__replace--file"
                  title={unsaved.has(file) ? 'Save this file first' : 'Replace in this file'}
                  disabled={replacing || unsaved.has(file)}
                  onClick={() => void replaceIn(file)}
                >
                  Replace
                </button>
              </div>

              {!shut &&
                fileHits.map((hit, i) => (
                  <button
                    key={`${hit.line}:${hit.column}:${i}`}
                    className="find__hit"
                    title={`${relative(file)}:${hit.line}`}
                    onClick={() => onOpen(hit.path, hit.line, hit.column)}
                  >
                    <span className="find__line">{hit.line}</span>
                    <span className="find__preview">
                      {hit.preview.slice(0, hit.column)}
                      <mark>{hit.preview.slice(hit.column, hit.column + hit.length)}</mark>
                      {hit.preview.slice(hit.column + hit.length)}
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
