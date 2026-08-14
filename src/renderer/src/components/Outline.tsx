import { useEffect, useState } from 'react'
import { activeDocument, useStore } from '../state/store'
import { serverFor } from '../editor/lsp'

interface Symbol {
  name: string
  kind: number
  line: number
  column: number
  depth: number
}

/**
 * The symbols in the file being edited.
 *
 * Asked of the language server directly rather than read from Monaco, because
 * Monaco's client registers a document-symbol provider without offering any way to
 * invoke it — the outline is a thing the server already knows and the editor has no
 * public route to.
 *
 * Re-read when the file changes rather than on every keystroke: an outline that
 * reshuffles while a name is half-typed is worse than one that is a moment behind.
 */
export function Outline(): React.JSX.Element | null {
  const panes = useStore((s) => s.panes)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const [symbols, setSymbols] = useState<Symbol[]>([])
  const [collapsed, setCollapsed] = useState(false)

  // The document on screen, if the active pane is an editor.
  const tab = tabs.find((t) => t.id === activeTabId)
  const pane = tab ? panes[tab.activePaneId] : undefined
  const document = pane?.kind === 'editor' ? activeDocument(pane) : null
  const filePath = document?.filePath ?? null
  const language = document?.language ?? null

  useEffect(() => {
    if (!filePath || !language) {
      setSymbols([])
      return
    }
    const server = serverFor(language)
    if (!server) {
      setSymbols([])
      return
    }

    let live = true
    const load = (): void => {
      void window.ember
        .lspRequest(server, 'textDocument/documentSymbol', {
          textDocument: { uri: toUri(filePath) }
        })
        .then((result) => {
          if (live) setSymbols(flatten(result))
        })
    }

    /*
     * Asked again as the file changes, and as the server catches up.
     *
     * This was a single request made when the view mounted, so the outline showed
     * the file as it was when the sidebar opened and never moved again — and if the
     * language server had not finished starting, it stayed empty for the rest of
     * the session with nothing to say why. Polling is the honest tool here: the
     * server pushes diagnostics but not symbols, so there is nothing to subscribe
     * to, and the request is cheap against a document the server already has open.
     */
    load()
    // `window.document`: the component's own `document` is the open file.
    const timer = window.setInterval(() => {
      if (window.document.visibilityState === 'visible') load()
    }, 2500)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [filePath, language])

  if (!filePath || symbols.length === 0) return null

  return (
    <div className="outline">
      <button className="outline__head" onClick={() => setCollapsed((v) => !v)}>
        <span className="tree__twisty">{collapsed ? '▸' : '▾'}</span>
        <span>Outline</span>
        <span className="scm__count">{symbols.length}</span>
      </button>

      {!collapsed && (
        <div className="outline__body">
          {symbols.map((symbol, i) => (
            <button
              key={`${symbol.name}:${symbol.line}:${i}`}
              className="outline__row"
              style={{ paddingLeft: 10 + symbol.depth * 12 }}
              title={`${symbol.name} — line ${symbol.line}`}
              onClick={() => reveal(filePath, symbol.line, symbol.column)}
            >
              <span className="outline__kind">{KIND_LABEL[symbol.kind] ?? '•'}</span>
              <span className="outline__name">{symbol.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function toUri(filePath: string): string {
  return `file:///${filePath.replace(/\\/g, '/').replace(/^\//, '')}`
}

/**
 * Both shapes the protocol allows: a flat list of SymbolInformation, or a nested
 * tree of DocumentSymbol. Servers pick one and never say which.
 */
interface RawSymbol {
  name?: unknown
  kind?: unknown
  /** DocumentSymbol carries its own ranges; SymbolInformation nests one in location. */
  selectionRange?: { start: { line: number; character: number } }
  range?: { start: { line: number; character: number } }
  location?: { range?: { start: { line: number; character: number } } }
  children?: unknown
}

function flatten(result: unknown, depth = 0): Symbol[] {
  if (!Array.isArray(result)) return []
  const out: Symbol[] = []
  for (const item of result as RawSymbol[]) {
    const range = item.selectionRange ?? item.range ?? item.location?.range
    if (!range) continue
    out.push({
      name: String(item.name ?? ''),
      kind: Number(item.kind ?? 0),
      line: range.start.line + 1,
      column: range.start.character,
      depth
    })
    if (Array.isArray(item.children)) out.push(...flatten(item.children, depth + 1))
  }
  return out
}

function reveal(filePath: string, line: number, column: number): void {
  void (async () => {
    const { modelUri, monaco } = await import('../editor/monaco')
    const model = monaco.editor.getModel(modelUri(filePath))
    if (!model) return
    for (const editor of monaco.editor.getEditors()) {
      if (editor.getModel() !== model) continue
      editor.setSelection({
        startLineNumber: line,
        startColumn: column + 1,
        endLineNumber: line,
        endColumn: column + 1
      })
      editor.revealLineInCenter(line)
      editor.focus()
    }
  })()
}

/**
 * A short label per symbol kind, from the protocol's numbering. Text rather than
 * icons so it works in any theme without an icon font, and so a kind this list has
 * not learned yet degrades to a dot rather than a blank.
 */
const KIND_LABEL: Record<number, string> = {
  1: 'file',
  2: 'mod',
  3: 'ns',
  4: 'pkg',
  5: 'class',
  6: 'fn',
  7: 'prop',
  8: 'field',
  9: 'ctor',
  10: 'enum',
  11: 'iface',
  12: 'fn',
  13: 'var',
  14: 'const',
  15: 'str',
  16: 'num',
  17: 'bool',
  18: 'arr',
  21: 'null',
  22: 'enum',
  23: 'struct',
  26: 'type'
}
