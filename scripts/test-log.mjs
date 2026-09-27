// ember.log's size and what is kept out of it. Run: node scripts/test-log.mjs
//
// Main appended every fault to ember.log directly: never trimmed, and written as the
// fault came, so a key an error happened to quote was in the one file people attach
// to a bug report. main/log.ts rotates it at 2 MB, keeps three generations back, and
// passes every line through redactSecrets. This drives it against a real directory.
//
// main's sources import each other by their compiled names (`../shared/secrets.js`),
// which Node's type stripping does not map back to the .ts on disk; the hook below
// does only that.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const js = new URL(specifier, context.parentURL)
      const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (!fs.existsSync(fileURLToPath(js)) && fs.existsSync(fileURLToPath(ts))) {
        return next(ts.href, context)
      }
    }
    return next(specifier, context)
  }
})
const real = await import('../src/main/log.ts')
const { GENERATIONS, LOG_NAME } = real

/**
 * EMBER_OLD_RULE=1: the writer index.ts had before, copied as it was — append, as the
 * fault came — behind the same four methods, to show the cases catch it.
 */
const oldLog = (dirOf) => {
  const append = (label, line) => {
    try {
      fs.appendFileSync(path.join(dirOf(), 'ember.log'), `[${new Date().toISOString()}] ${label}: ${line}\n`)
    } catch {
      // as before
    }
  }
  return {
    line: append,
    fault: (label, detail) =>
      append(label, detail instanceof Error ? (detail.stack ?? detail.message) : String(detail)),
    tail: (n) => {
      try {
        return fs.readFileSync(path.join(dirOf(), 'ember.log'), 'utf8').trimEnd().split('\n').slice(-n)
      } catch {
        return []
      }
    },
    path: () => path.join(dirOf(), 'ember.log')
  }
}
const createLog = process.env.EMBER_OLD_RULE ? oldLog : real.createLog

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ember-log-'))
const read = (dir, name = LOG_NAME) => {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8')
  } catch {
    return ''
  }
}
const lineWith = (text, needle) => text.split('\n').find((l) => l.includes(needle))
const names = (dir) => fs.readdirSync(dir).sort()

// --- the format the suites and people read is unchanged -------------------------
{
  const dir = fresh()
  const log = createLog(() => dir)
  log.fault('renderer gone', 'crashed (exit 5)')
  const err = new Error('boom')
  log.fault('uncaught exception in main', err)
  log.line('updater', 'checking')
  const text = read(dir)
  const lines = text.split('\n')
  check('a fault is one `[time] label: text` line', /^\[\d{4}-\d\d-\d\dT[^\]]+\] renderer gone: crashed \(exit 5\)$/.test(lines[0]), lines[0])
  check('an Error is written with its stack, continuing on the lines after', text.includes('uncaught exception in main: Error: boom\n    at '), text.slice(0, 300))
  check('narration is written the same way', /\] updater: checking$/m.test(text))
  check('tail gives the last lines, newest last', log.tail(1)[0]?.endsWith('updater: checking'), JSON.stringify(log.tail(1)))
  check('path names the current file', log.path() === path.join(dir, LOG_NAME), log.path())
}

// --- no key reaches the file -----------------------------------------------------
{
  const dir = fresh()
  const log = createLog(() => dir)
  const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  const aws = 'AKIAABCDEFGHIJKLMNOP'
  log.fault('update failed', new Error(`request with x-api-key ${key} refused`))
  log.fault('admin window could not be started', `env had ${aws}`)
  log.line('updater', `token=${key}`)
  log.fault(`a label quoting ${key}`, 'x')
  log.fault('an object', { headers: { authorization: `Bearer ${key}` } })
  const text = read(dir)
  check('an Anthropic key in an error message is redacted', !text.includes(key), lineWith(text, key))
  check('an AWS key id is redacted', !text.includes(aws), lineWith(text, aws))
  check('a key in a label is redacted too', !/a label quoting sk-ant/.test(text), lineWith(text, 'a label quoting'))
  check('and what was around it is kept', text.includes('refused') && text.includes('[redacted]'), lineWith(text, 'refused'))
}

