// References and rename across files that are not open. Run: node scripts/verify-lsp-crossfile.mjs
//
// The audit's acceptance for the language-server work (R15): "F2 renames. Shift+F12
// lists references in files that aren't open." A TypeScript project of two files,
// one open in the editor and one only on disk, and the two things a person does
// with a function used in the other one.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('lsp-crossfile')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-crossfile-'))
fs.writeFileSync(
  path.join(dir, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'es2022' }, include: ['*.ts'] })
)
fs.writeFileSync(path.join(dir, 'Greet.ts'), "export function greet(name: string): string {\n  return 'hello ' + name\n}\n")
// Only on disk: never opened in the editor.
fs.writeFileSync(path.join(dir, 'UseGreet.ts'), "import { greet } from './Greet'\n\nexport const message = greet('world')\n")

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, dir],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 }).catch(() => {})

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await page.locator('.qp__box').fill('Greet.ts')
await sleep(500)
await page.keyboard.press('Enter')
await page.waitForFunction(
  () => window.monaco?.editor.getModels().some((m) => m.uri.path.toLowerCase().endsWith('/greet.ts')),
  null,
  { timeout: 30_000 }
)

const editorOf = (name) => `window.monaco.editor.getEditors().find((e) => e.getModel()?.uri.path.toLowerCase().endsWith('${name}'))`
const onGreet = async () => {
  await page.evaluate(`(() => { const e = ${editorOf('/greet.ts')}; e.focus(); e.setPosition({ lineNumber: 1, column: 18 }) })()`)
}

/*
 * The server holding the whole project, not just the open file: asked directly for
 * the references until its own answer names use.ts. A hover is answered well before
 * that — the first run of this suite pressed Shift+F12 as soon as one was, and the
 * server's answer named only the declaration. What is tested below is whether the
 * editor shows what the server knows, so it waits until the server knows it.
 */
let ready = false
for (let until = Date.now() + 60_000; !ready && Date.now() < until; ) {
  await sleep(1000)
  ready = await page.evaluate(async () => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.toLowerCase().endsWith('/greet.ts'))
    if (!model) return false
    const reply = await window.ember.lspRequest('typescript', 'textDocument/references', {
      textDocument: { uri: model.uri.toString(true) },
      position: { line: 0, character: 17 },
      context: { includeDeclaration: true }
    })
    return JSON.stringify(reply ?? null).toLowerCase().includes('usegreet.ts')
  })
}
check('the TypeScript server knows the file that is not open', ready)

// --- Shift+F12: the references include the file that is not open ----------------
await onGreet()
await page.keyboard.press('Shift+F12')
let listed = ''
for (let until = Date.now() + 20_000; !listed.toLowerCase().includes('usegreet.ts') && Date.now() < until; ) {
  await sleep(500)
  listed = await page.evaluate(() => {
    const peek = document.querySelector('.peekview-widget, .zone-widget .reference-zone-widget')
    return peek?.textContent ?? ''
  })
}
console.log('references shown:', JSON.stringify(listed.slice(0, 300)))
// Compared without case: the list names files by the editor's own keys for them,
// which are lower-cased for every file, open or not.
check('Shift+F12 lists the reference in the file that is not open', listed.toLowerCase().includes('usegreet.ts'), listed.slice(0, 200) || '(no references view)')
await page.keyboard.press('Escape')
await sleep(500)

// --- F2: the rename reaches the file that is not open ----------------------------
await onGreet()
await page.keyboard.press('F2')
const box = page.locator('.rename-box input, .monaco-editor input.rename-input').first()
for (let until = Date.now() + 20_000; (await box.count()) === 0 && Date.now() < until; ) await sleep(200)
const boxOpened = (await box.count()) > 0
check('F2 opens the rename box', boxOpened)
if (boxOpened) {
  await box.fill('welcome')
  await page.keyboard.press('Enter')
}
const useText = () =>
  page.evaluate(() => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.toLowerCase().endsWith('/usegreet.ts'))
    return model ? model.getValue() : null
  })
const onDisk = () => fs.readFileSync(path.join(dir, 'UseGreet.ts'), 'utf8')
let renamedThere = false
for (let until = Date.now() + 15_000; !renamedThere && Date.now() < until; ) {
  await sleep(500)
  renamedThere = ((await useText()) ?? onDisk()).includes('welcome')
}
const greetText = await page.evaluate(
  () => window.monaco.editor.getModels().find((m) => m.uri.path.toLowerCase().endsWith('/greet.ts'))?.getValue() ?? ''
)
console.log('greet.ts after rename:', JSON.stringify(greetText.slice(0, 80)))
console.log('use.ts model after rename:', JSON.stringify(await useText()))
console.log('use.ts on disk after rename:', JSON.stringify(onDisk()))
check('the rename changes the open file', greetText.includes('function welcome('), greetText.slice(0, 80))
check('and the file that is not open', renamedThere, JSON.stringify((await useText()) ?? onDisk()))

/*
 * A change to a file with no tab could be neither seen nor saved, and would go at
 * quit. So that file is opened, unsaved, and nothing is written behind anyone's back.
 */
