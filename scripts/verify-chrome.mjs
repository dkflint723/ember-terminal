// The chrome catches the light.
//
// The window's ground runs light at the ceiling and dark at the floor. That only
// reads as a light source if the things standing on it agree with it — so the
// objects a person presses are lit from above, and the things that are not
// pressable are not lit at all. Depth is the affordance here, which is why it is
// worth checking rather than admiring: a treatment that drifts onto a label, or
// falls off a control, is the app telling somebody the wrong thing about what they
// can click.
//
// Three surfaces, each of which had the same defect in a different form.
//
// The status chips were a flat wash with an outline, sitting at the very foot of
// the window where the ground is deepest — the one place a missing light source is
// most obvious. Beside them the language label carried a comment reading "a label
// with nothing behind it stays plain rather than pretending to be pressable" above
// six declarations that gave it, byte for byte, the chrome of the eight things next
// to it that ARE pressable.
//
// The session card you were working in was `background: var(--bg-hover)` and so was
// a card the pointer happened to be crossing. Identical fills, one hairline of
// neutral grey between them — and since `:hover` is a class plus a pseudo-class and
// `--on` was a bare class, hover outranked it, so while the pointer was on the
// active card there was no difference at all.
//
// And the two session dots were one seven-pixel circle in two colours. The
// breathing was carrying the difference, except the blanket reduced-motion clamp
// caps every animation to 0.01ms — so for anybody who asked their system to stop
// moving things, hue was the whole signal. This build ships three
// colour-vision-deficiency-safe themes precisely so that hue never has to be.
//
// Read from computed style rather than from the stylesheet, because every one of
// these was a rule that existed and did not win.
//
// Run: node scripts/verify-chrome.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('chrome')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// A small project, so quick open answers immediately rather than indexing a repo.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-chrome-'))
fs.writeFileSync(path.join(work, 'alpha.ts'), 'export const a = 1\n')
fs.writeFileSync(path.join(work, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n')

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 45_000 })
await sleep(2500)

const run = async (command, settle = 2200) => {
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
  await sleep(settle)
}

/** Everything about how an element is painted, as the engine resolved it. */
const paintOf = (selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const c = getComputedStyle(el)
    return {
      image: c.backgroundImage,
      colour: c.backgroundColor,
      shadow: c.boxShadow,
      borderWidth: c.borderTopWidth,
      radius: c.borderRadius
    }
  }, selector)

/*
 * How many colour stops a gradient actually names.
 *
 * A `linear-gradient` with one stop is a flat fill spelled the long way, and it
 * would satisfy any check that only asked whether a gradient was present. What
 * makes an object look lit is that its two ends differ, so that is what is counted.
 */
const stops = (image) => (image?.match(/(rgba?|color)\(/g) ?? []).length

await run('echo chrome-one')
await run('Get-ChildItem | Select-Object -First 2 Name')

// --- the chips are raised, because they are things you press --------------------
const chip = await paintOf('.statusbar__item')
check('there is a status chip to look at', chip !== null, String(chip))
if (chip) {
  check('a status chip is lit from above', /linear-gradient/.test(chip.image), chip.image.slice(0, 80))
  check(
    'with two ends rather than one flat colour spelled long',
    stops(chip.image) >= 2,
    `${stops(chip.image)} stops in ${chip.image.slice(0, 80)}`
  )
  check('catching light along its top edge', chip.shadow.includes('inset'), chip.shadow.slice(0, 90))
  /*
   * And casting a line under itself. `inset` appears in the rim as well, so the
   * cast edge is looked for as a shadow that is NOT inset — otherwise the rim
   * alone would satisfy both halves and the object would be lit from above with
   * nothing beneath it.
   */
  check(
    'and settling onto the ground beneath it',
    chip.shadow.split(',').some((part) => !part.includes('inset')),
    chip.shadow.slice(0, 120)
  )
}

// --- and the thing that is not a control is not ---------------------------------
await page.keyboard.press('Control+P')
await sleep(800)
await page.keyboard.type('alpha.ts', { delay: 25 })
await page.waitForFunction(() => document.querySelectorAll('.qp__label').length > 0, {
  timeout: 25_000
})
await sleep(400)
await page.keyboard.press('Enter')
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
await sleep(2500)

const label = await paintOf('.statusbar__label')
check('the language label is on screen', label !== null, String(label))
if (label) {
  check('the label wears no panel', label.image === 'none', label.image.slice(0, 80))
  check('and no frame', parseFloat(label.borderWidth) === 0, label.borderWidth)
  check(
    'and nothing behind it',
    label.colour === 'rgba(0, 0, 0, 0)',
    label.colour
  )
}
// The chip is still a chip with a file open — the two readings are of one bar.
const chipWithFile = await paintOf('.statusbar__item')
check(
  'while the chips beside it are still panels',
  chipWithFile !== null && /linear-gradient/.test(chipWithFile.image),
  chipWithFile?.image.slice(0, 80)
)

// --- which session you are in, said in more than one channel --------------------
await page.keyboard.press('Control+Shift+I')
await sleep(1500)
await page.keyboard.press('Control+Shift+T')
await sleep(3500)
await page.waitForSelector('.sessions__card', { timeout: 20_000 })

const cardCount = await page.locator('.sessions__card').count()
check('there are two sessions to tell apart', cardCount >= 2, `${cardCount} cards`)

if (cardCount >= 2) {
  /*
   * The pointer goes on the card that is NOT active, which is the comparison that
   * matters: at rest the two differed by a hairline, and under the pointer they
   * were identical because `:hover` outranked the active class outright.
   */
  const active = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.sessions__card')]
    const on = cards.findIndex((c) => c.classList.contains('sessions__card--on'))
    return on
  })
  const other = active === 0 ? 1 : 0
  await page.locator('.sessions__card').nth(other).hover()
  await sleep(600)

  const both = await page.evaluate(
    ({ on, off }) => {
      const cards = [...document.querySelectorAll('.sessions__card')]
      const read = (el) => {
        const c = getComputedStyle(el)
        return { image: c.backgroundImage, colour: c.backgroundColor, shadow: c.boxShadow }
      }
      return { on: read(cards[on]), hovered: read(cards[off]) }
    },
    { on: active, off: other }
  )

  check(
    'the session you are in is a lit surface',
    /linear-gradient/.test(both.on.image),
    both.on.image.slice(0, 80)
  )
  check(
    'and carries the accent edge this app uses for active',
    both.on.shadow.includes('inset'),
    both.on.shadow.slice(0, 100)
  )
  check(
    'a hovered card is not mistaken for it',
    both.on.image !== both.hovered.image && both.on.shadow !== both.hovered.shadow,
    JSON.stringify(both)
  )
  /*
   * And they differ somewhere other than in colour. Two fills of different hue
   * would satisfy every clause above while leaving somebody with a colour vision
   * deficiency exactly where they started.
   */
  check(
    'in a way that is not only colour',
    both.hovered.image === 'none' && both.on.shadow !== 'none' && both.hovered.shadow === 'none',
    JSON.stringify({ on: both.on.shadow, hovered: both.hovered.shadow })
  )
}

