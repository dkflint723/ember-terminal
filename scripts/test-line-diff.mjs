// The change-bar diff, held to account outside a window.
// Run: node scripts/test-line-diff.mjs
//
// Three things are checked. A CRLF file nobody has touched shows no marks — the
// Git for Windows default, which used to mark every line. The hunks are right:
// reverting them turns the buffer back into HEAD, over hundreds of random edits.
// And the cost is bounded: the diff's typed arrays are counted as they are made,
// since the trace it keeps is what grew to 72 MB for 1,500 changed lines and
// would have reached a gigabyte at 6,000.
//
// Counted by standing a subclass in for Int32Array before the module loads: every
// array the diff makes, including the copies it keeps per round, goes through it.
let allocated = 0
const Real = globalThis.Int32Array
class Counting extends Real {
  constructor(...args) {
    super(...args)
    allocated += this.byteLength
  }
}
globalThis.Int32Array = Counting
const { diffLines, linesOf, MAX_EDITS } = await import('../src/renderer/src/editor/line-diff.ts')

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

// --- a CRLF working copy of an LF blob, untouched ---------------------------------
const lines = Array.from({ length: 5000 }, (_, i) => `const line${i} = ${i * 7}`)
const head = `${lines.join('\n')}\n`
const crlfBuffer = `${lines.join('\r\n')}\r\n`
// What the editor hands over: the buffer's lines, without their endings.
const bufferLines = crlfBuffer.split('\r\n')
const t0 = performance.now()
const untouched = diffLines(linesOf(head), bufferLines)
const took = performance.now() - t0
check('an untouched CRLF file shows no marks', untouched.length === 0, JSON.stringify(untouched.slice(0, 2)))
check('and is compared in well under the typing pause', took < 50, `${took.toFixed(1)} ms`)
// And the comparison that used to be made, for the record: every line differs.
const old = diffLines(head.split('\n'), crlfBuffer.split('\n'))
check('splitting on "\\n" alone is what marked every line', old.length === 1 && old[0].count >= 5000, JSON.stringify(old.map((h) => h.count)))

// --- the hunks are right ----------------------------------------------------------
// A small alphabet, so lines repeat and the diff has real choices to make.
let seed = 7
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed % n
}
const word = () => ['a', 'b', 'c', 'd', 'e'][rand(5)]
const revert = (buffer, hunks) => {
  const out = [...buffer]
  // Back to front, so earlier positions stay where they were.
  for (const h of [...hunks].reverse()) {
    if (h.kind === 'deleted') out.splice(h.start - 1, 0, ...h.before)
    else out.splice(h.start - 1, h.count, ...h.before)
  }
  return out
}
let wrong = 0
for (let round = 0; round < 400; round++) {
  const a = Array.from({ length: 5 + rand(60) }, word)
  const b = [...a]
  const edits = 1 + rand(12)
  for (let e = 0; e < edits; e++) {
    const at = rand(b.length + 1)
    const op = rand(3)
    if (op === 0) b.splice(at, 0, word())
    else if (op === 1 && b.length > 0) b.splice(Math.min(at, b.length - 1), 1)
    else if (b.length > 0) b[Math.min(at, b.length - 1)] = `${word()}${word()}`
  }
  const hunks = diffLines(a, b)
  const back = revert(b, hunks)
  if (JSON.stringify(back) !== JSON.stringify(a)) {
    wrong += 1
    if (wrong === 1) check('reverting every hunk gives HEAD back', false, JSON.stringify({ a, b, hunks }))
  }
  // Marks cover real lines only.
  for (const h of hunks) {
    if (h.start < 1 || h.start - 1 + h.count > b.length + (h.kind === 'deleted' ? 1 : 0)) {
      wrong += 1
      check('every mark stands on a line of the buffer', false, JSON.stringify(h))
      break
    }
  }
}
check('across 400 random edits', wrong === 0, `${wrong} wrong`)

// --- the cost is bounded -------------------------------------------------------------
// Every line different: the case the CRLF comparison produced, at the size the
// audit measured.
const other = Array.from({ length: 1500 }, (_, i) => `other ${i}`)
const mine = Array.from({ length: 1500 }, (_, i) => `mine ${i}`)
allocated = 0
const t1 = performance.now()
const rewritten = diffLines(other, mine)
const took1 = performance.now() - t1
check(
  `1,500 changed lines keep under 8 MB of trace`,
  allocated < 8 * 1024 * 1024,
  `${(allocated / 1024 / 1024).toFixed(1)} MB`
)
check('and are reported as one changed stretch', rewritten.length === 1 && rewritten[0].count === 1500, JSON.stringify(rewritten.map((h) => [h.kind, h.start, h.count])))
check('and quickly', took1 < 250, `${took1.toFixed(1)} ms`)

// A rewrite far bigger than the diff will attempt at all.
const huge = Array.from({ length: 30_000 }, (_, i) => `x${i}`)
const hugeToo = Array.from({ length: 30_000 }, (_, i) => `y${i}`)
allocated = 0
const t2 = performance.now()
const whole = diffLines(huge, hugeToo)
const took2 = performance.now() - t2
check('60,000 lines of difference are not diffed line by line', whole.length === 1 && allocated < 1024 * 1024, `${whole.length} hunks, ${allocated} bytes`)
check('and cost next to nothing', took2 < 100, `${took2.toFixed(1)} ms`)

// A handful of edits in a long file is still per line, and cheap.
const long = Array.from({ length: 20_000 }, (_, i) => `row ${i}`)
const edited = [...long]
edited[100] = 'changed'
edited.splice(9000, 0, 'inserted')
edited.splice(15000, 1)
allocated = 0
const few = diffLines(long, edited)
check(
  'a few edits in 20,000 lines are three marks',
  few.length === 3 && few.map((h) => h.kind).join(',') === 'modified,added,deleted',
  JSON.stringify(few.map((h) => [h.kind, h.start, h.count]))
)
check('with a trace the size of the edits, not the file', allocated < 256 * 1024, `${allocated} bytes`)
check('and the cap is what it says', MAX_EDITS === 1000, String(MAX_EDITS))

globalThis.Int32Array = Real
console.log('line diff:', failures === 0 ? 'PASS' : 'FAIL')
process.exit(failures === 0 ? 0 : 1)
