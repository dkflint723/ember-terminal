// Multi-language LSP checks. Launches the app once per language with a file
// argument, then asserts both what the user can see (hovers, squiggles) and what
// crossed the wire, because the failures this locks down were all silent: the
// editor looked identical whether the language server was answering or dead.
//
// Run: node scripts/verify-lsp.mjs [language...]
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { watchPageErrors } from './harness.mjs'
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
// Uncaught page errors from every language's window.
const pageErrors = []

const CASES = {
  typescript: {
    file: 'sample.ts',
    body: 'interface Point { x: number; y: number }\n\nexport function distance(a: Point, b: Point): number {\n  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)\n}\n\nexport const far = distance({ x: 0, y: 0 }, { x: 3, y: 4 })\n\nconst broken: number = "not a number"\n',
    hoverWord: 'distance',
    hoverIncludes: 'distance',
    minErrorSquiggles: 1,
    rename: { word: 'distance', to: 'separation', expect: 2 }
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
 * Every response the server gave to a request of this method, in order.
 *
 * A response is the first thing arriving *after* its request carrying the same id
 * and no method of its own. Searching by id alone instead matched PowerShell Editor
 * Services' own `client/registerCapability`, which is a request rather than a
 * response and so has no result — a working server read as a failing one.
 */
function answersTo(traffic, method) {
  const out = []
  for (let i = 0; i < traffic.length; i++) {
    const request = traffic[i]
    if (!request.fromClient || request.msg?.method !== method) continue
    const answer = traffic
      .slice(i + 1)
      .find((t) => !t.fromClient && t.msg?.id === request.msg.id && t.msg?.method === undefined)?.msg
    if (answer) out.push(answer)
  }
  return out
}

/** An answer that actually carries something. */
const carries = (answer) => Array.isArray(answer?.result) && answer.result.length > 0

/**
 * The answer that says the server is being reached, if one has arrived yet.
 *
 * Every matching pair is considered rather than only the first, because a file
 * settling produces several of these requests — the outline asks, the breadcrumbs
 * ask, and Go to Symbol below asks again — and a server that has not finished
 * reading the file answers the earliest of them with an empty list. Taking the
 * first pair therefore made the result depend on which request won the race:
 * bash-language-server spends its first seconds failing to shell out to `man` and
 * `help`, so at the tail of a five-language run it lost that race about half the
 * time and the case failed with an empty result while a later answer sat in the
 * same log carrying both symbols.
 */
function findAnswer(traffic, method) {
  return answersTo(traffic, method).find(carries)
}

async function run(language) {
  const spec = CASES[language]
  if (!spec) throw new Error(`No case for ${language}`)

  // A real directory, not a bare temp file: a project-indexing server behaves
  // differently with and without a workspace root.
  const profile = newProfile(language)
  profiles.push(profile)
  /*
   * A space and an accent in the path, on purpose.
   *
   * Three parties spell a Windows path three ways and match documents by string
   * equality, so every disagreement silently drops the message. This suite ran
   * from `ember-typescript-XXXX`, where the only disagreement possible is the
   * drive letter's case — so it proved the easy half and left the ordinary one
   * untested. `C:\Users\Someone\OneDrive - Company\…` and any folder with a name
   * in it are the common cases, and both carry characters that one party may
   * percent-encode and another may not.
   */
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `Ember Tést ${language}-`))
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
  const app = watchPageErrors(
    await electron.launch({
      executablePath: packaged ?? path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
      args: packaged ? [profile.arg, file] : [APP_DIR, profile.arg, file],
      cwd: packaged ? path.dirname(packaged) : APP_DIR,
      env,
      timeout: 60_000
    }),
    pageErrors
  )

  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 })

  // Indexing, then a hover so at least one request is made under user conditions.
  await sleep(6000)
  const target = page.locator('.view-line span[class*="mtk"]', { hasText: spec.hoverWord }).first()
  if (await target.count()) {
    await target.hover()
    /*
     * Waited for, not slept through.
     *
     * Two and a half seconds is plenty for a warm server on an idle machine and
     * not always enough at the tail of a five-language sweep with the rest of the
     * suite competing for the processor — where tsserver answered the hover late
     * and the case reported an empty tooltip. The neighbouring wait below already
     * says this about the servers; the hover was left on a fixed sleep.
     */
    const hoverBy = Date.now() + 20_000
    for (;;) {
      const shown = await page.evaluate(
        () => (document.querySelector('.monaco-hover')?.textContent ?? '').trim().length > 0
      )
      if (shown || Date.now() >= hoverBy) break
      await sleep(300)
    }
  }

  // Waited for rather than slept through. PowerShell Editor Services boots a whole
  // PowerShell host before it answers anything, which no fixed sleep can safely
  // assume — least of all with the rest of the suite competing for the machine.
  if (spec.answersNonEmpty) {
    /*
     * Asked for, rather than waited on.
     *
     * The document-symbol request is Monaco's to make: the outline and the
     * breadcrumbs ask on a schedule of their own, and at the tail of a five-language
     * run this one intermittently never asked at all — the case passes alone and in
     * pairs and failed about half the time in a full sweep, which is a gap in the
     * harness rather than a fault in the server. Go to Symbol is the same request on
     * the path a person would take to make it, so provoking it deliberately both
     * settles the flake and checks the thing the case says it checks. The wait below
     * still stands, because asking is not being answered.
     */
    await page.locator('.view-line').first().click()
    await page.keyboard.press('Control+Shift+O')
    await sleep(1500)
    await page.keyboard.press('Escape')

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

  /*
   * F2, by the road a person takes to it.
   *
   * Monaco's own TypeScript rename is stood down the moment a language server
   * starts, so what this exercises is the server's answer being applied — or not —
   * rather than the bundled one quietly covering for it.
   */
  let rename = null
  if (spec.rename) {
    const word = page
      .locator('.view-line span[class*="mtk"]', { hasText: spec.rename.word })
      .first()
    // Guarded like the hover above it: a selector that matches nothing should
    // report that, not throw and take the rest of the language's run with it.
    const found = (await word.count()) > 0
    if (found) {
      await word.dblclick()
      await sleep(400)
      await page.keyboard.press('F2')
    }
    /*
     * Waited for, not slept through.
     *
     * Both halves of this are a server round-trip — prepareRename opens the box,
     * and the rename itself fills the map — and this file has twice deleted a
     * fixed sleep that was standing in for one. The deadline is long because a
     * loaded machine is the case that breaks these, and the wait ends the moment
     * the thing arrives.
     */
    const box = page.locator('.rename-box input, .monaco-editor input.rename-input').first()
    const boxBy = Date.now() + 20_000
    while (found && Date.now() < boxBy && (await box.count()) === 0) await sleep(200)
    const opened = found && (await box.count()) > 0
    if (opened) {
      await box.fill(spec.rename.to)
      await page.keyboard.press('Enter')
      const editBy = Date.now() + 25_000
      while (Date.now() < editBy) {
        const text = await page.evaluate(() =>
          [...document.querySelectorAll('.view-line')].map((l) => l.textContent ?? '').join(' ')
        )
        if (text.includes(spec.rename.to)) break
        await sleep(250)
      }
      await sleep(400)
    }
    rename = {
      opened,
      text: await page.evaluate(() =>
        [...document.querySelectorAll('.view-line')].map((l) => l.textContent ?? '').join(' ')
      )
    }
  }

  await app.close()

  const lines = readLines(logPath)
  fs.rmSync(work, { recursive: true, force: true })
  return { spec, ui, lines, rename }
}

