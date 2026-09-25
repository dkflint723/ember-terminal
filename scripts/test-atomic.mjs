// Files that survive an interrupted write. Run: node scripts/test-atomic.mjs
//
// Every file Ember keeps used to be written in place, or renamed into place before
// its bytes had reached the disk — so a crash, a full disk or a sharing violation
// halfway through left a truncated file behind, and a truncated session file lost
// every window with it. These are the rules the new writer lives by, each tried by
// making one step of it fail on purpose.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readRecoverable, writeAtomic, writeAtomicAsync, writeDocument } from '../src/main/atomic.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-atomic-'))
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)
const leftovers = () => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))

/** The real calls, with one of them replaced. */
const withFault = (name, fault) => ({
  openSync: fs.openSync,
  writeSync: (fd, data) => fs.writeSync(fd, data),
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  copyFileSync: fs.copyFileSync,
  existsSync: fs.existsSync,
  rmSync: fs.rmSync,
  [name]: fault
})
const errno = (code) => Object.assign(new Error(code), { code })

// --- the ordinary case ---------------------------------------------------------
const file = path.join(dir, 'state.json')
writeAtomic(file, 'first')
check('a new file is written', read(file) === 'first')
writeAtomic(file, 'second', { backup: true })
check('a replaced file is replaced', read(file) === 'second')
check('and its previous bytes kept as .bak', read(`${file}.bak`) === 'first')
check('and nothing is left behind', leftovers().length === 0, leftovers().join(','))

// --- the data reaches the disk before the name points at it --------------------
{
  const order = []
  const ops = withFault('fsyncSync', (fd) => {
    order.push('fsync')
    fs.fsyncSync(fd)
  })
  ops.renameSync = (a, b) => {
    order.push('rename')
    fs.renameSync(a, b)
  }
  writeAtomic(file, 'third', { ops })
  check('flushed before it is renamed', order.join(',') === 'fsync,rename', order.join(','))
}

// --- a failure anywhere leaves the original exactly as it was ------------------
for (const [label, name, fault] of [
  [
    'the disk filling halfway through',
    'writeSync',
    (() => {
      let calls = 0
      return (fd, data) => {
        if (calls++ === 0) return fs.writeSync(fd, data.subarray(0, 2))
        throw errno('ENOSPC')
      }
    })()
  ],
  ['a flush that fails', 'fsyncSync', () => { throw errno('EIO') }],
  ['a rename that is never allowed', 'renameSync', () => { throw errno('EXDEV') }]
]) {
  fs.writeFileSync(file, 'original')
  let threw = false
  try {
    writeAtomic(file, 'replacement that must not land', { ops: withFault(name, fault) })
  } catch {
    threw = true
  }
  check(`${label}: says so`, threw)
  check(`${label}: the original is untouched`, read(file) === 'original', read(file))
  check(`${label}: no temporary file is left`, leftovers().length === 0, leftovers().join(','))
}

// --- a busy file is waited for, a few times -----------------------------------
{
  fs.writeFileSync(file, 'original')
  let refusals = 2
  const ops = withFault('renameSync', (a, b) => {
    if (refusals-- > 0) throw errno('EBUSY')
    fs.renameSync(a, b)
  })
  writeAtomic(file, 'after waiting', { ops })
  check('a rename refused while the file is busy is retried', read(file) === 'after waiting', read(file))
}
{
  fs.writeFileSync(file, 'original')
  let threw = false
  try {
    writeAtomic(file, 'never', { ops: withFault('renameSync', () => { throw errno('EPERM') }) })
  } catch (err) {
    threw = err.code === 'EPERM'
  }
  check('and one refused every time gives up, saying why', threw)
  check('with the original untouched', read(file) === 'original')
}

// --- a document that must be written where it lives ---------------------------
{
  const doc = path.join(dir, 'linked.txt')
  const twin = path.join(dir, 'twin.txt')
  fs.writeFileSync(doc, 'before')
  fs.linkSync(doc, twin)
  const how = writeDocument(doc, Buffer.from('after'))
  check('a hard-linked file is written in place', how === 'in-place', how)
  check('so its other name sees the new text', read(twin) === 'after', read(twin))
}
{
  const real = path.join(dir, 'real.txt')
  const link = path.join(dir, 'link.txt')
  fs.writeFileSync(real, 'before')
  let linked = true
  try {
    fs.symlinkSync(real, link)
  } catch {
    linked = false // Windows without the privilege; the rule is still exercised elsewhere.
  }
  if (linked) {
    writeDocument(link, Buffer.from('after'))
    check('a symbolic link stays a link', fs.lstatSync(link).isSymbolicLink())
    check('and the file it points at is the one written', read(real) === 'after', read(real))
  }
}
{
  const doc = path.join(dir, 'held.txt')
  fs.writeFileSync(doc, 'before')
  const how = writeDocument(doc, Buffer.from('after'), withFault('renameSync', () => { throw errno('EBUSY') }))
  check('a file some other program holds is written in place', how === 'in-place' && read(doc) === 'after', how)
  check('with the previous bytes kept first', read(`${doc}.bak`) === 'before')
}
{
  const doc = path.join(dir, 'plain.txt')
  fs.writeFileSync(doc, 'before')
  check('an ordinary file is replaced whole', writeDocument(doc, Buffer.from('after')) === 'replaced')
  check('without a .bak beside it', !fs.existsSync(`${doc}.bak`))
}

// --- reading back what may be damaged -----------------------------------------
const isState = (v) => typeof v === 'object' && v !== null && v.version === 2
{
  const f = path.join(dir, 'good.json')
  fs.writeFileSync(f, JSON.stringify({ version: 2, n: 1 }))
  const r = readRecoverable(f, isState)
  check('a good file is read', r.recovered === 'none' && r.value?.n === 1, JSON.stringify(r))
}
{
  const f = path.join(dir, 'torn.json')
  fs.writeFileSync(`${f}.bak`, JSON.stringify({ version: 2, n: 'previous' }))
  fs.writeFileSync(f, '{"version":2,"n":"tor')
  const r = readRecoverable(f, isState)
  check('a torn file falls back to its .bak', r.recovered === 'backup' && r.value?.n === 'previous', JSON.stringify(r))
  check('and is kept aside as .bad', read(`${f}.bad`) === '{"version":2,"n":"tor')
  check('and says what was wrong with it', typeof r.problem === 'string' && r.problem.length > 0)
}
{
  const f = path.join(dir, 'newer.json')
  fs.writeFileSync(f, JSON.stringify({ version: 3 }))
  const r = readRecoverable(f, isState)
  check('a file from a newer version is not read as this one', r.value === null && r.recovered === 'lost', JSON.stringify(r))
  check('and is kept, not overwritten', read(`${f}.bad`) === '{"version":3}')
}
{
  const r = readRecoverable(path.join(dir, 'absent.json'), isState)
  check('a file that is not there is simply nothing', r.value === null && r.recovered === 'none', JSON.stringify(r))
}

// --- the same, off the main thread -------------------------------------------
{
  const f = path.join(dir, 'async.json')
  await writeAtomicAsync(f, 'one')
  await writeAtomicAsync(f, 'two', { backup: true })
  check('the asynchronous write replaces and keeps a .bak', read(f) === 'two' && read(`${f}.bak`) === 'one')
  check('and leaves nothing behind', leftovers().length === 0, leftovers().join(','))
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(`atomic writes: ${cases} cases`, failures === 0 ? 'PASS' : 'FAIL')
process.exit(failures === 0 ? 0 : 1)
