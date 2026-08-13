// Scratch a11y probe #2: modal focus trap, tab strip keyboard, reduced motion via emulateMedia.
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('a11y2')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)
const out = (l, v) => console.log(`\n### ${l}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)

// ---- reduced motion, properly emulated -------------------------------------
await page.emulateMedia({ reducedMotion: 'reduce' })
out('emulated reduced motion active', await page.evaluate(() =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches))
await page.click('.composer__input')
await page.keyboard.type('ping -n 5 127.0.0.1', { delay: 5 })
await page.keyboard.press('Enter')
await sleep(800)
out('running animations WITH reduced-motion: reduce', await page.evaluate(() =>
  [...document.querySelectorAll('*')]
    .map((el) => ({ el, cs: getComputedStyle(el) }))
    .filter(({ cs }) => cs.animationName !== 'none')
    .map(({ el, cs }) => ({
      cls: el.className.toString().slice(0, 50),
      name: cs.animationName,
      dur: cs.animationDuration,
      iter: cs.animationIterationCount,
      rect: el.getBoundingClientRect().width + 'x' + el.getBoundingClientRect().height
    }))
))
await sleep(5000)

// ---- two tabs, then keyboard-close ----------------------------------------
await page.keyboard.press('Control+Shift+T')
await sleep(2500)
const before = await page.locator('.tab').count()
const canTabToTab = await page.evaluate(() => {
  // Is any .tab or .titlebar__tabs element in the sequential focus order?
  const els = [...document.querySelectorAll('.tab, .tab__label, .titlebar__tabs')]
  return els.map((e) => ({ cls: e.className, tabIndex: e.tabIndex, role: e.getAttribute('role') }))
})
out('tab strip focusability (2 tabs open)', { tabCount: before, els: canTabToTab })

await page.evaluate(() => document.querySelectorAll('.tab__close')[1]?.focus())
const focused = await page.evaluate(() => document.activeElement?.className)
await page.keyboard.press('Enter')
await sleep(600)
const afterEnter = await page.locator('.tab').count()
await page.keyboard.press('Space')
await sleep(600)
const afterSpace = await page.locator('.tab').count()
// now prove the mouse path works
await page.locator('.tab__close').nth(1).click()
await sleep(600)
const afterMouse = await page.locator('.tab').count()
out('close tab: keyboard vs mouse', { focused, before, afterEnter, afterSpace, afterMouse })

// ---- settings modal --------------------------------------------------------
await page.keyboard.press('Control+,')
await page.waitForSelector('.modal', { timeout: 15_000 })
await sleep(500)
out('modal ARIA + initial focus', await page.evaluate(() => {
  const m = document.querySelector('.modal')
  return {
    role: m?.getAttribute('role'),
    ariaModal: m?.getAttribute('aria-modal'),
    labelledby: m?.getAttribute('aria-labelledby'),
    activeElement: document.activeElement?.tagName + '.' + document.activeElement?.className,
    activeInsideModal: m?.contains(document.activeElement)
  }
}))

const trail = []
for (let i = 0; i < 40; i++) {
  await page.keyboard.press('Tab')
  trail.push(await page.evaluate(() => {
    const el = document.activeElement
    const m = document.querySelector('.modal')
    return {
      i: 0,
      tag: el?.tagName,
      cls: (el?.className || '').toString().slice(0, 40),
      txt: (el?.getAttribute?.('aria-label') || el?.title || el?.textContent || '').toString().trim().slice(0, 26),
      inModal: !!m && m.contains(el)
    }
  }))
}
trail.forEach((t, i) => (t.i = i + 1))
out('Tab trail with modal open', trail)
out('focus escaped the modal on presses', trail.map((t, i) => (t.inModal ? null : i + 1)).filter(Boolean))

// Can we still activate things behind the scrim while the modal is open?
const behind = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.activity__item')].find((b) => b.getAttribute('data-view') === 'search')
  if (!el) return 'not found'
  el.focus()
  return { focusedBehindScrim: document.activeElement === el, cls: document.activeElement?.className }
})
out('focus reachable on the activity rail behind the scrim', behind)

await page.keyboard.press('Escape')
await sleep(400)

// ---- tree ------------------------------------------------------------------
await page.keyboard.press('Control+b')
await sleep(2000)
out('tree semantics', await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.tree__row')]
  return {
    treeRole: document.querySelector('.tree')?.getAttribute('role'),
    bodyRole: document.querySelector('.tree__body')?.getAttribute('role'),
    rowCount: rows.length,
    firstRow: rows[0] && {
      tag: rows[0].tagName,
      role: rows[0].getAttribute('role'),
      ariaExpanded: rows[0].getAttribute('aria-expanded'),
      ariaLevel: rows[0].getAttribute('aria-level'),
      tabIndex: rows[0].tabIndex
    },
    everyRowIsATabStop: rows.every((r) => r.tabIndex === 0)
  }
}))

// Arrow keys in the tree?
await page.evaluate(() => document.querySelector('.tree__row')?.focus())
const t0 = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 30))
await page.keyboard.press('ArrowDown')
await sleep(300)
const t1 = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 30))
out('ArrowDown in tree moves focus?', { before: t0, after: t1, moved: t0 !== t1 })

// Context menu by keyboard?
await page.evaluate(() => document.querySelector('.tree__row')?.focus())
await page.keyboard.press('Shift+F10')
await sleep(400)
const menu1 = await page.locator('.menu').count()
await page.keyboard.press('ContextMenu')
await sleep(400)
const menu2 = await page.locator('.menu').count()
out('tree context menu via keyboard', { afterShiftF10: menu1, afterContextMenuKey: menu2 })

// ---- hidden-until-hover controls -------------------------------------------
out('controls hidden from the keyboard by display/visibility', await page.evaluate(() => {
  const probe = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return { sel, present: false }
    const cs = getComputedStyle(el)
    el.focus?.()
    return {
      sel, present: true, display: cs.display, visibility: cs.visibility,
      focusable: document.activeElement === el,
      rect: el.getBoundingClientRect().width + 'x' + el.getBoundingClientRect().height
    }
  }
  return ['.block__actions', '.block__action', '.etab__close', '.scm__actions', '.find__replace--file'].map(probe)
}))

// ---- focus ring ------------------------------------------------------------
out('focus indicator on interactive elements', await page.evaluate(() => {
  const probe = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return { sel, missing: true }
    el.focus()
    const cs = getComputedStyle(el)
    return { sel, outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, boxShadow: cs.boxShadow, focused: document.activeElement === el }
  }
  return ['.tree__row', '.activity__item', '.icon-btn', '.tab__close', '.caption-btn', '.composer__input'].map(probe)
}))

await app.close()
profile.cleanup()
