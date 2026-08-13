// Scratch a11y probe: reduced motion, keyboard reachability, focus trap, ARIA.
// Run: node scripts/tmp-a11y-probe.mjs
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('a11y')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, '--force-prefers-reduced-motion'],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const out = (label, v) => console.log(`\n### ${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)

// ---------------------------------------------------------------- reduced motion
out('media query state', await page.evaluate(() => ({
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  forcedColors: window.matchMedia('(forced-colors: active)').matches
})))

// Run a command so a running block exists, then read the animation on it.
await page.click('.composer__input')
await page.keyboard.type('ping -n 4 127.0.0.1', { delay: 5 })
await page.keyboard.press('Enter')
await sleep(700)
out('animations while a command runs (reduced motion forced ON)', await page.evaluate(() => {
  const res = []
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (cs.animationName && cs.animationName !== 'none') {
      res.push({
        cls: el.className?.toString().slice(0, 60),
        name: cs.animationName,
        duration: cs.animationDuration,
        iteration: cs.animationIterationCount
      })
    }
  }
  return res
}))
// Also: is there any @media (prefers-reduced-motion) rule at all in the stylesheet?
out('prefers-reduced-motion rules present in CSSOM', await page.evaluate(() => {
  let n = 0
  const walk = (rules) => {
    for (const r of rules) {
      if (r.conditionText && /reduced-motion/.test(r.conditionText)) n++
      if (r.cssRules) walk(r.cssRules)
    }
  }
  for (const s of document.styleSheets) { try { walk(s.cssRules) } catch {} }
  return n
}))

await sleep(4000) // let the block finish

// ------------------------------------------------------- block action reachability
out('block action buttons: computed display / focusability', await page.evaluate(() => {
  const head = document.querySelector('.block__head')
  const actions = document.querySelector('.block__actions')
  const btns = [...document.querySelectorAll('.block__action')]
  const focusables = (root) =>
    [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]')]
      .filter((el) => {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') return false
        if (el.disabled) return false
        return el.offsetParent !== null || cs.position === 'fixed'
      }).length
  return {
    headTag: head?.tagName,
    headTabIndex: head?.tabIndex,
    actionsDisplay: actions ? getComputedStyle(actions).display : null,
    actionButtonCount: btns.length,
    firstActionRect: btns[0]?.getBoundingClientRect().toJSON(),
    focusableInsideBlock: focusables(document.querySelector('.block'))
  }
}))

// Try to actually focus the copy button by keyboard
const focusResult = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.block__action')].find((b) => b.title === 'Copy command')
  if (!btn) return 'no button found'
  btn.focus()
  return {
    activeIsButton: document.activeElement === btn,
    display: getComputedStyle(btn.parentElement).display,
    activeElement: document.activeElement?.className?.toString()
  }
})
out('programmatic focus() on .block__action[title="Copy command"]', focusResult)

// ------------------------------------------------------- terminal tab strip keyboard
out('terminal tab strip semantics', await page.evaluate(() => {
  const strip = document.querySelector('.titlebar__tabs')
  const tab = document.querySelector('.tab')
  const close = document.querySelector('.tab__close')
  return {
    stripRole: strip?.getAttribute('role'),
    tabTag: tab?.tagName,
    tabRole: tab?.getAttribute('role'),
    tabTabIndex: tab?.tabIndex,
    tabAriaSelected: tab?.getAttribute('aria-selected'),
    closeTag: close?.tagName,
    closeAccessibleName: close?.getAttribute('aria-label') ?? close?.title ?? '(none)'
  }
}))

// Does keyboard-activating the close button close the tab? (it is bound to onMouseDown)
await page.evaluate(() => {
  const s = window.__emberStore
  return null
})
const tabsBefore = await page.locator('.tab').count()
await page.evaluate(() => document.querySelector('.tab__close')?.focus())
await page.keyboard.press('Enter')
await sleep(500)
const tabsAfterEnter = await page.locator('.tab').count()
await page.keyboard.press('Space')
await sleep(500)
const tabsAfterSpace = await page.locator('.tab').count()
out('close-tab button via keyboard', { tabsBefore, tabsAfterEnter, tabsAfterSpace })

// ------------------------------------------------------------------- caption buttons
out('window caption buttons accessible names', await page.evaluate(() =>
  [...document.querySelectorAll('.caption-btn')].map((b) => ({
    text: b.textContent,
    ariaLabel: b.getAttribute('aria-label'),
    title: b.title || null
  }))
))

// -------------------------------------------------------------------- settings modal
await page.click('.activity__item[data-view="settings"]')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(400)
out('settings modal ARIA', await page.evaluate(() => {
  const m = document.querySelector('.modal')
  const scrim = document.querySelector('.modal-scrim')
  return {
    modalRole: m?.getAttribute('role'),
    ariaModal: m?.getAttribute('aria-modal'),
    ariaLabelledby: m?.getAttribute('aria-labelledby'),
    scrimRole: scrim?.getAttribute('role'),
    activeElementOnOpen: document.activeElement?.tagName + '.' + (document.activeElement?.className || ''),
    activeInsideModal: !!m && m.contains(document.activeElement)
  }
}))

// Tab through and see whether focus ever leaves the modal.
const trail = []
for (let i = 0; i < 32; i++) {
  await page.keyboard.press('Tab')
  const info = await page.evaluate(() => {
    const el = document.activeElement
    const modal = document.querySelector('.modal')
    return {
      tag: el?.tagName,
      cls: (el?.className || '').toString().slice(0, 44),
      label: (el?.getAttribute?.('aria-label') || el?.title || el?.textContent || '').toString().trim().slice(0, 30),
      inModal: !!modal && modal.contains(el)
    }
  })
  trail.push(info)
}
out('focus trail: 32 Tab presses with settings open', trail)
out('escaped the modal?', trail.some((t) => !t.inModal))

await page.keyboard.press('Escape')
await sleep(400)

// ---------------------------------------------------------------- tree/list ARIA
await page.evaluate(() => window.ember && null)
await page.keyboard.press('Control+b')
await sleep(1500)
out('file tree semantics', await page.evaluate(() => {
  const tree = document.querySelector('.tree__body')
  const row = document.querySelector('.tree__row')
  return {
    treeRole: tree?.getAttribute('role'),
    treeContainerRole: document.querySelector('.tree')?.getAttribute('role'),
    rowTag: row?.tagName,
    rowRole: row?.getAttribute('role'),
    rowAriaExpanded: row?.getAttribute('aria-expanded'),
    rowAriaLevel: row?.getAttribute('aria-level'),
    rowCount: document.querySelectorAll('.tree__row').length,
    sidebarTitleTag: document.querySelector('.sidebar__title')?.tagName
  }
}))

// --------------------------------------------------------------- focus ring presence
out('focus ring on a tree row button', await page.evaluate(() => {
  const row = document.querySelector('.tree__row')
  if (!row) return 'no row'
  row.focus()
  const cs = getComputedStyle(row)
  return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow }
}))

// ------------------------------------------------------------- resolved theme vars
out('resolved CSS vars for the active theme', await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement)
  const names = ['bg', 'bg-chrome', 'bg-elevated', 'bg-block', 'border', 'border-strong', 'fg', 'fg-dim', 'fg-faint', 'accent', 'ok', 'fail', 'info-fg']
  return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue('--' + n).trim()]))
}))

out('computed colour of real small text', await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el)
    let bgEl = el, bg = 'rgba(0, 0, 0, 0)'
    while (bgEl && bg === 'rgba(0, 0, 0, 0)') { bg = getComputedStyle(bgEl).backgroundColor; bgEl = bgEl.parentElement }
    return { sel, text: (el.textContent || '').trim().slice(0, 24), color: cs.color, bg, size: cs.fontSize, weight: cs.fontWeight }
  }
  return ['.block__meta', '.composer__cwd', '.composer__hint', '.tree__root', '.sidebar__title', '.tree__twisty', 'kbd'].map(pick)
}))

await app.close()
profile.cleanup()
