// Multi-language LSP checks. Launches the app once per language with a file
// argument, then asserts both what the user can see (hovers, squiggles) and what
// crossed the wire, because the failures this locks down were all silent: the
// editor looked identical whether the language server was answering or dead.
//
// Run: node scripts/verify-lsp.mjs [language...]
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')

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

async function run(language) {
  const spec = CASES[language]
  if (!spec) throw new Error(`No case for ${language}`)

  // A real directory, not a bare temp file: a project-indexing server behaves
  // differently with and without a workspace root.
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
    args: packaged ? [file] : [APP_DIR, file],
    cwd: packaged ? path.dirname(packaged) : APP_DIR,
    env,
    timeout: 60_000
  })

  const page = await app.firstWindow()
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 })

  // Indexing, then a hover so at least one request is made under user conditions.
  await sleep(6000)
  const target = page.locator('.view-line span[class*="mtk"]', { hasText: spec.hoverWord }).first()
  if (await target.count()) {
    await target.hover()
    await sleep(2500)
  }

  const ui = await page.evaluate(() => ({
    language: document.querySelector('.editor__lang')?.textContent ?? null,
    // A marker reaches the user as a squiggle, so that is what gets asserted.
    errorSquiggles: document.querySelectorAll('.squiggly-error').length,
    hoverText: document.querySelector('.monaco-hover')?.textContent ?? ''
  }))

  await app.close()

  const lines = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    : []
  fs.rmSync(work, { recursive: true, force: true })
  return { spec, ui, lines }
}

function check(language, { spec, ui, lines }) {
  const failures = []
  const sent = []
  const received = []
  for (const line of lines) {
    const body = line.slice(line.indexOf('] ') + 2)
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      continue
    }
    ;(line.startsWith('-->') ? sent : received).push(msg)
  }

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
    const request = sent.find((m) => m.method === spec.answersNonEmpty)
    const reply = request && received.find((m) => m.id === request.id)
    const items = reply?.result
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

console.log(failed === 0 ? 'multi-language lsp: PASS' : `multi-language lsp: FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
