import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * A throwaway Electron profile for a verification run.
 *
 * Every harness launched against the real userData directory until now, which meant
 * each run appended to the user's command history and wrote their settings file.
 * Session restore made that visible rather than merely rude: a run would come back
 * holding the previous run's tabs, and checks that assumed a fresh window started
 * failing for reasons that had nothing to do with the code under test.
 *
 * `--user-data-dir` is Electron's own switch, so nothing in the app needs a testing
 * seam to support this.
 */

/*
 * What ember.log holds that is not a fault.
 *
 * Main writes two kinds of line there: reportFault, for things that went wrong, and
 * logLine, for the updater narrating its own work. A check for updates in a
 * throwaway profile says a lot and means nothing, so the updater's labels are the
 * only ones let through. Everything else came through reportFault.
 */
const NARRATION = new Set(['updater', 'updater warn', 'updater error'])

/**
 * The faults in an ember.log, one entry per report.
 *
 * A report is `[timestamp] label: text`, and a stack trace continues it on the lines
 * after, so a line that does not open a new report belongs to the one before it.
 * `expect` lets a suite that provokes a fault on purpose say which one it meant.
 */
export function faultsIn(logText, expect = []) {
  const entries = []
  for (const line of logText.split(/\r?\n/)) {
    const m = /^\[[^\]]+\] ([^:]+): (.*)$/.exec(line)
    if (m) entries.push({ label: m[1], text: m[2] })
    else if (entries.length > 0 && line.trim()) entries[entries.length - 1].text += `\n${line}`
  }
  return entries.filter(
    (e) => !NARRATION.has(e.label) && !expect.some((re) => re.test(`${e.label}: ${e.text}`))
  )
}

/*
 * A main-process fault fails the suite that caused it, without the suite asking.
 *
 * Main survives an uncaught exception on purpose — it logs it and shows one dialog —
 * so a suite driving the window saw nothing wrong while ember.log filled up, and the
 * gate passed over faults it could not see. The log lives in the profile, which the
 * suite deletes on its way out, so the audit runs in cleanup(), before the delete.
 *
 * Upgraded, never downgraded: a suite that already failed keeps its own code. Node
 * reads process.exitCode after the 'exit' listeners have run, even when
 * process.exit() was given an explicit 0 — measured, not assumed — which is what
 * lets this one file hold the rule for every suite, including ones not written yet.
 */
let faulted = false
process.on('exit', () => {
  if (faulted && !process.exitCode) process.exitCode = 1
})

/**
 * Audit a user-data directory's logs and fail the run if main reported a fault.
 *
 * cleanup() calls this for every throwaway profile. The two suites that keep their
 * user data somewhere of their own — so they can read session.json and history.db
 * across relaunches — call it themselves before deleting that directory.
 */
export function auditProfileDir(dir, { expectFaults = [] } = {}) {
  const found = []
  for (const file of [path.join(dir, 'ember.log'), path.join(dir, 'admin-window', 'ember.log')]) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    found.push(...faultsIn(text, expectFaults))
  }
  if (found.length > 0) {
    faulted = true
    console.log(`main-process faults: FAIL — ${found.length} reported in ember.log`)
    for (const f of found.slice(0, 5)) console.log(`  - ${f.label}: ${f.text.split('\n')[0]}`)
  }
  return found
}

export function newProfile(label = 'run', { expectFaults = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ember-profile-${label}-`))
  return {
    dir,
    arg: `--user-data-dir=${dir}`,
    cleanup() {
      // The elevated window keeps its own profile inside this one; both logs are read.
      auditProfileDir(dir, { expectFaults })
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // A leftover temp directory is not worth failing a run over.
      }
    }
  }
}

/**
 * A suite that cannot run on this machine, said out loud.
 *
 * Passing silently is the right default on a laptop — a missing `gh` login is not a
 * regression — and the wrong one anywhere that is supposed to prove everything: with
 * EMBER_STRICT set, a skip is a failure, so a gate that skipped half its suites
 * cannot report itself green.
 */
export function skip(what, reason) {
  console.log(`${what}: SKIP — ${reason}`)
  process.exit(process.env.EMBER_STRICT ? 1 : 0)
}
