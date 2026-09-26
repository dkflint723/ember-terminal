// Whether a buffer is unsaved, decided without reading it. Run: node scripts/test-baseline.mjs
//
// editor/baseline.ts answers "does this buffer differ from the file?" by comparing
// Monaco's alternative version id with the one written down when the buffer last
// matched the disk. That id is a counter, not a fingerprint: undo and redo back to
// the saved text can land on a new number. Logged on the runner (run 36259074437):
// baseline 3, Ctrl+Z gave 4, Ctrl+Y gave 5 with the text equal to the file — and the
// tab said unsaved. verify-follow caught it end to end; this table pins the rule
// itself, with a model that counts how often its text was read.
import { isModified, markClean } from '../src/renderer/src/editor/baseline.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

/**
 * The three things baseline.ts asks of a Monaco model, and nothing else. `reads`
 * counts getValue() calls, since not building the whole text on every keystroke is
 * the point of the module; `set` moves the version the way an edit, an undo or a
 * redo would, to whatever id the case needs.
 */
const fakeModel = (text, version = 1) => {
  const m = {
    text,
    version,
    reads: 0,
    getAlternativeVersionId: () => m.version,
    getValueLength: () => m.text.length,
    getValue: () => {
      m.reads += 1
      return m.text
    },
    set(next, id) {
      m.text = next
      m.version = id
    }
  }
  return m
}
const readsDuring = (m, fn) => {
  const before = m.reads
  const out = fn()
  return { out, reads: m.reads - before }
}

// --- at the baseline --------------------------------------------------------------
{
  const saved = 'const a = 1\n'
  const m = fakeModel(saved, 3)
  markClean(m, saved)
  const r = readsDuring(m, () => isModified(m, saved))
  check('a buffer at its baseline is not modified', r.out === false, r.out)
  check('and that is answered without reading the text', r.reads === 0, `${r.reads} reads`)
}

// --- an edit ---------------------------------------------------------------------
{
  const saved = 'const a = 1\n'
  const m = fakeModel(saved, 3)
  markClean(m, saved)
  m.set('const a = 12\n', 4)
  const r = readsDuring(m, () => isModified(m, saved))
  check('an edit that changes the length is modified', r.out === true, r.out)
  check('without reading the text', r.reads === 0, `${r.reads} reads`)

  // Monaco's ordinary undo: back to the very id that was written down.
  m.set(saved, 3)
  const back = readsDuring(m, () => isModified(m, saved))
  check('undone to the baseline id, it is clean again', back.out === false, back.out)
  check('still without reading the text', back.reads === 0, `${back.reads} reads`)
}

// --- undo, then redo, onto a new id with the saved text --------------------------
{
  // The sequence as it was logged: a change followed from disk (57 chars, baseline
  // 3), Ctrl+Z to the text before it (29 chars, id 4), Ctrl+Y back (57 chars, id 5).
  const before = 'export const notes = "draft"\n'
  const saved = 'export const notes = "draft"\nexport const more = "disk"\n'
  const m = fakeModel(saved, 3)
  markClean(m, saved)
  m.set(before, 4)
  check('undone past the saved text, it is modified', isModified(m, saved) === true)
  m.set(saved, 5)
  const r = readsDuring(m, () => isModified(m, saved))
  check('redone to the saved text on a new id, it is not modified', r.out === false, r.out)
  check('which took one look at the text to know', r.reads === 1, `${r.reads} reads`)
  const again = readsDuring(m, () => isModified(m, saved))
  check('and the new id is the baseline now, so the next answer reads nothing', again.out === false && again.reads === 0, `${again.out}, ${again.reads} reads`)
  m.set(before, 6)
  check('and an edit after it is still seen', isModified(m, saved) === true)
}

// --- same length, different text -------------------------------------------------
{
  const saved = 'let x = 1\n'
  const m = fakeModel(saved, 3)
  markClean(m, saved)
  m.set('let y = 1\n', 4)
  const r = readsDuring(m, () => isModified(m, saved))
  check('a same-length edit is modified', r.out === true, r.out)
  check('which the length could not tell, so the text was read', r.reads === 1, `${r.reads} reads`)
  // No new baseline was taken from a text that did not match: going back to the
  // written-down id is clean without a read.
  m.set(saved, 3)
  const back = readsDuring(m, () => isModified(m, saved))
  check('and the old baseline still stands', back.out === false && back.reads === 0, `${back.out}, ${back.reads} reads`)
}

// --- the saved text changes underneath (a save, or a reload from disk) -----------
{
  const first = 'one\n'
  const second = 'two two\n'
  const m = fakeModel(first, 3)
  markClean(m, first)
  // The file moved on; the buffer did not. The old id means nothing against a
  // different saved text, so the text is compared.
  const r = readsDuring(m, () => isModified(m, second))
  check('against a new saved text, an old buffer is modified', r.out === true, r.out)
  check('found by reading, not by the stale id', r.reads === 1, `${r.reads} reads`)
  m.set(second, 4)
  check('brought up to the new text, it is clean', isModified(m, second) === false)
  const again = readsDuring(m, () => isModified(m, second))
  check('and baselined against the new text', again.out === false && again.reads === 0, `${again.out}, ${again.reads} reads`)
  // The same id, but saved text that is not what it was baselined against.
  check('the id alone is never taken as agreement with another text', isModified(m, first) === true)
}

// --- a buffer that never matched -------------------------------------------------
{
  // A restored unsaved buffer: never agreed with the file, so there is no baseline.
  const saved = 'on disk\n'
  const m = fakeModel('carried over, unsaved\n', 7)
  const r = readsDuring(m, () => isModified(m, saved))
  check('a buffer with no baseline that differs is modified', r.out === true, r.out)
  check('by reading it', r.reads === 1, `${r.reads} reads`)
  const again = readsDuring(m, () => isModified(m, saved))
  check('and no baseline is taken from a text that does not match', again.out === true && again.reads === 1, `${again.out}, ${again.reads} reads`)
  m.set(saved, 8)
  check('once it matches, it is clean', isModified(m, saved) === false)
  const now = readsDuring(m, () => isModified(m, saved))
  check('and from then on answered by the numbers', now.out === false && now.reads === 0, `${now.out}, ${now.reads} reads`)
}

console.log(`unsaved baseline: ${cases} cases`, failures === 0 ? 'PASS' : 'FAIL')
process.exit(failures === 0 ? 0 : 1)