// --- a running session and a failed one are different shapes --------------------
/*
 * Both dots only exist on a card that is NOT in front — the active session shows
 * what it is doing as blocks — so each state is made in one session and read from
 * the other.
 */
const selectCard = async (index) => {
  await page.locator('.sessions__card').nth(index).click()
  await sleep(1500)
}

const dotOf = (modifier) =>
  page.evaluate((mod) => {
    const el = document.querySelector(`.sessions__dot--${mod}`)
    if (!el) return null
    const c = getComputedStyle(el)
    return {
      radius: c.borderRadius,
      border: c.borderTopWidth,
      colour: c.backgroundColor
    }
  }, modifier)

await selectCard(0)
await run('Start-Sleep -Seconds 9', 900)
await selectCard(1)
await sleep(1200)

let running = await dotOf('running')
for (let i = 0; i < 12 && running === null; i += 1) {
  await sleep(400)
  running = await dotOf('running')
}
check('a session running something says so', running !== null, String(running))

// Let it finish, then give that session something that fails instead.
await sleep(9000)
await selectCard(0)
await run('Get-Item .\\definitely-not-here.txt', 3000)
await selectCard(1)
await sleep(1500)

let failed = await dotOf('failed')
for (let i = 0; i < 12 && failed === null; i += 1) {
  await sleep(400)
  failed = await dotOf('failed')
}
check('and a session whose last command failed says so too', failed !== null, String(failed))

if (running && failed) {
  check(
    'the two marks are different shapes, not one shape in two colours',
    running.radius !== failed.radius,
    JSON.stringify({ running: running.radius, failed: failed.radius })
  )
  check(
    'the running one is a ring rather than a disc',
    running.colour === 'rgba(0, 0, 0, 0)' && parseFloat(running.border) >= 2,
    JSON.stringify(running)
  )
}

/*
 * And it still holds for somebody who asked their system to stop moving things.
 *
 * This is the case the shapes are actually for: the blanket clamp further down the
 * stylesheet caps every animation to 0.01ms, so the breathing that used to
 * distinguish these two is simply absent here, and anything left in colour alone is
 * alone for good.
 */
await page.emulateMedia({ reducedMotion: 'reduce' })
await sleep(800)
const stillFailed = await dotOf('failed')
check(
  'the shapes survive reduced motion',
  stillFailed !== null && running !== null && stillFailed.radius !== running.radius,
  JSON.stringify({ failed: stillFailed, running })
)
await page.emulateMedia({ reducedMotion: null })

// --- and nothing is lit that is not an object -----------------------------------
/*
 * The block kept the drop shadow of the card it used to be: `Blocks stop being
 * cards` set `box-shadow: none`, and a far more specific dark-theme rule went on
 * winning. Against a flat pane it was invisible; against a ground it is a
 * twenty-six pixel smudge under every block in the list.
 */
await selectCard(0)
const block = await paintOf('.block')
check('there is a block to look at', block !== null, String(block))
if (block) {
  check('a block carries no elevation of its own', block.shadow === 'none', block.shadow.slice(0, 90))
}

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('chrome depth:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
