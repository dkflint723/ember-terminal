import { monaco } from './monaco'

/**
 * The change bars in the editor margin: what this buffer says that HEAD does
 * not, computed live against the committed text — the buffer, not the file on
 * disk, because the edit you are mid-way through is exactly what the gutter is
 * for. Green is new, blue is changed, a red wedge is where lines used to be.
 * Alt+click on a mark puts that hunk back the way HEAD has it, as one undoable
 * edit.
 */

export interface GutterHunk {
  /** 1-based first line of the hunk in the buffer. */
  start: number
  /** How many buffer lines the hunk spans; 0 for a pure deletion marker. */
  count: number
  /** The lines HEAD holds where this hunk stands — what a revert restores. */
  before: string[]
  kind: 'added' | 'modified' | 'deleted'
}

/**
 * Line-level diff, Myers' O(ND) on line hashes. Small and honest: files a
 * gutter serves are thousands of lines, not millions, and the greedy middle
 * of the algorithm is all this needs — no snakes are stored, just enough
 * trace to walk the edit script back out.
 */
function diffLines(a: string[], b: string[]): GutterHunk[] {
  // Common prefix and suffix first: most edits touch a small middle.
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++
  let hiA = a.length
  let hiB = b.length
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--
    hiB--
  }
  const midA = a.slice(lo, hiA)
  const midB = b.slice(lo, hiB)

  const n = midA.length
  const m = midB.length
  const max = n + m
  if (max === 0) return []

  // Myers, keeping each round's frontier so the path can be traced back.
  const offset = max
  const width = 2 * max + 1
  let v = new Int32Array(width)
  const trace: Int32Array[] = []
  let found = -1
  outer: for (let d = 0; d <= max; d++) {
    const next = Int32Array.from(v)
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]
      } else {
        x = v[offset + k - 1] + 1
      }
      let y = x - k
      while (x < n && y < m && midA[x] === midB[y]) {
        x++
        y++
      }
      next[offset + k] = x
      if (x >= n && y >= m) {
        trace.push(next)
        found = d
        break outer
      }
    }
    trace.push(next)
    v = next
  }
  if (found === -1) return []

  // Walk back: collect, per position in b, whether each line is kept or new,
  // and where deletions fall.
  const opsB = new Uint8Array(m) // 1 = inserted
  const delAfterB = new Uint32Array(m + 1) // deletions landing before b-index
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = prev[offset + prevK]
    const prevY = prevX - prevK
    // Slide back over the snake.
    while (x > prevX && y > prevY) {
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) {
        // An insertion into b.
        y--
        opsB[y] = 1
      } else {
        // A deletion from a.
        x--
        delAfterB[y] += 1
      }
    }
  }

  // Fold runs of inserted/deleted lines into hunks, in buffer coordinates.
  const hunks: GutterHunk[] = []
  let i = 0
  let aAt = 0 // index into midA of the next unconsumed HEAD line
  while (i <= m) {
    const deletions = delAfterB[i]
    let inserted = 0
    while (i + inserted < m && opsB[i + inserted] === 1) inserted++

    if (deletions > 0 || inserted > 0) {
      const before = midA.slice(aAt, aAt + deletions)
      aAt += deletions
      const startLine = lo + i + 1
      if (inserted > 0) {
        hunks.push({
          start: startLine,
          count: inserted,
          before,
          kind: deletions > 0 ? 'modified' : 'added'
        })
      } else {
        hunks.push({ start: startLine, count: 0, before, kind: 'deleted' })
      }
      i += inserted
      continue
    }
    aAt += 1
    i += 1
  }
  return hunks
}

const HOVER = 'Changed against HEAD — Alt+click the mark to revert this hunk.'

export function computeGutters(headText: string, bufferText: string): GutterHunk[] {
  return diffLines(headText.split('\n'), bufferText.split('\n'))
}

/** Decorations for a set of hunks, ready for deltaDecorations. */
export function gutterDecorations(hunks: GutterHunk[]): monaco.editor.IModelDeltaDecoration[] {
  return hunks.map((hunk) => {
    if (hunk.kind === 'deleted') {
      const line = Math.max(1, hunk.start)
      return {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          linesDecorationsClassName: 'gutter-deleted',
          linesDecorationsTooltip: HOVER
        }
      }
    }
    return {
      range: new monaco.Range(hunk.start, 1, hunk.start + hunk.count - 1, 1),
      options: {
        isWholeLine: false,
        linesDecorationsClassName: `gutter-${hunk.kind}`,
        linesDecorationsTooltip: HOVER
      }
    }
  })
}

/** The hunk whose mark sits on `line`, if any. */
export function hunkAtLine(hunks: GutterHunk[], line: number): GutterHunk | null {
  for (const hunk of hunks) {
    if (hunk.kind === 'deleted') {
      if (hunk.start === line) return hunk
    } else if (line >= hunk.start && line < hunk.start + hunk.count) {
      return hunk
    }
  }
  return null
}

/** Put one hunk back the way HEAD has it, as a single undoable edit. */
export function revertHunk(editor: monaco.editor.ICodeEditor, hunk: GutterHunk): void {
  const model = editor.getModel()
  if (!model) return
  const eol = model.getEOL()
  let range: InstanceType<typeof monaco.Range>
  let text: string
  if (hunk.kind === 'deleted') {
    // The lines were removed ahead of `start`; put them back in front of it.
    const insertAt = Math.min(hunk.start, model.getLineCount())
    range = new monaco.Range(insertAt, 1, insertAt, 1)
    text = hunk.before.join(eol) + eol
  } else if (hunk.before.length === 0) {
    // Pure addition: take the lines out, terminator and all.
    const lastLine = hunk.start + hunk.count - 1
    if (lastLine < model.getLineCount()) {
      range = new monaco.Range(hunk.start, 1, lastLine + 1, 1)
    } else {
      const prev = Math.max(1, hunk.start - 1)
      range = new monaco.Range(prev, model.getLineMaxColumn(prev), lastLine, model.getLineMaxColumn(lastLine))
    }
    text = ''
  } else {
    const lastLine = hunk.start + hunk.count - 1
    range = new monaco.Range(hunk.start, 1, lastLine, model.getLineMaxColumn(lastLine))
    text = hunk.before.join(eol)
  }
  editor.pushUndoStop()
  editor.executeEdits('gutter-revert', [{ range, text }])
  editor.pushUndoStop()
}