let tabs = []
for (let until = Date.now() + 8_000; Date.now() < until; ) {
  // Each tab by its own label and its own unsaved marker, not the pane's.
  tabs = await page.evaluate(() =>
    [...document.querySelectorAll('.etab')].map((el) => ({
      title: el.querySelector('.etab__label')?.textContent ?? '',
      unsaved: !!el.querySelector('.editor__dirty')
    }))
  )
  if (tabs.some((t) => t.title === 'UseGreet.ts')) break
  await sleep(300)
}
console.log('tabs after rename:', JSON.stringify(tabs))
const useTab = tabs.find((t) => t.title === 'UseGreet.ts')
check('the renamed file that was not open is opened', useTab !== undefined, JSON.stringify(tabs))
check('and marked unsaved', useTab?.unsaved === true, JSON.stringify(useTab))
check('and not written to disk behind anyone', onDisk().includes("greet('world')"), JSON.stringify(onDisk()))
const said = await page.evaluate(() => document.body.textContent ?? '')
const renamedNotice = (said.match(/Renamed in 2 files: [^.]*\.[a-z]+[^.]*\.[a-z]+/) ?? [''])[0]
check('a notice names both files, as they are spelled', renamedNotice.includes('Greet.ts') && renamedNotice.includes('UseGreet.ts'), renamedNotice || '(no notice)')

/*
 * Saved, the file keeps its name. The server hands paths back lower-cased, and a
 * tab opened by that spelling was called usegreet.ts — and saving it renamed the
 * file on disk to match.
 */
await page.locator('.etab', { hasText: 'UseGreet.ts' }).click()
await sleep(400)
// Saved from the editor, as a person would: the click leaves focus on the tab.
await page.evaluate(`(() => ${editorOf('/usegreet.ts')}?.focus())()`)
await page.keyboard.press('Control+s')
for (let until = Date.now() + 10_000; !onDisk().includes('welcome') && Date.now() < until; ) await sleep(200)
const saidOnSave = onDisk().includes('welcome') ? '' : ((await page.evaluate(() => document.body.textContent ?? '')).match(/[^.]{0,80}(sav|chang|disk)[^.]{0,80}\./gi) ?? []).slice(-3).join(' | ')
check('saved, the renamed file has the change', onDisk().includes("welcome('world')"), `${JSON.stringify(onDisk())} ${saidOnSave}`)
const names = fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))
check('and keeps its name as it was spelled', names.includes('UseGreet.ts') && names.includes('Greet.ts'), JSON.stringify(names))

/*
 * --- a refactoring the server applies itself ----------------------------------
 *
 * Extract to constant is a code action whose edit the TypeScript server does not
 * return: it runs a command, and then asks the editor to make the edit
 * (`workspace/applyEdit`). Ember declined every such request, so the refactoring
 * was offered and did nothing.
 */
// Back to Greet.ts: a pane holds an editor only for the file it is showing.
await page.locator('.etab', { hasText: 'Greet.ts' }).first().click()
await page.waitForFunction(
  () => window.monaco.editor.getEditors().some((e) => e.getModel()?.uri.path.toLowerCase().endsWith('/greet.ts')),
  null,
  { timeout: 10_000 }
)
await page.evaluate(`(() => {
  const e = ${editorOf('/greet.ts')}
  e.focus()
  const line = e.getModel().getLinesContent().findIndex((l) => l.includes("'hello ' + name")) + 1
  const col = e.getModel().getLineContent(line).indexOf("'hello ' + name") + 1
  e.setSelection({ startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col + "'hello ' + name".length })
})()`)
await page.evaluate(`(() => ${editorOf('/greet.ts')}.trigger('verify', 'editor.action.codeAction', { kind: 'refactor.extract.constant', apply: 'first' }))()`)
const greetNow = () =>
  page.evaluate(
    () => window.monaco.editor.getModels().find((m) => m.uri.path.toLowerCase().endsWith('/greet.ts'))?.getValue() ?? ''
  )
let extracted = ''
for (let until = Date.now() + 15_000; Date.now() < until; ) {
  extracted = await greetNow()
  if (/const \w+ = 'hello ' \+ name/.test(extracted)) break
  await sleep(300)
}
console.log('greet.ts after extract:', JSON.stringify(extracted.slice(0, 200)))
check('a refactoring the server applies itself changes the file', /const \w+ = 'hello ' \+ name/.test(extracted), JSON.stringify(extracted.slice(0, 160)))
// And comes back out as one step: a single undo takes the whole refactoring away.
await page.evaluate(`(() => { const e = ${editorOf('/greet.ts')}; e.focus(); e.trigger('verify', 'undo', null) })()`)
await sleep(500)
const undone = await greetNow()
check(
  'one undo takes the refactoring back',
  // Only meaningful once there was a refactoring to take back.
  /const \w+ = 'hello ' \+ name/.test(extracted) &&
    !/const \w+ = 'hello ' \+ name/.test(undone) &&
    undone.includes("return 'hello ' + name"),
  JSON.stringify(undone.slice(0, 160))
)

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('cross-file references and rename:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
