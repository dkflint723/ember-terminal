// The release gate's end-to-end suites, one at a time, at below-normal priority.
// Run: node scripts/gate.mjs            every suite, then a summary
//      node scripts/gate.mjs --list     check the plan and print it; run nothing
//      node scripts/gate.mjs --only a,b just these (names without the .mjs)
//      node scripts/gate.mjs --from x   resume at a suite after fixing one
//      node scripts/gate.mjs --hosted   leave out what a hosted runner cannot have
//
// It replaces a fifty-link `&&` chain in package.json, which had two faults. It
// stopped at the first failure, so a gate that takes most of an hour reported one
// problem per run. And nothing tied it to the files on disk: fifteen suites had been
// written, passed once, and never run again — flow control, language-server crash
// recovery, the updater, the Claude panel among them. CHANGELOG 0.3.24 records the
// same failure mode ("It had one, and it was never run") and it happened again.
//
// So the list lives here, and every scripts/verify-*.mjs must appear in it or in
// ELSEWHERE with a reason, or the gate fails before running anything. A new suite
// cannot quietly sit outside the gate: forgetting to add it is itself a failure.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const HERE = import.meta.dirname

/** Every suite this runner runs, in order. Independent by design: each has its own profile. */
const ORDER = [
  'verify-editor',
  'verify-tabs',
  'verify-lsp',
  'verify-git',
  'verify-ide',
  'verify-github',
  'verify-explorer',
  'verify-session',
  'verify-notify',
  'verify-settings',
  'verify-search',
  'verify-palette',
  'verify-fileops',
  'verify-problems',
  'verify-vsix',
  'verify-completion',
  'verify-dap',
  'verify-windows',
  'verify-admin',
  'verify-chrome',
  'verify-panes',
  'verify-replace',
  'verify-keys',
  'verify-save',
  'verify-conflict',
  'verify-follow',
  'verify-typing',
  'verify-keeps-work',
  'verify-close',
  'verify-encoding',
  'verify-secrets',
  'verify-paste',
  'verify-integration',
  'verify-snippets',
  'verify-ai',
  'verify-lsp-root',
  'verify-lsp-windows',
  'verify-claude-login',
  'verify-titlebar',
  'verify-output',
  'verify-navigate',
  'verify-contrast',
  'verify-a11y',
  'verify-reopen',
  'verify-modes',
  'verify-blocks',
  'verify-intent',
  'verify-statusbar',
  'verify-shell',
  'verify-plain',
  'verify-bash',
  'verify-live',
  'verify-lines',
  'verify-scripts',
  'verify-history',
  'verify-ssh',
  'verify-ghost',
  'verify-inline-edit',
  'verify-workspaces',
  // Written, passed once, then outside the gate until R1 brought them in.
  'verify-agent',
  'verify-boom',
  'verify-dirpicker',
  'verify-find',
  'verify-flood',
  'verify-format',
  'verify-gutters',
  'verify-links',
  'verify-lsp-custom',
  'verify-lsp-recovery',
  'verify-models',
  'verify-profiles',
  'verify-rebind',
  'verify-window'
]

/** Suites this runner deliberately leaves to another step, each with its reason. */
const ELSEWHERE = {
  'verify-packaged': 'drives a packaged build — runs in verify:packaged against the unpacked one, and in the release job against the installed one',
  'verify-update': 'needs a packaged build — runs after verify-packaged, in both of those places'
}

/*
 * Suites that need something a hosted runner does not have, each with what that is.
 *
 * A skip is fatal under EMBER_STRICT, which is right: a suite that skips for want of
 * a shell on the maintainer's machine is a check nobody ran. On a hosted runner these
 * three skip every night for reasons that are about the runner and not the code —
 * there is no VS Code, no gh login and no Claude Code there, and there never will
 * be — so the nightly went red on them five nights out of five and red stopped
 * meaning anything. `--hosted` leaves them out and says so, by name, with the reason,
 * because a subset that hides its exclusions is the same trick as a check that
 * cannot fail. They still run, and still have to pass, anywhere they can.
 */
const NEEDS_A_REAL_MACHINE = {
  'verify-vsix': 'imports themes from an installed VS Code extension; a hosted runner has no VS Code',
  'verify-github': 'drives the GitHub panel through a signed-in gh; a hosted runner has no gh login to lend it',
  'verify-claude-login': 'needs Claude Code installed and signed in; a hosted runner has neither'
}

// --- the plan has to match the files -------------------------------------------
const onDisk = fs
  .readdirSync(HERE)
  .filter((f) => /^verify-.+\.mjs$/.test(f))
  .map((f) => f.slice(0, -'.mjs'.length))
