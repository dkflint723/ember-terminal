// Snippets in the VS Code format.
//
// A snippet is worth having only if it reaches the completion list and expands with
// its placeholders live, so that is what this drives — through the UI, not by
// calling the provider.
//
// Run: node scripts/verify-snippets.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('snippets')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-snippets-'))
const file = path.join(work, 'sample.ts')
fs.writeFileSync(file, 'const existing = 1\n', 'utf8')

// Written where the app will look for them: a language-named file for one language,
// and a .code-snippets file that names its own scope.
const snippetDir = path.join(profile.dir, 'snippets')
fs.mkdirSync(snippetDir, { recursive: true })
fs.writeFileSync(
  path.join(snippetDir, 'typescript.json'),
  JSON.stringify({
    'Ember Log': {
      prefix: 'emberlog',
      body: ['console.log("${1:message}")', '$0'],
      description: 'Log something'
    }
  }),
  'utf8'
)
fs.writeFileSync(
  path.join(snippetDir, 'shared.code-snippets'),
  JSON.stringify({
    'Ember Guard': {
      prefix: 'emberguard',
      scope: 'typescript,javascript',
      body: 'if (!${1:value}) return'
    },
    'Other Language Only': {
      prefix: 'emberpython',
      scope: 'python',
      body: 'pass'
    },
    'Everywhere': {
      prefix: 'emberany',
      body: 'TODO(${1:who})'
    }
  }),
  'utf8'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, file],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
const BENIGN = [/textDocument\/foldingRange failed/]
page.on('pageerror', (e) => {
  if (!BENIGN.some((re) => re.test(e.message))) errors.push(e.message)
})
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
await sleep(3000)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const editorText = () =>
  page.evaluate(() => document.querySelector('.pane.editor .view-lines')?.textContent ?? '')

/** Type a prefix on a fresh line and read back what the completion list offers. */
const suggestionsFor = async (prefix) => {
  await page.locator('.pane.editor .view-lines').first().click()
  await sleep(300)
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(prefix, { delay: 40 })
  await sleep(1500)
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row')).map(
      (r) => r.textContent ?? ''
    )
  )
}

// --- offered in the completion list ------------------------------------------
const listed = await suggestionsFor('emberlo')
check(
  'a snippet from a language-named file is offered',
  listed.some((l) => l.includes('emberlog')),
  JSON.stringify(listed.slice(0, 6))
)

// --- expands, with the placeholder selected ----------------------------------
await page.keyboard.press('Enter')
await sleep(1200)
const expanded = await editorText()
check(
  'choosing it inserts the body',
  expanded.includes('console.log(') && !expanded.includes('${1:'),
  expanded.slice(-80)
)
// The first placeholder is selected, so typing replaces it — that is what makes a
// snippet a snippet rather than a paste.
await page.keyboard.type('hello')
await sleep(800)
const typed = await editorText()
check(
  'the first placeholder takes what is typed next',
  typed.includes('hello') && !typed.includes('message'),
  typed.slice(-80)
)

// --- a .code-snippets scope is honoured ---------------------------------------
const scoped = await suggestionsFor('emberguar')
check(
  'a scoped snippet is offered to a language in its scope',
  scoped.some((l) => l.includes('emberguard')),
  JSON.stringify(scoped.slice(0, 6))
)

const wrong = await suggestionsFor('emberpyth')
check(
  'and not to a language outside it',
  !wrong.some((l) => l.includes('emberpython')),
  JSON.stringify(wrong.slice(0, 6))
)

const everywhere = await suggestionsFor('emberan')
check(
  'an entry with no scope at all is offered anyway',
  everywhere.some((l) => l.includes('emberany')),
  JSON.stringify(everywhere.slice(0, 6))
)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('snippets:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
