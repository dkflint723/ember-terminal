// A main-process fault fails the suite that caused it.
// Run: node scripts/test-profile-faults.mjs
//
// Main survives an uncaught exception by design: it logs the fault to ember.log and
// shows one dialog, so the window a suite is driving carries on looking fine. Nothing
// in the gate read that log, so a run could pass while main was throwing — and the
// log lives in the throwaway profile that each suite deletes on its way out.
//
// profile.mjs now audits the log inside cleanup(), before the delete, and upgrades
// the exit code from an 'exit' listener. That listener is process-wide, which is why
// each case here is its own child process: the thing under test is the exit code a
// real suite would end with after calling cleanup() and then process.exit(0).
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import * as path from 'node:path'
import { faultsIn } from './profile.mjs'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const profileUrl = pathToFileURL(path.join(import.meta.dirname, 'profile.mjs')).href

/** Exit code of a child that writes `log`, cleans up and then exits 0 as suites do. */
const exitAfter = (log, expectFaults = '[]', where = 'ember.log') => {
  const code = `
    import * as fs from 'node:fs'
    import * as path from 'node:path'
    import { newProfile } from ${JSON.stringify(profileUrl)}
    const profile = newProfile('unit', { expectFaults: ${expectFaults} })
    const file = path.join(profile.dir, ${JSON.stringify(where)})
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, ${JSON.stringify(log)})
    profile.cleanup()
    process.exit(0)
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() }
}

const ts = '[2026-09-11T09:00:00.000Z]'
const uncaught = `${ts} uncaught exception in main: TypeError: boom\n    at thing (index.js:1:1)\n`
const narration = `${ts} updater: checking\n${ts} updater warn: no latest.yml\n${ts} updater error: 404\n`

// --- the parser -----------------------------------------------------------------
const parsed = faultsIn(narration + uncaught)
check('the updater narrating is not a fault', parsed.length === 1, JSON.stringify(parsed))
check('a fault is found by its label', parsed[0]?.label === 'uncaught exception in main', parsed[0]?.label)
check('and keeps its stack lines', parsed[0]?.text.includes('at thing'), parsed[0]?.text)
check('an empty log has no faults', faultsIn('').length === 0)

// --- the exit code a suite actually ends with ------------------------------------
const clean = exitAfter(narration)
check('a run whose log only narrates still exits 0', clean.status === 0, clean.out)

const faulty = exitAfter(narration + uncaught)
check('a run that faulted exits 1 despite process.exit(0)', faulty.status === 1, faulty.out)
check('and says why', faulty.out.includes('main-process faults: FAIL'), faulty.out)

const expected = exitAfter(uncaught, '[/uncaught exception in main: TypeError: boom/]')
check('a fault the suite provoked on purpose can be named and let through', expected.status === 0, expected.out)

const elevated = exitAfter(uncaught, '[]', path.join('admin-window', 'ember.log'))
check('the elevated window’s own log is read too', elevated.status === 1, elevated.out)

console.log('profile fault audit:', failures === 0 ? 'PASS' : 'FAIL')
process.exit(failures === 0 ? 0 : 1)
