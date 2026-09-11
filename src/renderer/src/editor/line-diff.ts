/**
 * The line diff behind the change bars in the editor margin, as plain data.
 *
 * Kept apart from Monaco so it can be run, and held to account, outside a window:
 * scripts/test-line-diff.mjs checks it against the two ways it went wrong.
 *
 * Every line of a CRLF file was marked as changed. HEAD comes back from git as
 * the blob, LF, while the buffer's text was taken with the model's own line
 * endings and both were split on "\n" — so every buffer line carried a "\r" the
 * HEAD line did not, and a file nobody had touched showed as rewritten top to
 * bottom. That is the Git for Windows default: core.autocrlf keeps LF in the index
 * and CRLF in the working tree. Lines are compared without their endings now.
 *
 * And the diff's memory grew with edits times length. The trace behind the walk
 * back kept a full-width array for every round, so a file whose every line
 * differed — which, above, was every CRLF file — retained about 72 MB at 1,500
 * lines and would have reached a gigabyte at 6,000, re-run 300 ms after each pause
 * in typing. Each round now keeps only the diagonals it used, and past MAX_EDITS
 * the changed stretch is reported as one hunk instead of line by line.
 */

export interface LineHunk {
  /** 1-based first line of the hunk in the buffer. */
  start: number
  /** How many buffer lines the hunk spans; 0 for a pure deletion marker. */
  count: number
  /** The lines HEAD holds where this hunk stands — what a revert restores. */
  before: string[]
  kind: 'added' | 'modified' | 'deleted'
}

/**
 * How many single-line edits the per-line diff will look for before calling the
 * changed stretch one hunk. The trace it keeps is about (edits²) × 4 bytes — 4 MB
 * here — and the time about edits × lines; a margin with more marks than this is
 * not read line by line anyway.
 */
export const MAX_EDITS = 1000

/**
 * And how long the changed stretch may be at all. Past this the diff is not
 * attempted: comparing is linear in it per round, and 40,000 lines of difference
 * is a rewrite, which one mark says as well as a thousand would.
 */
export const MAX_SPAN = 40_000

/** HEAD's text as lines, whatever line endings it was stored with. */
export function linesOf(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/** One hunk for the whole changed stretch, when it is too big to diff line by line. */
function wholeStretch(lo: number, midA: string[], midB: string[]): LineHunk[] {
  if (midB.length === 0) return [{ start: lo + 1, count: 0, before: midA, kind: 'deleted' }]
  return [
    { start: lo + 1, count: midB.length, before: midA, kind: midA.length === 0 ? 'added' : 'modified' }
  ]
}

/**
 * Line-level diff of HEAD's lines against the buffer's, as hunks in buffer
 * coordinates: Myers' O(ND), after trimming the common beginning and end, which
 * is where most of a file is while it is being edited.
 */
export function diffLines(a: string[], b: string[]): LineHunk[] {
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
  if (n + m === 0) return []
  if (n + m > MAX_SPAN) return wholeStretch(lo, midA, midB)

  // Myers. `v` holds, per diagonal k, the furthest x reached; rounds write only
  // the diagonals of their own parity, so it can be updated in place. Each round's
  // diagonals are copied out — just -d..d of them — for the walk back.
  const limit = Math.min(n + m, MAX_EDITS)
  const offset = limit + 1
  const v = new Int32Array(2 * limit + 3)
  const trace: Int32Array[] = []
  let found = -1
  outer: for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && midA[x] === midB[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1))
        found = d
        break outer
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }
  if (found === -1) return wholeStretch(lo, midA, midB)

  // Walk back: per buffer line, whether it is new, and where HEAD's lines were
  // taken out.
  const opsB = new Uint8Array(m) // 1 = inserted
  const delAfterB = new Uint32Array(m + 1) // deletions landing before b-index
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]
    // Round d-1 kept diagonals -(d-1)..(d-1), stored from index 0.
    const at = (k: number): number => prev[k + d - 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    // Slide back over the snake.
    while (x > prevX && y > prevY) {
      x--
      y--
    }
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

  /*
   * Fold runs of inserted and deleted lines into hunks, in buffer coordinates.
   *
   * A pure deletion — a whole line taken out of a committed file — used to loop
   * here for ever: its hunk was pushed, the position advanced by the number of
   * lines inserted, which was none, and the same deletion was found again, and
   * pushed again, 300 ms after every pause in typing, until the window ran out of
   * memory. Masked on Windows by the CRLF comparison above, which never produced a
   * pure deletion because it marked everything; fixing that alone would have made
   * this reachable on every checkout. The line after a deletion is a kept line,
   * and is now consumed like any other.
   */
  const hunks: LineHunk[] = []
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
        hunks.push({ start: startLine, count: inserted, before, kind: deletions > 0 ? 'modified' : 'added' })
        // The position after the inserted run may hold deletions of its own.
        i += inserted
        continue
      }
      hunks.push({ start: startLine, count: 0, before, kind: 'deleted' })
    }
    // A kept line, or the end, where there is nothing left to keep.
    if (i >= m) break
    aAt += 1
    i += 1
  }
  return hunks
}
