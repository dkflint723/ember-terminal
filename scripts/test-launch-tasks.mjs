// A launch configuration's preLaunchTask, turned into a command. Run: node scripts/test-launch-tasks.mjs
//
// It was ignored without a word, so a TypeScript project launched the JavaScript of
// its last build (audit R16, DA-05). This holds the resolver to what VS Code would
// run, and to refusing what Ember cannot run faithfully — and, on Windows, runs the
// task line in each PowerShell there is, to hold its exit code and its folder.
import { forWindows, powerShellArgument, resolveTask } from '../src/shared/launch-tasks.ts'
import { encodePowerShell, taskLabel, taskLine } from '../src/shared/debuggee.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const ctx = { workspace: 'C:\\work\\proj', file: 'C:\\work\\proj\\src\\app.ts', home: 'C:\\Users\\me' }
const tasks = {
  version: '2.0.0',
  tasks: [
    { label: 'build', type: 'shell', command: 'tsc -p .', args: ['--outDir', '${workspaceFolder}\\out'] },
    { label: 'compile', type: 'process', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['build.js', '${env:HOME_DIR}\\x'] },
    { label: 'in sub', type: 'shell', command: 'make', options: { cwd: 'sub', env: { MODE: 'debug', N: 2 } } },
    { label: 'watcher', type: 'shell', command: 'tsc -w', isBackground: true },
    { label: 'both', dependsOn: ['build', 'compile'] },
    { label: 'gulp', type: 'gulp', task: 'default' },
    { label: 'asks', type: 'shell', command: 'echo ${input:who}' },
    { label: 'per os', type: 'shell', command: 'build.sh', windows: { command: 'build.cmd', options: { env: { W: '1' } } }, options: { cwd: 'tools' } },
    { type: 'npm', script: 'prep', options: { env: { FROM: 'tasks.json' } } }
  ]
}
const task = (name, json = tasks) => resolveTask(name, json, ctx)

// --- tasks.json ---------------------------------------------------------------------
const build = task('build')
check('a shell task runs its command as PowerShell source, with its arguments as values', build.ok && build.task.script === "tsc -p . '--outDir' 'C:\\work\\proj\\out'", JSON.stringify(build))
check('in the workspace', build.ok && build.task.cwd === 'C:\\work\\proj', build.ok && build.task.cwd)
const compile = task('compile')
check('a process task runs the program itself, quoted', compile.ok && compile.task.script === "& 'C:\\Program Files\\nodejs\\node.exe' 'build.js' ($env:HOME_DIR + '\\x')", compile.ok && compile.task.script)
const sub = task('in sub')
check('in its own folder, under the workspace', sub.ok && sub.task.cwd === 'C:\\work\\proj\\sub', sub.ok && sub.task.cwd)
check('with its own environment, as strings', sub.ok && sub.task.env?.MODE === 'debug' && sub.task.env?.N === '2', JSON.stringify(sub.ok && sub.task.env))
const perOs = task('per os')
check('its windows settings laid over the rest', perOs.ok && perOs.task.script === 'build.cmd', perOs.ok && perOs.task.script)
check('without losing the options they did not name', perOs.ok && perOs.task.cwd === 'C:\\work\\proj\\tools' && perOs.task.env?.W === '1', JSON.stringify(perOs))

// --- refused, with the reason ---------------------------------------------------------
const refused = (name, words) => {
  const r = task(name)
  check(`refuses ${name}: ${words}`, !r.ok && r.reason.includes(words), JSON.stringify(r))
}
refused('watcher', 'never finishes')
refused('both', 'depends on other tasks')
refused('gulp', 'which Ember does not run')
refused('asks', '${input:who}')
refused('nothing like it', 'no task named')
refused('tsc: watch - tsconfig.json', 'never finishes')

// --- the names VS Code gives on its own ------------------------------------------------
const npm = task('npm: build')
check('npm: build is npm run build, in the workspace', npm.ok && npm.task.script === "& npm run 'build'" && npm.task.cwd === 'C:\\work\\proj', JSON.stringify(npm))
const npmSub = task('npm: test - packages/api')
check('npm: test - a folder runs there', npmSub.ok && npmSub.task.cwd === 'C:\\work\\proj\\packages\\api', npmSub.ok && npmSub.task.cwd)
const prep = task('npm: prep')
check('an unlabelled npm entry in tasks.json is found by that name, options and all', prep.ok && prep.task.env?.FROM === 'tasks.json', JSON.stringify(prep))
const tsc = task('tsc: build - tsconfig.json')
check('tsc: build is the project’s own tsc on that config', tsc.ok && tsc.task.script === "& npx --no-install tsc -p 'tsconfig.json'", tsc.ok && tsc.task.script)
check('found with no tasks.json at all', resolveTask('npm: build', null, ctx).ok)

// --- pieces ------------------------------------------------------------------------------
check('an argument is literal', powerShellArgument("it's $(x)") === "'it''s $(x)'", powerShellArgument("it's $(x)"))
check('except its ${env:…}, read when it runs', powerShellArgument('${env:A}') === '$env:A', powerShellArgument('${env:A}'))
check('forWindows drops the other systems', !('linux' in forWindows({ linux: { a: 1 }, osx: {}, b: 2 })))
check('the task’s block is named for it', taskLabel('build') === '# preLaunchTask: build', taskLabel('build'))

/*
 * --- run for real, where there is PowerShell --------------------------------------------
 *
 * The line is what reaches the pane; the exit code it hands back is what decides
 * whether the debugger starts. A failed build must say so, and a folder the task
 * moves to must not be where the pane's shell is left.
 */
if (process.platform === 'win32') {
  const { spawnSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-task-test-'))
  const sub = path.join(dir, 'sub dir [x]')
  fs.mkdirSync(sub)
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const run = (script, cwd) => {
      const line = taskLine({ script, cwd })
      const b64 = /-EncodedCommand (\S+)$/.exec(line)[1]
      return spawnSync(shell, ['-NoProfile', '-EncodedCommand', b64], { encoding: 'utf8', cwd: dir })
    }
    const probe = spawnSync(shell, ['-NoProfile', '-Command', 'exit 0'])
    if (probe.error) continue
    const failed = run(`& '${process.execPath}' -e 'process.exit(3)'`, dir)
    check(`${shell}: a task that fails hands back its exit code`, failed.status === 3, failed.status)
    const where = run('(Get-Location).Path', sub)
    check(`${shell}: it runs in its folder, brackets and all`, (where.stdout ?? '').trim() === sub, (where.stdout ?? '').trim())
    const ok = run(`& '${process.execPath}' -e '0'`, dir)
    check(`${shell}: and a task that succeeds, 0`, ok.status === 0, ok.status)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  void encodePowerShell
}

console.log(`launch tasks: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