const unplaced = onDisk.filter((s) => !ORDER.includes(s) && !(s in ELSEWHERE))
const missing = [...ORDER, ...Object.keys(ELSEWHERE), ...Object.keys(NEEDS_A_REAL_MACHINE)].filter(
  (s) => !onDisk.includes(s)
)
const strayHosted = Object.keys(NEEDS_A_REAL_MACHINE).filter((s) => !ORDER.includes(s))
if (strayHosted.length) {
  console.log(`hosted exclusions that are not gated suites: ${strayHosted.join(', ')}`)
  process.exit(1)
}
const twice = ORDER.filter((s, i) => ORDER.indexOf(s) !== i)
if (unplaced.length || missing.length || twice.length) {
  if (unplaced.length) console.log(`not in the gate: ${unplaced.join(', ')} — add each to ORDER, or to ELSEWHERE with a reason`)
  if (missing.length) console.log(`listed but not on disk: ${missing.join(', ')}`)
  if (twice.length) console.log(`listed twice: ${twice.join(', ')}`)
  console.log('GATE: FAIL — the plan does not match scripts/')
  process.exit(1)
}

// --- which to run ----------------------------------------------------------------
const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : (args[i + 1] ?? '')
}
let plan = [...ORDER]
const only = option('--only')
if (only) {
  const wanted = only.split(',').map((s) => (s.startsWith('verify-') ? s : `verify-${s}`))
  const unknown = wanted.filter((s) => !ORDER.includes(s))
  if (unknown.length) {
    console.log(`not a gated suite: ${unknown.join(', ')}`)
    process.exit(1)
  }
  plan = ORDER.filter((s) => wanted.includes(s))
}
const from = option('--from')
if (from) {
  const start = plan.indexOf(from.startsWith('verify-') ? from : `verify-${from}`)
  if (start === -1) {
    console.log(`not in the plan: ${from}`)
    process.exit(1)
  }
  plan = plan.slice(start)
}

const hosted = args.includes('--hosted')
if (hosted) plan = plan.filter((s) => !(s in NEEDS_A_REAL_MACHINE))
// And said to every suite, for the finer grain: a suite that runs here but finds one
// thing a runner cannot have — verify-bash and a WSL with no distribution in it —
// skips that much and says so, rather than failing strict for it.
if (hosted) process.env.EMBER_HOSTED = '1'

if (args.includes('--list')) {
  console.log(`${plan.length} suites, in order:`)
  for (const s of plan) console.log(`  ${s}`)
  for (const [s, why] of Object.entries(ELSEWHERE)) console.log(`  (${s}: ${why})`)
  for (const [s, why] of Object.entries(NEEDS_A_REAL_MACHINE)) {
    console.log(`  (${s}: ${hosted ? 'left out here' : 'runs here'} — ${why})`)
  }
  process.exit(0)
}
if (hosted) {
  console.log('left out on a hosted runner, and why:')
  for (const [s, why] of Object.entries(NEEDS_A_REAL_MACHINE)) console.log(`  ${s}: ${why}`)
}

/*
 * Below normal, for everything this starts.
 *
 * Fifty Electron launches back to back have frozen the machine this runs on. On
 * Windows a child created without a priority class of its own takes its parent's
 * when the parent is below normal, so setting it once here covers node, Electron and
 * the shells each suite starts — the user's own windows stay responsive while the
 * gate grinds on underneath them.
 */
try {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL)
} catch {
  console.log('(could not lower priority; running at normal)')
}

/*
 * Every suite runs, even after one fails. The gate takes most of an hour; stopping
 * at the first failure made each run report a single problem, and the next run
 * would find the one behind it.
 */
const results = []
const SUITE_TIMEOUT_MS = 20 * 60_000
for (const suite of plan) {
  console.log(`\n=== ${suite} ===`)
  const started = Date.now()
  const r = spawnSync(process.execPath, [path.join(HERE, `${suite}.mjs`)], {
    stdio: 'inherit',
    timeout: SUITE_TIMEOUT_MS
  })
  const seconds = Math.round((Date.now() - started) / 1000)
  const outcome =
    r.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : r.status === 0 ? 'PASS' : `FAIL (exit ${r.status ?? r.signal})`
  results.push({ suite, outcome, seconds })
}

// --- the verdict -----------------------------------------------------------------
const failed = results.filter((r) => r.outcome !== 'PASS')
const minutes = Math.round(results.reduce((n, r) => n + r.seconds, 0) / 60)
console.log(`\n--- gate summary: ${results.length} suites, ${minutes} min ---`)
for (const r of results) console.log(`${r.outcome.padEnd(14)} ${String(r.seconds).padStart(4)}s  ${r.suite}`)
console.log(failed.length === 0 ? 'GATE: PASS' : `GATE: FAIL — ${failed.length} of ${results.length}: ${failed.map((r) => r.suite).join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