function check(language, { spec, ui, lines, rename }) {
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

  /*
   * Rename reaches the buffer.
   *
   * typescript-language-server answers with changes keyed by the URI it re-encoded,
   * and the canonicaliser in main rewrote URIs that were values under a key ending
   * in "uri" while leaving URIs that were themselves keys as the server spelled
   * them. Monaco then looked for a model filed under a name nothing was filed under,
   * threw "No text model", and F2 did nothing at all — with the bundled TypeScript
   * rename already stood down, there was nothing left to cover for it.
   */
  if (spec.rename) {
    /*
     * The edits came from the server, not from Monaco's own bundled rename.
     *
     * Without this the check says only that the text changed, which a working
     * bundled provider would also satisfy — and the bundled one is supposed to
     * be stood down while a language server is running. The request on the wire
     * is what distinguishes "rename works" from "something renamed it".
     */
    const asked = sent.some((m) => m?.method === 'textDocument/rename')
    if (!asked) failures.push('no textDocument/rename reached the server')
    if (!rename?.opened) failures.push('F2 did not open a rename box')
    else {
      const hits = rename.text.split(spec.rename.to).length - 1
      if (hits < spec.rename.expect) {
        failures.push(`rename reached ${hits} of ${spec.rename.expect} mentions`)
      }
      if (rename.text.includes(spec.rename.word)) {
        failures.push('the old name is still in the buffer after the rename')
      }
    }
  }

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
      // A URI that is the key, which is how a rename names the file it edits.
      // Reading only values under a key called "uri" left this blind to exactly
      // the spelling that made F2 do nothing.
      if (k.startsWith('file://') && k.includes(spec.file)) uris.add(k)
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
    const answers = answersTo(traffic, spec.answersNonEmpty)
    if (!answers.some(carries)) {
      // Reported with the count, so "the server answered nothing useful once" and
      // "it was never asked at all" cannot be confused for each other.
      failures.push(
        `${spec.answersNonEmpty} returned ${JSON.stringify(answers.at(-1)?.result)} across ` +
          `${answers.length} answer(s), expected a non-empty result`
      )
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
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failed === 0 && pageErrors.length === 0
console.log(passed ? 'multi-language lsp: PASS' : `multi-language lsp: FAIL (${failed} languages, ${pageErrors.length} page errors)`)
process.exit(passed ? 0 : 1)
