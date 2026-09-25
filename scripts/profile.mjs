import { execFileSync } from 'node:child_process'
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

/*
 * What a red run leaves behind on a machine nobody can look at.
 *
 * A profile is deleted on the way out, which is right — they are throwaway, and a
 * few hundred of them would fill a disk. It also means the one artefact worth
 * having after a failure on a hosted runner, main's own ember.log, is gone before
 * anything can upload it. The workflow claimed to be collecting those logs and was
 * collecting nothing: it globbed `ember-profile-*` under the runner's temp
 * directory, and profiles are made in os.tmpdir(), which on a Windows runner is
 * somewhere else entirely — and by upload time they had been removed regardless.
 *
 * With EMBER_KEEP_LOGS naming a directory, each log is copied there first, under
 * the name of the profile it came from. Unset, which is every run on a laptop,
 * nothing about this changes.
 */
function keepLogs(dir) {
  const keep = process.env.EMBER_KEEP_LOGS
  if (!keep) return
  try {
    fs.mkdirSync(keep, { recursive: true })
    const stem = path.basename(dir)
    for (const [from, suffix] of [
      [path.join(dir, 'ember.log'), ''],
      [path.join(dir, 'admin-window', 'ember.log'), '-admin']
    ]) {
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(keep, `${stem}${suffix}.log`))
    }
  } catch {
    // Evidence is a convenience. Failing to keep it must not fail the run.
  }
}

/**
 * Audit a user-data directory's logs and fail the run if main reported a fault.
 *
 * cleanup() calls this for every throwaway profile. The two suites that keep their
 * user data somewhere of their own — so they can read session.json and history.db
 * across relaunches — call it themselves before deleting that directory. Which is
 * why the logs are kept from here: it is the one point both paths go through.
 */
export function auditProfileDir(dir, { expectFaults = [] } = {}) {
  keepLogs(dir)
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

/**
 * Where main actually keeps its user data, which is not always the directory it
 * was handed.
 *
 * A process that is already running elevated moves itself into an `admin-window`
 * profile inside the one it was given — deliberately, so that an administrator's
 * Ember and an ordinary one never fight over a single session file, settings file
 * and history database. A hosted Windows runner runs everything elevated, so on
 * one of those the app writes a directory further down than it was pointed.
 *
 * Nine suites read files back out of the profile, and every one of them reported
 * them missing for that reason alone, on a machine where the app was saving them
 * perfectly well — two found in the smoke job, seven more once the nightly ran the
 * whole gate there. Asking the app is the only answer that stays right, because the app owns
 * the decision — and `auditProfileDir` above has always read both places, which is
 * why the crash that proved this was in the log all along.
 */
export async function userDataOf(app) {
  return await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
}

/**
 * Every directory the app might read its user data from, for a file a suite puts
 * down before the app has started.
 *
 * userDataOf answers where the data is, but only once the app is running, and a
 * suite seeding a history database or a settings file has to do it before then.
 * An elevated process reads from `admin-window` inside the profile, and that
 * profile is seeded from the ordinary one for a short list of settings, themes and
 * snippets only — so a history database written to the profile root is invisible
 * to it, and a setting outside that list never arrives. On a hosted Windows
 * runner, which is elevated throughout, that is every seeded suite.
 *
 * Both places, so the suite never has to know which one the app will choose. That
 * decision belongs to the app, and a copy of it here would be one more thing to go
 * stale the day the rule changes.
 */
export function seedDirs(dir) {
  const admin = path.join(dir, 'admin-window')
  fs.mkdirSync(admin, { recursive: true })
  return [dir, admin]
}

/**
 * A suite's scratch folder, spelled the way the app will spell it.
 *
 * A folder or file named on the command line is opened by its long name
 * (longPath in src/main/files.ts), and everything that asks the filesystem — the
 * shell, git — says the long name too. os.tmpdir() does not: on a machine whose
 * TEMP is an 8.3 short path, which the hosted runner's is (C:\Users\RUNNER~1\...),
 * it hands back RUNNER~1, and a suite that compared what the app shows with the
 * path it built from os.tmpdir() was comparing two spellings of one folder as
 * text. Eleven suites failed that way at once, and none of them could fail here,
 * where TEMP is long.
 *
 * So the folder is made where it always was and then named by the filesystem,
 * which gives the suite the same text the app will show. A check whose subject
 * is a second spelling asks for one on purpose with shortName below; verify-
 * explorer and verify-git keep their deliberate short-path and junction cases.
 */
export function workDir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/**
 * The 8.3 short spelling of an existing path, or null where it has none.
 *
 * The volume decides: 8.3 names can be turned off per volume, and a path whose
 * every part already fits in eight characters has no other spelling to give. A
 * check that needs a second spelling reports that it was not exercised rather
 * than passing as though it had been.
 */
export function shortName(p) {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %A in ("${p}") do @echo %~sA"`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      windowsHide: true,
      timeout: 10_000
    }).trim()
    if (!out || out.toLowerCase() === p.toLowerCase() || !fs.existsSync(out)) return null
    return out
  } catch {
    return null
  }
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
