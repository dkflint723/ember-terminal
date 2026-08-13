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
  const box = useRef<HTMLInputElement>(null)

  useEffect(() => {
    box.current?.focus()
  }, [])

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
      </div>

      <div className="find__body">
        {groups.map(([file, fileHits]) => {
          const shut = collapsed.has(file)
          return (
            <div key={file} className="find__group">
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
                <span className="find__dir">{relative(file).split('/').slice(0, -1).join('/')}</span>
                <span className="scm__count">{fileHits.length}</span>
              </button>

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
