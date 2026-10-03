// One run at a time, and one task after another: the rules the update flow keeps its
// checks and signature verdicts apart by. Run: node scripts/test-single-flight.mjs
//
// Timing is controlled here, as it cannot be from a packaged app: verify-update's
// "two checks at once" could not make two checks overlap on the runner — the second
// reached the feed after the first had finished — so the rule is tested where it can be.
import './ts-resolve.mjs'
const { singleFlight, inOrder } = await import('../src/shared/single-flight.ts')

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
/** A promise and the hands that settle it. */
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

// --- one run at a time ---------------------------------------------------------------------
{
  let runs = 0
  let gate = deferred()
  const check1 = singleFlight(() => {
    runs += 1
    return gate.promise
  })
  const a = check1()
  const b = check1()
  check('two calls while one is in flight are one run', runs === 1 && a === b, `${runs} runs`)
  check('and it can be seen to be in flight', check1.inFlight === a)
  gate.resolve('found')
  check('both callers get its answer', (await a) === 'found' && (await b) === 'found')
  await tick()
  check('and nothing is in flight once it has settled', check1.inFlight === null)
  gate = deferred()
  const c = check1()
  check('a call after it settles starts a new run', runs === 2 && c !== a, `${runs} runs`)
  gate.reject(new Error('offline'))
  let caught = ''
  try {
    await c
  } catch (err) {
    caught = err.message
  }
  check('a run that fails fails for every caller', caught === 'offline')
  await tick()
  gate = deferred()
  check1()
  check('and does not stop the next', runs === 3, `${runs} runs`)
  gate.resolve('ok')
}
{
  const throwing = singleFlight(() => {
    throw new Error('sync')
  })
  let threw = false
  try {
    throwing()
  } catch {
    threw = true
  }
  check('a run that throws at once leaves nothing in flight', threw && throwing.inFlight === null)
}

// --- one task after another -----------------------------------------------------------------------
{
  const queue = inOrder()
  const log = []
  const first = deferred()
  const one = queue(async () => {
    log.push('first starts')
    await first.promise
    log.push('first ends')
  })
  const two = queue(async () => {
    log.push('second starts')
  })
  await tick()
  check('the second does not start while the first runs', log.join(',') === 'first starts', log.join(','))
  first.resolve()
  await one
  await two
  check('and starts once it has finished', log.join(',') === 'first starts,first ends,second starts', log.join(','))
  const three = queue(async () => {
    throw new Error('refused')
  })
  let ran = false
  const four = queue(async () => {
    ran = true
  })
  await three
  await four
  check('one that fails does not stop the ones after it', ran)
}

console.log(`single flight: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
