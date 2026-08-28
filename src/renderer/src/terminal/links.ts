/**
 * Paths and URLs in finished output, found under the pointer.
 *
 * The obvious approach — rewrite the serialized markup to wrap tokens in
 * anchors — breaks on the first colored compiler message: a program is free to
 * paint `src/foo.ts` and `:42` in different spans, and a wrapper would have to
 * splice elements across that boundary, after which the copy button, selection
 * and the ruler all read whatever was left behind. So the markup is never
 * touched. A hit is computed from the pointer instead: the caret position under
 * the cursor gives a text node and offset, the enclosing row gives one line of
 * plain text, and a scan of that line says whether the offset sits inside
 * something openable. The affordance is painted with the CSS highlight API,
 * which owns nothing — the same bargain the find bar struck.
 */

export interface LinkHit {
  kind: 'url' | 'file'
  /** The token as printed, before any trimming for punctuation. */
  text: string
  /** For a url hit, the address to hand the browser. */
  url?: string
  /** For a file hit, the path as written — possibly relative to the block's cwd. */
  path?: string
  /** 1-based, when the token carried them. */
  line?: number
  column?: number
  /** The exact span on screen, for the underline. */
  range: Range
}

/*
 * One alternation, ordered by how much a match claims: a URL swallows colons and
 * slashes that would otherwise read as a path; an absolute Windows path owns its
 * drive colon before the line-number parse sees it; a relative path must contain
 * a separator so ordinary prose words never light up; and a bare `file.ext:12`
 * is allowed only with the line number, which is what distinguishes a compiler
 * message from a sentence that happens to mention "index.ts".
 */
const TOKEN = new RegExp(
  [
    String.raw`https?://[^\s"'<>]+`,
    String.raw`[A-Za-z]:[\\/][^\s"'<>|*?]+`,
    String.raw`(?:\.{1,2}[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+(?::\d+(?::\d+)?)?`,
    String.raw`[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,7}:\d+(?::\d+)?`
  ].join('|'),
  'g'
)

/** Punctuation a sentence hangs on a token's end that is never part of it. */
const TRAILING = /[).,;:!?\]'"]+$/

/** `path:12:3`, `path:12`, or MSVC's `path(12,3)`, taken off the end. */
function splitPosition(token: string): { path: string; line?: number; column?: number } {
  const paren = token.match(/\((\d+),(\d+)\)$/)
  if (paren) {
    return {
      path: token.slice(0, -paren[0].length),
      line: Number(paren[1]),
      column: Number(paren[2])
    }
  }
  // The drive colon is structural, so only colons after position 1 count.
  const colon = token.slice(2).match(/:(\d+)(?::(\d+))?$/)
  if (colon) {
    return {
      path: token.slice(0, token.length - colon[0].length),
      line: Number(colon[1]),
      column: colon[2] ? Number(colon[2]) : undefined
    }
  }
  return { path: token }
}

/** The caret under a point, by whichever name this Chromium offers it. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y)
    return r ? { node: r.startContainer, offset: r.startOffset } : null
  }
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y)
    return p ? { node: p.offsetNode, offset: p.offset } : null
  }
  return null
}

/**
 * The openable token under the pointer, if the pointer is on one.
 *
 * `root` bounds the search — a hit is only reported for text inside it, so a
 * caller hands in its own block body and can never claim a neighbour's text.
 */
export function linkHitAt(root: HTMLElement, x: number, y: number): LinkHit | null {
  const caret = caretAt(x, y)
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null
  if (!root.contains(caret.node)) return null

  // One rendered line of output. Falling back to the body covers a block whose
  // output happens not to be row-shaped (the "no output" placeholders never
  // reach here — they hold no matchable text).
  const row = (caret.node.parentElement?.closest('.row') ?? root) as HTMLElement

  // The caret's offset within the row's whole text, spans notwithstanding.
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let before = 0
  let text = ''
  let found = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === caret.node) {
      before = text.length
      found = true
    }
    text += n.textContent ?? ''
  }
  if (!found) return null
  const at = before + caret.offset

  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    let token = m[0]
    const isUrl = /^https?:\/\//.test(token)
    // A URL keeps a balanced closing paren (Wikipedia-style); everything else
    // trailing is a sentence's, not the token's.
    const trimmed = token.replace(TRAILING, '')
    token =
      isUrl && token.endsWith(')') && (token.match(/\(/g) ?? []).length >= (token.match(/\)/g) ?? []).length
        ? token
        : trimmed
    const start = m.index
    const end = start + token.length
    if (at < start || at >= end) continue

    const range = rangeFor(row, start, end)
    if (!range) return null
    if (isUrl) return { kind: 'url', text: token, url: token, range }

    const { path, line, column } = splitPosition(token)
    // A "path" that lost its name to trimming, or a lone extensionless word
    // that slipped through, opens nothing.
    if (path.length < 2) return null
    return { kind: 'file', text: token, path, line, column, range }
  }
  return null
}

/** Map character offsets within a row back to a DOM range across its spans. */
function rangeFor(row: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let seen = 0
  let placedStart = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = (n.textContent ?? '').length
    if (!placedStart && start < seen + len) {
      range.setStart(n, start - seen)
      placedStart = true
    }
    if (placedStart && end <= seen + len) {
      range.setEnd(n, end - seen)
      return range
    }
    seen += len
  }
  return null
}

/*
 * The underline, painted over whatever span colours the token already has.
 * One highlight for the whole app: only one pointer, only one hovered link.
 */
type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void }

export function setLinkHighlight(range: Range | null): void {
  const highlights = (CSS as unknown as { highlights?: HighlightRegistry }).highlights
  const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  if (!highlights || !Ctor) return
  if (range) highlights.set('ember-link', new Ctor(range))
  else highlights.delete('ember-link')
}
