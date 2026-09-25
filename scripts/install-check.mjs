// The installer that ships, installed, launched and removed.
//
// Every packaged check until now ran against release/win-unpacked — the folder the
// installer is built *from*, not what it puts on a machine. That is how 0.3.x
// shipped installers whose app found no themes and no shell integration while the
// unpacked build was perfect: nothing had ever run the installed one. This does,
// and it is what the release job runs before anything is uploaded, so the
// installer on the release page is the one that was tested.
//
// It installs silently into a throwaway folder, requires the files an installed
// Ember needs to be where the installer claims to put them, runs verify-packaged
// and verify-update against the installed Ember.exe, uninstalls, and requires the
// uninstall to have removed it.
//
// It writes shortcuts and registry entries as any install does, so it is for a
// runner or a machine set aside for it — not for a desk.
//
// Run: node scripts/install-check.mjs      (after `npm run dist`; reads release/)
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const RELEASE = process.env.EMBER_RELEASE_DIR ?? path.join(APP_DIR, 'release')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const finish = () => {
  for (const f of failures) console.log(`  - ${f}`)
  console.log('installed build:', failures.length === 0 ? 'PASS' : 'FAIL')
  process.exit(failures.length === 0 ? 0 : 1)
}

// The installer latest.yml names, so this tests the file the updater will fetch
// rather than whichever .exe happens to be lying in release/.
const feed = fs.readFileSync(path.join(RELEASE, 'latest.yml'), 'utf8')
const setupName = /^path:\s*(.+?)\s*$/m.exec(feed)?.[1]
const setup = setupName ? path.join(RELEASE, setupName) : null
if (!setup || !fs.existsSync(setup)) {
  console.log(`  - latest.yml names ${setupName ?? 'no installer'}, and it is not in ${RELEASE}`)
  console.log('installed build: FAIL')
  process.exit(1)
}

// No spaces, because NSIS takes /D= unquoted and as the last argument, and a path
// with a space in it would be cut at the space.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-installed-'))
if (/\s/.test(dir)) {
  console.log(`  - the install folder ${dir} has a space in it, which NSIS's /D= cannot carry`)
  console.log('installed build: FAIL')
  process.exit(1)
}

/*
 * Verbatim, because Node quotes any argument it thinks needs it, and NSIS reads a
 * quoted /D= as part of the path.
 */
const run = (file, args, timeout) =>
  spawnSync(`"${file}" ${args}`, {
    shell: true,
    windowsVerbatimArguments: true,
    timeout,
    encoding: 'utf8'
  })

console.log(`installing ${setupName} into ${dir}`)
const installed = run(setup, `/S /D=${dir}`, 180_000)
check('the installer exits cleanly', installed.status === 0, `exit ${installed.status}${installed.error ? `, ${installed.error.message}` : ''}`)

const exe = path.join(dir, 'Ember.exe')
check('it puts Ember.exe where it was told to', fs.existsSync(exe), exe)
check(
  'and the update feed an installed app reads',
  fs.existsSync(path.join(dir, 'resources', 'app-update.yml')),
  'resources/app-update.yml is missing — the installed app would never look for updates'
)
const uninstaller = fs.readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f))
check('and an uninstaller', uninstaller !== undefined, fs.readdirSync(dir).join(', '))

if (!fs.existsSync(exe)) finish()

// The installed app, through the two suites that already know how to drive a
// packaged one. Their own output goes straight through, so a failure reads here the
// way it reads anywhere else.
for (const suite of ['verify-packaged', 'verify-update']) {
  console.log(`=== ${suite} (installed) ===`)
  const r = spawnSync(process.execPath, [path.join(APP_DIR, 'scripts', `${suite}.mjs`)], {
    cwd: APP_DIR,
    env: { ...process.env, EMBER_EXE: exe },
    stdio: 'inherit',
    timeout: 600_000
  })
  check(`${suite} passes against the installed build`, r.status === 0, `exit ${r.status}`)
}

/*
 * Removed, and waited for.
 *
 * An NSIS uninstaller copies itself to the temp folder and returns at once unless
 * it is told where it is running with _?=, so without it this would check a folder
 * the uninstaller had not reached yet. With it, it runs in place and leaves itself
 * behind, which is why the uninstaller is not among the things required to go.
 */
if (uninstaller) {
  const removed = run(path.join(dir, uninstaller), `/S _?=${dir}`, 180_000)
  check('the uninstaller exits cleanly', removed.status === 0, `exit ${removed.status}`)
  let gone = false
  for (let waited = 0; waited < 60_000; waited += 1000) {
    if (!fs.existsSync(exe)) {
      gone = true
      break
    }
    await sleep(1000)
  }
  check('and Ember.exe is gone afterwards', gone, exe)
}

try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {
  // A leftover folder in the temp directory is not worth failing a run over.
}
finish()
