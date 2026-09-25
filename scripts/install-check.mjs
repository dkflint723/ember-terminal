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
import { _electron as electron } from 'playwright-core'
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
const run = (file, args, timeout) => {
  const from = Date.now()
  const r = spawnSync(`"${file}" ${args}`, {
    shell: true,
    windowsVerbatimArguments: true,
    timeout,
    encoding: 'utf8'
  })
  console.log(`${path.basename(file)} ${args.split(' ')[0]} took ${Math.round((Date.now() - from) / 1000)}s`)
  return r
}

/*
 * Ten minutes for an installer, where three was the limit.
 *
 * Measured on hosted runners, installing over the previous release took 60 to 131
 * seconds when it finished, and three times it was killed at 180. All three times
 * the Volume Shadow Copy service and its software provider started while the
 * installer was writing, and from that moment its writes fell from about 76 MB/s
 * to about 0.3 MB/s; in none of the seven that finished did they start. Nothing
 * of Ember's asked for the shadow copy — the installer had no child process and
 * no application event was logged — so it is the runner, and the limit is sized
 * for a disk that has slowed down rather than for one that has not. An installer
 * that never finishes still fails here.
 */
const INSTALLER_LIMIT = 600_000

/*
 * --- over the previous release, when there is one to go over --------------------
 *
 * A fresh install is not what most people will do with this build: they already
 * have the last one, with settings, a history database and a saved session, and
 * the installer goes on top. Nothing had ever tested that — an upgrade that failed
 * to replace the app, or a new build that could not read what the old one wrote,
 * would have shipped exactly as confidently as one that worked.
 *
 * With EMBER_PREVIOUS_SETUP naming the previous release's installer, it goes into
 * the same folder first and is driven for real: a setting changed and a marked
 * command run, so it writes settings, history and a session into a profile that
 * the new build is then pointed at after it has been installed over the top.
 */
const previousSetup = process.env.EMBER_PREVIOUS_SETUP
const upgradeProfile = previousSetup ? fs.mkdtempSync(path.join(os.tmpdir(), 'ember-upgrade-')) : null
const marker = `ember-upgrade-${Date.now().toString(36)}`
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

/** Launch an installed Ember on the upgrade profile, run `body`, and close it within a bound. */
const drive = async (label, body) => {
  const app = await electron.launch({
    executablePath: path.join(dir, 'Ember.exe'),
    args: [`--user-data-dir=${upgradeProfile}`],
    cwd: dir,
    env,
    timeout: 60_000
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 60_000 })
    await sleep(1500)
    await body(page)
  } finally {
    // Bounded: a close that waits on a question should fail here with a reason,
    // not stall the release job until it times out.
    const closed = await Promise.race([
      app.close().then(() => true),
      sleep(20_000).then(() => false)
    ])
    check(`the ${label} build closes`, closed, 'still open after 20s')
    if (!closed) app.process()?.kill()
  }
}

if (previousSetup) {
  console.log(`installing the previous release, ${path.basename(previousSetup)}, into ${dir}`)
  const before = run(previousSetup, `/S /D=${dir}`, INSTALLER_LIMIT)
  check('the previous release installs', before.status === 0, `exit ${before.status}`)
  if (!fs.existsSync(path.join(dir, 'Ember.exe'))) finish()

  await drive('previous', async (page) => {
    await page.evaluate(() => window.ember.setSettings({ fontSize: 15 }))
    await page.click('.composer__input')
    await page.keyboard.type(`echo ${marker}`, { delay: 6 })
    await page.keyboard.press('Enter')
    const ran = await page
      .waitForFunction(
        (m) =>
          [...document.querySelectorAll('.block--done .block__body')].some((b) =>
            (b.textContent ?? '').includes(m)
          ),
        marker,
        { timeout: 60_000 }
      )
      .then(() => true)
      .catch(() => false)
    check('the previous release runs a command', ran, marker)
    // Past the autosave, so the session on disk holds it.
    await sleep(3000)
  })
}

console.log(`installing ${setupName} into ${dir}${previousSetup ? ', over the previous release' : ''}`)
const installed = run(setup, `/S /D=${dir}`, INSTALLER_LIMIT)
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

/*
 * What the upgrade kept. The version is read from the executable rather than
 * trusted from the installer's exit code, since an installer that failed to
 * replace a running or locked file can still exit 0 and leave the old build there.
 */
if (previousSetup) {
  const want = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version
  const probe = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe}').VersionInfo.ProductVersion`],
    { encoding: 'utf8' }
  )
  const got = (probe.stdout ?? '').trim()
  check('the upgrade replaced the app with this version', got.startsWith(want), `Ember.exe says ${got || 'nothing'}, package.json ${want}`)

  await drive('upgraded', async (page) => {
    const settings = await page.evaluate(() => window.ember.getSettings())
    check('a setting made in the previous release survives', settings?.fontSize === 15, `fontSize ${settings?.fontSize}`)
    const rows = await page.evaluate((m) => window.ember.searchHistory({ text: m, limit: 5 }), marker)
    check(
      'and so does its command history',
      Array.isArray(rows) && rows.some((r) => JSON.stringify(r).includes(marker)),
      JSON.stringify(rows).slice(0, 200)
    )
    const restored = await page
      .waitForFunction(
        (m) => [...document.querySelectorAll('.block__cmd')].some((c) => (c.textContent ?? '').includes(m)),
        marker,
        { timeout: 15_000 }
      )
      .then(() => true)
      .catch(() => false)
    check('and its session comes back with the command in it', restored, marker)
  })
  fs.rmSync(upgradeProfile, { recursive: true, force: true })
}

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
  const removed = run(path.join(dir, uninstaller), `/S _?=${dir}`, INSTALLER_LIMIT)
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
