// Multi-language LSP checks. Launches the app once per language with a file
// argument, then asserts both what the user can see (hovers, squiggles) and what
// crossed the wire, because the failures this locks down were all silent: the
// editor looked identical whether the language server was answering or dead.
//
// Run: node scripts/verify-lsp.mjs [language...]
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
/**
 * A profile per language, not per run. This harness launches the app four times,
 * and a shared profile would mean the second launch restoring the first language's
 * tabs — the checks would then be looking at the wrong file.
 */
const profiles = []

const CASES = {
  typescript: {
    file: 'sample.ts',
    body: 'interface Point { x: number; y: number }\n\nexport function distance(a: Point, b: Point): number {\n  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)\n}\n\nconst broken: number = "not a number"\n',
    hoverWord: 'distance',
    hoverIncludes: 'distance',
    minErrorSquiggles: 1
  },
  python: {
    file: 'sample.py',
    body: 'import math\n\n\ndef distance(a: tuple[float, float], b: tuple[float, float]) -> float:\n    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)\n\n\nbroken: int = "not an int"\n',
    hoverWord: 'distance',
    hoverIncludes: 'distance',
    minErrorSquiggles: 1
  },
  // No $schema on purpose: schema-driven hover would need a network fetch, whereas a
  // duplicate key is something the server flags on its own.
  yaml: {
    file: 'sample.yaml',
    body: 'name: sample\ndescription: a sample document\nname: duplicated\n',
    hoverWord: 'description',
    minErrorSquiggles: 1
  },
  // PowerShell Editor Services is not shipped with the app; it is used if a copy
  // is already on the machine. Skipped rather than failed when there is not one.
  powershell: {
    file: 'sample.ps1',
    body: 'function Get-Distance {\n    param([int]$X, [int]$Y)\n    [Math]::Sqrt($X * $X + $Y * $Y)\n}\n\nGet-Distance -X 3 -Y 4\n',
    hoverWord: 'Get-Distance',
    answersNonEmpty: 'textDocument/documentSymbol',
    optional: true
  },
  // bash-language-server sources hover text from `man` and diagnostics from
  // shellcheck, neither of which exists on a stock Windows box. Document symbols
  // need only the file itself, so that is what proves the server is being reached.
  shell: {
    file: 'sample.sh',
    body: '#!/usr/bin/env bash\nset -euo pipefail\n\ngreeting="hello"\n\ndistance() {\n  echo "$greeting $1"\n}\n\ndistance world\n',
    hoverWord: 'echo',
    answersNonEmpty: 'textDocument/documentSymbol'
  }
}

const selected = process.argv.slice(2)
const languages = selected.length ? selected : Object.keys(CASES)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const readLines = (logPath) =>
  fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []

/**
 * The traffic in order and with its direction, because a message is not identified
 * by its id alone: client and server number their own requests independently, so
 * both can have a request numbered 1 in flight at the same time.
 */
function parseTraffic(lines) {
  const traffic = []
  for (const line of lines) {
    const body = line.slice(line.indexOf('] ') + 2)
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      continue
    }
    traffic.push({ msg, fromClient: line.startsWith('-->') })
  }
  return traffic
}

/**
 * The server's response to the client's request of this method.
 *
 * It is the first thing arriving *after* that request carrying the same id and no
 * method of its own. Searching by id alone instead matched PowerShell Editor
 * Services' own `client/registerCapability`, which is a request rather than a
 * response and so has no result — a working server read as a failing one.
 */
function findAnswer(traffic, method) {
  const at = traffic.findIndex((t) => t.fromClient && t.msg?.method === method)
  if (at === -1) return undefined
  return traffic
    .slice(at + 1)
    .find((t) => !t.fromClient && t.msg?.id === traffic[at].msg.id && t.msg?.method === undefined)
    ?.msg
}

async function run(language) {
  const spec = CASES[language]
  if (!spec) throw new Error(`No case for ${language}`)

  // A real directory, not a bare temp file: a project-indexing server behaves
  // differently with and without a workspace root.
  const profile = newProfile(language)
  profiles.push(profile)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `ember-${language}-`))
  const file = path.join(work, spec.file)
  fs.writeFileSync(file, spec.body, 'utf8')
  const logPath = path.join(work, 'lsp.log')

  // ELECTRON_RUN_AS_NODE in the ambient shell would make electron.exe boot as plain
  // Node with no app at all. lsp.ts sets it per-child on purpose; it must not be
  // inherited here.
  const env = { ...process.env, EMBER_LSP_LOG: logPath }
  delete env.ELECTRON_RUN_AS_NODE

  // EMBER_EXE points the same checks at a packaged build, where the servers are
  // resolved out of the asar's unpacked sibling rather than the source tree. That
  // path has its own ways to fail, so it is exercised rather than assumed.
  const packaged = process.env.EMBER_EXE
  const app = await electron.launch({
    executablePath: packaged ?? path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: packaged ? [profile.arg, file] : [APP_DIR, profile.arg, file],
    cwd: packaged ? path.dirname(packaged) : APP_DIR,
    env,
    timeout: 60_000
  })

  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 })

  // Indexing, then a hover so at least one request is made under user conditions.
  await sleep(6000)
  const target = page.locator('.view-line span[class*="mtk"]', { hasText: spec.hoverWord }).first()
  if (await target.count()) {
    await target.hover()
    await sleep(2500)
  }

  // Waited for rather than slept through. PowerShell Editor Services boots a whole
  // PowerShell host before it answers anything, which no fixed sleep can safely
  // assume — least of all with the rest of the suite competing for the machine.
  if (spec.answersNonEmpty) {
    const deadline = Date.now() + 60_000
    while (
      Date.now() < deadline &&
      !findAnswer(parseTraffic(readLines(logPath)), spec.answersNonEmpty)
    ) {
      await sleep(500)
    }
  }

  const ui = await page.evaluate(() => ({
    language: document.querySelector('.editor__lang')?.textContent ?? null,
    // A marker reaches the user as a squiggle, so that is what gets asserted.
    errorSquiggles: document.querySelectorAll('.squiggly-error').length,
    hoverText: document.querySelector('.monaco-hover')?.textContent ?? ''
  }))

  await app.close()

  const lines = readLines(logPath)
  fs.rmSync(work, { recursive: true, force: true })
  return { spec, ui, lines }
}

