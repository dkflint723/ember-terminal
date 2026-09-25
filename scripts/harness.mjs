/**
 * Pieces every verification suite can share.
 *
 * The suites grew one at a time, each with its own copy of launch, check and exit,
 * and each copy drifted: most listened for uncaught page errors on the one page they
 * drove, a suite that opened a second window or relaunched stopped listening at the
 * first page, and five suites in the gate listened for none at all. What belongs in
 * every suite lives here instead, so the next one gets it by importing it.
 */

import { spawnSync } from 'node:child_process'

/**
 * Collect every uncaught page error from every window an app has, or opens later.
 *
 * Playwright reports windows that already exist through `windows()` and new ones
 * through the 'window' event, so both are hooked; a window cannot appear in both.
 * `ignore` names errors a suite causes on purpose.
 */
export function watchPageErrors(app, sink, { ignore = [] } = {}) {
  const hook = (w) =>
    w.on('pageerror', (e) => {
      if (!ignore.some((re) => re.test(e.message))) sink.push(e.message)
    })
  for (const w of app.windows()) hook(w)
  app.on('window', hook)
  return app
}

/*
 * Closing, which is the one step every suite takes and none of them bounded.
 *
 * A window with a command still running asks before it closes — "1 command is still
 * running (…)", End them and close, or Cancel — and a suite has nobody to answer it.
 * The question is asked synchronously in main, so while it is up nothing in the app
 * answers anything else either: app.close() waited on it with no end, and the gate
 * killed the suite at twenty minutes having printed nothing, not even the checks it
 * had already failed. verify-live and verify-dirpicker did that every night, and it
 * read as a hang in the app rather than as a suite leaving a command running.
 *
 * So what main is told is running is watched from launch — the renderer reports it
 * every time it changes, for exactly this question — and a suite can wait for it to
 * be empty before it closes. The close itself has a bound, and a close that runs out
 * of it fails by name: what the window was asking about, or, when it was asking about
 * nothing, which processes had not gone. Then the tree is killed, so a stuck window
 * cannot outlive its suite and sit under the next one.
 */

/** Listen to what main is told is running, from now on. Call right after launch. */
export async function watchRunning(app) {
  await app.evaluate(({ ipcMain }) => {
    const byWindow = new Map()
    globalThis.__emberRunning = () => [...byWindow.values()].flat()
    ipcMain.on('window:unsaved', (e, counts) => {
      const id = e.sender.id
      if (!byWindow.has(id)) e.sender.once('destroyed', () => byWindow.delete(id))
      byWindow.set(id, Array.isArray(counts?.running) ? counts.running.map(String) : [])
    })
  })
  return app
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/** The commands main was last told are running, in every window; null if it did not say. */
export async function runningNow(app, ms = 5_000) {
  return Promise.race([
    app.evaluate(() => globalThis.__emberRunning?.() ?? null).catch(() => null),
    pause(ms).then(() => null)
  ])
}

/** Wait until nothing is running, for at most `ms`; returns whatever still is. */
export async function untilNothingRuns(app, ms = 20_000) {
  const until = Date.now() + ms
  let running = await runningNow(app)
  while (running !== null && running.length > 0 && Date.now() < until) {
    await pause(250)
    running = await runningNow(app)
  }
  return running ?? []
}

const LIST_PROCESSES = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'

/** The processes still alive under `pid`, by name, e.g. "electron.exe ×4, zsh.exe". */
function aliveUnder(pid) {
  if (process.platform !== 'win32') return ''
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(LIST_PROCESSES, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true }
  )
  const rows = (r.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(' '))
    .filter((f) => f.length >= 3)
    .map(([id, parent, ...name]) => ({ id: Number(id), parent: Number(parent), name: name.join(' ') }))
  const under = new Set([pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const p of rows) {
      if (!under.has(p.id) && under.has(p.parent)) {
        under.add(p.id)
        grew = true
      }
    }
  }
  const counts = new Map()
  for (const p of rows) if (p.id !== pid && under.has(p.id)) counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
}

/**
 * Close the app, within `ms`. Null when it closed; otherwise why it did not, worded
 * as a failed check, after the whole process tree has been killed.
 */
export async function closeApp(app, { ms = 20_000 } = {}) {
  const running = (await runningNow(app)) ?? []
  const pid = app.process().pid
  // Gone is the process exiting, not the close call returning: a close can also fail
  // outright once the connection drops, and that says nothing about the process.
  const proc = app.process()
  const exited = new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve(true)
    else proc.once('exit', () => resolve(true))
  })
  app.close().catch(() => {})
  const closed = await Promise.race([exited, pause(ms).then(() => false)])
  /*
   * And gone cleanly. Quitting could also crash on the way out — a shell's exit
   * delivered after JavaScript had stopped, and node-pty throwing from inside it —
   * which printed nothing and left a dump in the profile. Nothing else looks at
   * the exit code, so it is read here.
   */
  if (closed) {
    const code = proc.exitCode ?? 0
    return code === 0
      ? null
      : `the app exits cleanly when asked — exit code 0x${(code >>> 0).toString(16)}${(code >>> 0) === 0xe06d7363 ? ', an uncaught C++ exception' : ''}`
  }
  const alive = aliveUnder(pid)
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  try {
    proc.kill()
  } catch {
    // Already gone.
  }
  const seconds = Math.round(ms / 1000)
  return running.length > 0
    ? `the app closes when asked — still open after ${seconds}s, asking whether to end ${running.length === 1 ? 'a command' : `${running.length} commands`} still running (${running.join(', ')}), which nobody here answers`
    : `the app quits when asked — still running ${seconds}s later with no command it would ask about${alive ? `; still alive under it: ${alive}` : ''}`
}
