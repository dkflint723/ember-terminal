// One run at a time, and no request lost. Run: node scripts/test-serialized.mjs
//
// Git status in the renderer was guarded by a flag that turned away any request made
// while a read was under way. The read in flight could have started before the change
// being asked about — a merge begun in the terminal, a cd into a repository — so it
// published the old state while the request that would have seen the new one was
// dropped, and Refresh could do nothing at all. shared/serialized keeps the guard and
// fixes the loss. The race cannot be arranged on purpose in the app, so it is arranged
// here, with reads that finish only when told to.
//
// EMBER_OLD_RULE=1 runs the same cases against the rule it replaced, to show they
// catch it.
import { serialized as fixed } from '../src/shared/serialized.ts'

/** The rule that was there before: a read in flight turns every other request away. */
function dropping(run) {
  let busy = false
  return async (key) => {
    if (busy) return
    busy = true
    try {
      await run(key)
    } finally {
      busy = false
    }
  }
}
const serialized = process.env.EMBER_OLD_RULE ? dropping : fixed

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
 * A read that finishes when released, and records what it read and whether two ever
 * ran at once. `world` is what a read would see if it started now.
 */
const harness = () => {
  const h = { world: 'before', seen: [], started: [], running: 0, most: 0, gates: [] }
  h.read = serialized(async (key) => {
    h.running += 1
    h.most = Math.max(h.most, h.running)
    const sees = `${key ?? '-'}:${h.world}`
    h.started.push(sees)
    await new Promise((resolve) => h.gates.push(resolve))
    h.seen.push(sees)
    h.running -= 1
  })
  h.release = async () => {
    const gate = h.gates.shift()
    if (gate) gate()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }
  h.releaseAll = async () => {
    for (let i = 0; i < 20 && (h.gates.length > 0 || h.running > 0); i += 1) {
      await h.release()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return h
}

// --- a request made during a read is read again, and sees what changed ---------
{
  const h = harness()
  void h.read()
  h.world = 'after' // the merge lands while the first read is still out
  let refreshed = false
  const refresh = h.read().then(() => (refreshed = true))
  await h.release()
  await new Promise((r) => setTimeout(r, 0))
  check('Refresh pressed mid-read is not dropped', h.started.length === 2, JSON.stringify(h.started))
  await h.releaseAll()
  await refresh
  check('and the last thing published is the tree after the change', h.seen.at(-1) === '-:after', JSON.stringify(h.seen))
  check('and whoever awaited it was answered after that read', refreshed === true)
}

// --- never two at once, however many ask -----------------------------------------
{
  const h = harness()
  void h.read()
  for (let i = 0; i < 6; i += 1) void h.read()
  await h.releaseAll()
  check('six requests during a read make one more read, not six', h.seen.length === 2, JSON.stringify(h.seen))
  check('and never two reads at once', h.most === 1, `most at once: ${h.most}`)
}

// --- a quiet repository is read once per request, not more -----------------------
{
  const h = harness()
  const p = h.read()
  await h.releaseAll()
  await p
  check('a request with nothing in flight is read exactly once', h.seen.length === 1, JSON.stringify(h.seen))
}

// --- per directory: a cd during another directory's read is not lost -------------
{
  const h = harness()
  void h.read('C:/old')
  const cd = h.read('C:/repo')
  await h.releaseAll()
  await cd
  check('a directory asked for during another one\'s read is read', h.seen.includes('C:/repo:before'), JSON.stringify(h.seen))
  check('after the one in flight, one at a time', h.most === 1 && h.seen[0] === 'C:/old:before', JSON.stringify(h.seen))
}

// --- the same directory asked twice while busy is read once more ------------------
{
  const h = harness()
  void h.read('C:/repo')
  void h.read('C:/repo')
  void h.read('C:/repo')
  await h.releaseAll()
  check('the same directory asked for twice meanwhile is read once more', h.seen.length === 2, JSON.stringify(h.seen))
}

// --- a read that fails does not wedge the next -----------------------------------
{
  let calls = 0
  const read = serialized(async () => {
    calls += 1
    if (calls === 1) throw new Error('git died')
  })
  let rejected = false
  await read().catch(() => (rejected = true))
  await read()
  check('a failed read is reported to whoever asked', rejected || process.env.EMBER_OLD_RULE === '1', `rejected ${rejected}`)
  check('and the next request still reads', calls === 2, `calls ${calls}`)
}

console.log(`serialized reads: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
