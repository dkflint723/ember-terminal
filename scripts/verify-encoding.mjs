// Files that are not UTF-8, opened and saved as what they are.
//
// The editor read every file as UTF-8, turning any byte it could not decode into a
// replacement character, and wrote UTF-8 back. A Windows-1252 .ini holding "café"
// opened as "caf?" and looked unmodified, and saving an unrelated line wrote
// EF BF BD over the é for good. A NUL byte meant binary, so every UTF-16 file —
// what Windows PowerShell 5.1's `>` writes — was refused outright. And replace in
// files skipped anything that was not UTF-8, which at least did no harm.
//
// Here each kind is opened, edited and saved, and its bytes are compared with what
// they should be: the lines nobody touched come back byte for byte. A character the
// file's encoding cannot hold is not written quietly as something else; the editor
// asks whether to save as UTF-8. Search shows such a line as its text, and replace
// in files keeps each file's encoding. And what HEAD holds is read the same way as
// what the editor holds, so a committed é is not a change.
//
// Run: node scripts/verify-encoding.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { watchPageErrors } from './harness.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('encoding')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-encoding-'))
const at = (name) => path.join(work, name)
const bytes = (name) => fs.readFileSync(at(name))
const CRLF = [0x0d, 0x0a]
// Windows-1252: é is 0xE9, € is 0x80. Neither is valid UTF-8 on its own.
const legacy = Buffer.from([
  ...Buffer.from('[settings]'), ...CRLF,
  ...Buffer.from('name=caf'), 0xe9, ...CRLF,
  ...Buffer.from('price='), 0x80, 0x35, ...CRLF
])
fs.writeFileSync(at('legacy.ini'), legacy)
fs.writeFileSync(at('legacy2.ini'), Buffer.from([...Buffer.from('drink=caf'), 0xe9, ...CRLF]))
// UTF-16 LE with its mark, the way PowerShell 5.1 writes redirected output.
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
fs.writeFileSync(at('out.txt'), utf16('Get-ChildItem > out.txt\r\ndrink café 日本\r\n'))
fs.writeFileSync(at('plain.ts'), 'export const drink = "café"\n', 'utf8')
// A committed Windows-1252 file, for the gutters: HEAD has to be read the same way
// as the buffer, or every line with an é in it is reported as a change.
fs.writeFileSync(
  at('committed.ini'),
  Buffer.from([...Buffer.from('[menu]'), ...CRLF, ...Buffer.from('name=caf'), 0xe9, ...CRLF])
)
// And a committed UTF-8 file with a byte-order mark: the editor takes the mark off
// the text and keeps it in the encoding, so HEAD has to have it taken off too.
fs.writeFileSync(
  at('marked.ts'),
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export const x = 1\r\n')])
)
const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', windowsHide: true })
git('init', '-q', '-b', 'main')
git('add', 'committed.ini', 'marked.ts')
git('-c', 'user.email=ember@example.com', '-c', 'user.name=Ember', 'commit', '-qm', 'committed')

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, work],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await placeTopRight(app)
page.on('dialog', (d) => void d.accept())
await page.waitForSelector('.pane[data-integration]', { timeout: 40_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const open = async (name) => {
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.qp__box', { timeout: 10_000 })
  await page.locator('.qp__box').fill(name)
  await sleep(700)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.pane.editor .monaco-editor', { timeout: 20_000 })
  await sleep(1500)
}
const shown = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pane.editor .view-line')]
      .map((l) => (l.textContent ?? '').replaceAll(String.fromCharCode(160), ' '))
      .join('\n')
  )
const chip = () =>
  page.evaluate(() => document.querySelector('[data-status="encoding"]')?.textContent?.trim() ?? null)
const dirty = () => page.locator('.pane.editor[data-dirty="true"]').count()
const notice = () =>
  page.evaluate(
    () => document.querySelector('.notice__text')?.textContent?.replace(/\s+/g, ' ').trim() ?? null
  )
// The gutter marks on one file, as Monaco holds them.
const marksIn = (name) =>
  page.evaluate((file) => {
    const model = window.monaco?.editor.getModels().find((m) => m.uri.path.includes(file))
    if (!model) return null
    return model
      .getAllDecorations()
      .map((d) => ({
        cls: d.options.linesDecorationsClassName ?? '',
        line: d.range.startLineNumber
      }))
      .filter((d) => d.cls.startsWith('gutter-'))
  }, name)

// --- Windows-1252 opens as what it says -----------------------------------------------
await open('legacy.ini')
const legacyShown = await shown()
check(
  'a Windows-1252 file shows its é and its €',
  legacyShown.includes('café') && legacyShown.includes('€5'),
  legacyShown
)
check('with no replacement characters', !legacyShown.includes('�'), legacyShown)
check('and is not marked unsaved', (await dirty()) === 0)
check('the bar says which encoding it is', /Windows-1252/.test(String(await chip())), String(await chip()))

// --- editing one line leaves every other byte alone --------------------------------------
await page.locator('.pane.editor .view-lines').click()
await page.keyboard.press('Control+Home')
await page.keyboard.press('Shift+End')
await page.keyboard.type('; edited', { delay: 6 })
await page.keyboard.press('Control+S')
await sleep(1500)
const expectedLegacy = Buffer.concat([Buffer.from('; edited'), legacy.subarray('[settings]'.length)])
check(
  'saving an edit to one line changes that line only',
  bytes('legacy.ini').equals(expectedLegacy),
  bytes('legacy.ini').toString('hex')
)

// --- a character the encoding cannot hold is asked about -------------------------------------
await page.keyboard.press('Control+End')
await page.keyboard.type('city=東京', { delay: 6 })
const beforeAsk = bytes('legacy.ini')
await page.keyboard.press('Control+S')
await sleep(1500)
const asked = await notice()
check(
  'a character Windows-1252 cannot store stops the save and asks',
  /Windows-1252/.test(asked ?? '') && /UTF-8/.test(asked ?? ''),
  String(asked)
)
check(
  'and nothing is written in the meantime',
  bytes('legacy.ini').equals(beforeAsk),
  bytes('legacy.ini').toString('hex').slice(-40)
)
const asUtf8 = page.locator('.notice button', { hasText: /UTF-8/ })
if ((await asUtf8.count()) > 0) {
  await asUtf8.click()
  await sleep(1500)
  const now = bytes('legacy.ini')
  let decoded = null
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(now)
  } catch {
    decoded = null
  }
  check('Save as UTF-8 writes UTF-8', decoded !== null, now.toString('hex').slice(0, 60))
  check(
    'holding everything, the é and € and the new line',
    (decoded ?? '').includes('café') && (decoded ?? '').includes('€5') && (decoded ?? '').includes('東京'),
    JSON.stringify(decoded)
  )
  check('and the bar stops mentioning an encoding', (await chip()) === null, String(await chip()))
} else {
  check('the notice offers to save as UTF-8', false, String(asked))
}