function check(language, { spec, ui, lines }) {
  const failures = []
  const traffic = parseTraffic(lines)
  const sent = traffic.filter((t) => t.fromClient).map((t) => t.msg)
  const received = traffic.filter((t) => !t.fromClient).map((t) => t.msg)

  // An optional server is one this app does not ship — PowerShell Editor Services
  // is used if the machine already has a copy. Its absence is a fact about the
  // machine, not a defect, so it reports as skipped rather than failed.
  if (lines.length === 0 && spec.optional) return ['SKIP: no server installed on this machine']
  if (lines.length === 0) failures.push('no traffic at all — the server never started')
  if (ui.language !== language) failures.push(`pane language is ${ui.language}, expected ${language}`)

  // The server must still be alive at the end. Its own exit is logged; the only
  // acceptable one is the SIGTERM this app sends when the window closes.
  const premature = lines.filter((l) => l.includes('exit: code=') && !l.includes('SIGTERM'))
  if (premature.length) failures.push(`server exited early: ${premature[0].slice(0, 90)}`)

  // A server-initiated request answered with "method not found" is what killed
  // pyright a second after the handshake.
  const notFound = sent.filter((m) => m?.error?.code === -32601)
  if (notFound.length) {
    failures.push(`replied "method not found" to ${notFound.length} server request(s)`)
  }

  // A handler that throws is the quieter version of the same failure: the client
  // aborts a batch of dynamic registrations partway through, so every provider
  // behind the entry it could not map is dropped without anything being logged.
  const threw = sent.filter((m) => m?.error?.code === -32000)
  if (threw.length) {
    failures.push(`the client threw while answering ${threw.length} server request(s)`)
  }

  // Every spelling of the document's URI must be identical, or a server keyed by
  // string finds nothing and answers null to everything.
  const uris = new Set()
  const collect = (v) => {
    if (Array.isArray(v)) return v.forEach(collect)
    if (typeof v !== 'object' || v === null) return
    for (const [k, item] of Object.entries(v)) {
      if (k === 'uri' && typeof item === 'string' && item.includes(spec.file)) uris.add(item)
      else collect(item)
    }
  }
  ;[...sent, ...received].forEach(collect)
  if (uris.size > 1) failures.push(`document has ${uris.size} URI spellings: ${[...uris].join(' , ')}`)

  if (spec.hoverIncludes && !ui.hoverText.includes(spec.hoverIncludes)) {
    failures.push(`hover missing ${JSON.stringify(spec.hoverIncludes)}, got ${JSON.stringify(ui.hoverText.slice(0, 80))}`)
  }
  // Doubled text means two providers answered — the language server and Monaco's
  // own bundled worker both registering for the same language.
  if (spec.hoverIncludes) {
    const first = ui.hoverText.indexOf(spec.hoverIncludes)
    const rest = ui.hoverText.slice(first + 1)
    if (first !== -1 && rest.includes(ui.hoverText.slice(first, first + 40))) {
      failures.push('hover rendered twice — two providers are registered for this language')
    }
  }
  if (spec.minErrorSquiggles && ui.errorSquiggles < spec.minErrorSquiggles) {
    failures.push(`expected >=${spec.minErrorSquiggles} error squiggle(s), saw ${ui.errorSquiggles}`)
  }

  if (spec.answersNonEmpty) {
    const items = findAnswer(traffic, spec.answersNonEmpty)?.result
    if (!Array.isArray(items) || items.length === 0) {
      failures.push(`${spec.answersNonEmpty} returned ${JSON.stringify(items)}, expected a non-empty result`)
    }
  }

  return failures
}

let failed = 0
for (const language of languages) {
  const result = await run(language)
  const failures = check(language, result)
  if (failures.length === 1 && failures[0].startsWith('SKIP:')) {
    console.log(`${language}: SKIP —${failures[0].slice(5)}`)
    continue
  }
  if (failures.length === 1 && failures[0].startsWith('SKIP')) {
    console.log()
    continue
  }
  const summary = `squiggles=${result.ui.errorSquiggles} messages=${result.lines.length}`
  if (failures.length) {
    failed++
    console.log(`${language}: FAIL (${summary})`)
    for (const f of failures) console.log(`    - ${f}`)
    // The traffic is the only place these failures explain themselves.
    for (const line of result.lines) console.log(`      ${line.slice(0, 300)}`)
  } else {
    console.log(`${language}: PASS (${summary})`)
  }
}

profiles.forEach((p) => p.cleanup())
console.log(failed === 0 ? 'multi-language lsp: PASS' : `multi-language lsp: FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
