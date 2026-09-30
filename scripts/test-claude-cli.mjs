// How Ember runs the Claude Code CLI. Run: node scripts/test-claude-cli.mjs
//
// It passed the prompt and the system prompt on the command line, which Windows
// limits to 32,767 characters; relied on a list of tools to disallow, which fell
// behind every CLI release that added one; ran in whatever folder Ember was started
// in; and built its error text from execFile's message, which is the whole command
// line (audit R26, SE-08). This runs the real service against a stand-in CLI and
// holds it to: prompt over stdin, system prompt in a file that is gone afterwards,
// every tool turned off and a start that lists any stopped, an empty folder of its
// own, and errors in the CLI's own words.
import './ts-resolve.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
const { ClaudeCliService } = await import('../src/main/claude-cli.ts')

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const FAKE = path.join(import.meta.dirname, 'fake-claude-cli.mjs')
const recordFile = path.join(os.tmpdir(), `ember-fake-claude-${process.pid}.json`)
process.env.FAKE_RECORD = recordFile
const record = () => JSON.parse(fs.readFileSync(recordFile, 'utf8'))
const run = async (env, system, prompt) => {
  for (const k of ['FAKE_OLD', 'FAKE_TOOLS', 'FAKE_FAIL', 'FAKE_SILENT', 'FAKE_HELP_ALT', 'FAKE_HELP_FAIL']) delete process.env[k]
  Object.assign(process.env, env)
  const cli = new ClaudeCliService(process.execPath, [FAKE])
  let streamed = ''
  const res = await cli.askStream(system, prompt, 'claude-test', (d) => (streamed += d)).done
  return { res, streamed }
}

// --- a long conversation goes over stdin -------------------------------------------------
const long = 'x'.repeat(40_000) + ' the end'
const big = await run({}, 'SYSTEM-' + 's'.repeat(20_000), long)
const seen = record()
check('a 40 KB prompt is answered', big.res.ok && big.streamed === `heard ${long.length} chars`, JSON.stringify(big.res).slice(0, 200))
check('the prompt arrives over stdin, whole', seen.stdin === long, `${seen.stdin.length} chars`)
check('and is nowhere on the command line', !seen.argv.some((a) => a.includes('the end')), seen.argv.join(' ').slice(0, 200))
check('the system prompt is read from a file', seen.systemFromFile?.startsWith('SYSTEM-') && !seen.argv.some((a) => a.startsWith('SYSTEM-')))
check('which is gone afterwards', seen.systemFile && !fs.existsSync(seen.systemFile), seen.systemFile)
check('every tool is turned off', seen.argv.includes('--tools') && seen.argv[seen.argv.indexOf('--tools') + 1] === '', seen.argv.join(' '))
check('it runs in an empty folder of its own', seen.cwdEntries.length === 0 && path.basename(seen.cwd).startsWith('ember-claude-'), seen.cwd)
check('which is gone afterwards too', !fs.existsSync(seen.cwd), seen.cwd)

// --- a start that lists tools is stopped ------------------------------------------------------
const armed = await run({ FAKE_TOOLS: 'Bash,Edit' }, 'sys', 'hello')
check('a CLI that starts with tools is stopped before it answers', !armed.res.ok && armed.streamed === '', JSON.stringify(armed))
check('and says which', !armed.res.ok && armed.res.error.includes('Bash'), JSON.stringify(armed.res))

// --- an older CLI -------------------------------------------------------------------------------
const old = await run({ FAKE_OLD: '1' }, 'OLD-SYSTEM', 'hi')
const oldSeen = record()
check('an older CLI without --tools is not given it', !oldSeen.argv.includes('--tools'), oldSeen.argv.join(' '))
check('and gets the system prompt the way it understands', oldSeen.argv.includes('--system-prompt') && oldSeen.argv.includes('OLD-SYSTEM'))
check('and still answers when it lists no tools', old.res.ok, JSON.stringify(old.res))

// --- what the help says, read carefully and not held against it -----------------------------
const alt = await run({ FAKE_HELP_ALT: '1' }, 'sys', 'hi')
check('--tools is found whatever its placeholder', alt.res.ok && record().argv.includes('--tools'), record().argv.join(' '))
check('an older CLI’s refusal says it is too old', !(await run({ FAKE_OLD: '1', FAKE_TOOLS: 'LS' }, 's', 'p')).res.ok && (await run({ FAKE_OLD: '1', FAKE_TOOLS: 'LS' }, 's', 'p')).res.error.includes('too old'))
{
  const keep = ['FAKE_OLD', 'FAKE_TOOLS', 'FAKE_FAIL', 'FAKE_SILENT', 'FAKE_HELP_ALT']
  for (const k of keep) delete process.env[k]
  const same = new ClaudeCliService(process.execPath, [FAKE])
  process.env.FAKE_HELP_FAIL = '1'
  await same.askStream('s', 'p', 'm', () => {}).done
  delete process.env.FAKE_HELP_FAIL
  const again = await same.askStream('s', 'p', 'm', () => {}).done
  check('a --help that failed once is asked again, not held for the launch', again.ok && record().argv.includes('--tools'), JSON.stringify(again))
}

// --- errors, in the CLI's own words ---------------------------------------------------------------
const failed = await run({ FAKE_FAIL: '1' }, 'sys', 'a prompt that must not appear in an error')
check('a failure is said in the CLI’s words', !failed.res.ok && failed.res.error === 'Error: model not found: nope', JSON.stringify(failed.res))
const silent = await run({ FAKE_SILENT: '1' }, 'sys', 'a prompt that must not appear in an error')
check('and one that says nothing is not described by its command line', !silent.res.ok && !silent.res.error.includes('prompt') && !silent.res.error.includes('--model'), JSON.stringify(silent.res))
check('but by its exit code', !silent.res.ok && silent.res.error.includes('exit code 2'), JSON.stringify(silent.res))

// --- not installed is ENOENT, and only ENOENT ---------------------------------------------------------
const absent = new ClaudeCliService(path.join(os.tmpdir(), 'no-such-claude-here.exe'))
const access = await absent.access()
check('a CLI that is not there is not installed', access.installed === false, JSON.stringify(access))
const nothing = await absent.askStream('s', 'p', 'm', () => {}).done
check('and asking it says it is not installed', !nothing.ok && /not installed/.test(nothing.error), JSON.stringify(nothing))

// --- cancel -------------------------------------------------------------------------------------------
for (const k of ['FAKE_OLD', 'FAKE_TOOLS', 'FAKE_FAIL', 'FAKE_SILENT', 'FAKE_HELP_ALT', 'FAKE_HELP_FAIL']) delete process.env[k]
const cli = new ClaudeCliService(process.execPath, [FAKE])
const stream = cli.askStream('s', 'p', 'm', () => {})
stream.cancel()
const cancelled = await stream.done
check('a cancel ends it as cancelled', cancelled.cancelled === true, JSON.stringify(cancelled))

fs.rmSync(recordFile, { force: true })
console.log(`claude cli: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