// --- UTF-16, which used to be called binary ----------------------------------------------------
await open('out.txt')
const outShown = await shown()
check(
  'a UTF-16 file opens',
  outShown.includes('Get-ChildItem') && outShown.includes('drink café 日本'),
  outShown
)
check('and says so', /UTF-16 LE/.test(String(await chip())), String(await chip()))
await page.locator('.pane.editor .view-lines').click()
await page.keyboard.press('Control+End')
await page.keyboard.type('added line', { delay: 6 })
await page.keyboard.press('Control+S')
await sleep(1500)
const out = bytes('out.txt')
check('saving it keeps UTF-16 and its mark', out[0] === 0xff && out[1] === 0xfe, out.subarray(0, 4).toString('hex'))
check(
  'with the edit and everything else',
  out.subarray(2).toString('utf16le') === 'Get-ChildItem > out.txt\r\ndrink café 日本\r\nadded line',
  JSON.stringify(out.subarray(2).toString('utf16le'))
)

// --- search shows such a line, and replace keeps each file's encoding -----------------------------
await page.keyboard.press('Control+Shift+F')
await sleep(800)
await page.locator('.find__box').first().fill('drink')
await sleep(2500)
const previews = await page.$$eval('.find__preview', (els) => els.map((e) => e.textContent ?? ''))
check(
  'a line that is not UTF-8 is shown in the results as its text',
  previews.some((p) => p.includes('drink=café')),
  JSON.stringify(previews)
)
await page.locator('.find__box').nth(1).fill('order')
await page.locator('.find__replace').first().click()
await sleep(2500)
const legacy2 = bytes('legacy2.ini')
check(
  'a Windows-1252 file is replaced in, and keeps its é as one byte',
  legacy2.equals(Buffer.from([...Buffer.from('order=caf'), 0xe9, ...CRLF])),
  legacy2.toString('hex')
)
const out2 = bytes('out.txt')
check(
  'a UTF-16 file is replaced in, and stays UTF-16',
  out2[0] === 0xff && out2[1] === 0xfe && out2.subarray(2).toString('utf16le').includes('order café 日本'),
  out2.subarray(0, 24).toString('hex')
)
check(
  'and a UTF-8 file as before',
  fs.readFileSync(at('plain.ts'), 'utf8') === 'export const order = "café"\n',
  fs.readFileSync(at('plain.ts'), 'utf8')
)

// --- and the gutters compare like with like -------------------------------------------------------
await page.keyboard.press('Escape')
await open('committed.ini')
await sleep(2500)
const clean = await marksIn('committed.ini')
check(
  'a committed Windows-1252 file is not marked changed against HEAD',
  Array.isArray(clean) && clean.length === 0,
  JSON.stringify(clean)
)
await page.locator('.pane.editor .view-lines').click()
await page.keyboard.press('Control+End')
await page.keyboard.type('price=2', { delay: 6 })
await sleep(1800)
const touched = await marksIn('committed.ini')
check('while an edit to it is', (touched?.length ?? 0) >= 1, JSON.stringify(touched))
await page.keyboard.press('Control+Z')
await sleep(800)

await open('marked.ts')
await sleep(2500)
const marked = await marksIn('marked.ts')
check(
  'and a committed file with a byte-order mark is not marked changed either',
  Array.isArray(marked) && marked.length === 0,
  JSON.stringify(marked)
)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('text encodings in the editor:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