// --- it stays under its size -----------------------------------------------------
{
  const dir = fresh()
  const log = createLog(() => dir, 10_000)
  const filler = 'x'.repeat(990)
  for (let i = 0; i < 200; i += 1) log.fault('loop', `${i} ${filler}`)
  const files = names(dir)
  const total = files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0)
  check(
    `200 KB of faults leave the current file and ${GENERATIONS} generations, no more`,
    JSON.stringify(files) === JSON.stringify(['ember.1.log', 'ember.2.log', 'ember.3.log', 'ember.log']),
    JSON.stringify(files)
  )
  check('each file is near the limit, not past it by more than one line', files.every((f) => fs.statSync(path.join(dir, f)).size < 10_000 + 1100), files.map((f) => fs.statSync(path.join(dir, f)).size).join(','))
  check('in total a bounded size', total < 4 * (10_000 + 1100), `${total} bytes`)
  check('the newest fault is in the current file', read(dir).includes('199 x'))
  check('the generation before it holds the lines just before', /\b1[89]\d x/.test(read(dir, 'ember.1.log')))
  check('the oldest faults are the ones dropped', !files.some((f) => read(dir, f).includes('] loop: 0 x')))
}

// --- one line cannot outgrow the limit ---------------------------------------------
{
  const dir = fresh()
  const log = createLog(() => dir, 10_000)
  log.fault('quoted a whole file', 'x'.repeat(5_000_000))
  const size = fs.statSync(path.join(dir, LOG_NAME)).size
  check('a 5 MB fault is written clipped, not whole', size < 70 * 1024, `${size} bytes`)
  check('and says how much was left out', /\[4\d{6} more characters\]/.test(read(dir)))
}

/*
 * --- a file someone else holds open ------------------------------------------------
 *
 * `Get-Content -Wait`, or an editor tailing the log, holds it without letting it be
 * renamed. Rotation then failed part-way — after the older generations had been
 * shifted and the oldest deleted — and took the line with it, so every fault while it
 * was held was lost along with a generation of history. Windows only: it is Windows
 * that refuses the rename. A .NET handle, as PowerShell's own tail opens one.
 */
if (process.platform === 'win32') {
  const { spawn } = await import('node:child_process')
  const dir = fresh()
  const log = createLog(() => dir, 1_000)
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, `ember.${n}.log`), `GEN${n}\n`)
  fs.writeFileSync(path.join(dir, LOG_NAME), 'CURRENT '.repeat(200) + '\n')
  const target = path.join(dir, LOG_NAME).replace(/'/g, "''")
  const holder = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$f = [IO.File]::Open('${target}', 'Open', 'Read', 'ReadWrite'); 'held'; Start-Sleep -Seconds 4; $f.Close()`
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  await new Promise((resolve) => {
    holder.stdout.on('data', (d) => d.toString().includes('held') && resolve())
    setTimeout(resolve, 15_000)
  })
  log.fault('while held', 'first')
  log.fault('while held', 'second')
  const during = read(dir)
  const kept = [1, 2, 3].map((n) => read(dir, `ember.${n}.log`))
  await new Promise((resolve) => holder.on('exit', resolve))
  check('a fault written while the file is held is not lost', during.includes('while held: first') && during.includes('while held: second'), during.slice(-200))
  check('and no generation is lost to the failed rotation', kept.join('|') === 'GEN1\n|GEN2\n|GEN3\n', JSON.stringify(kept))
  log.fault('after', 'let go')
  check('once let go, the next write rotates', read(dir, 'ember.1.log').includes('while held: second') && read(dir).includes('after: let go'), JSON.stringify(names(dir)))
}

// --- a log that cannot be written is not a crash --------------------------------
{
  const missing = path.join(fresh(), 'no', 'such', 'dir')
  const log = createLog(() => missing)
  let threw = null
  try {
    log.fault('anything', new Error('x'))
    log.line('updater', 'x')
  } catch (e) {
    threw = e
  }
  check('writing into a directory that is not there does not throw', threw === null, String(threw))
  check('and tail of a log that is not there is empty', Array.isArray(log.tail(200)) && log.tail(200).length === 0)
  let dirThrew = null
  const broken = createLog(() => {
    throw new Error('userData not ready')
  })
  try {
    broken.fault('early', 'x')
  } catch (e) {
    dirThrew = e
  }
  check('a directory that cannot be asked for yet does not throw either', dirThrew === null, String(dirThrew))
}

console.log(`ember.log: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
