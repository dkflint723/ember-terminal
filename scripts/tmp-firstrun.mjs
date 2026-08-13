// Scratch probe: first-run / empty-state walkthrough. Delete when done.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('firstrun')
const SHOT_DIR = path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(SHOT_DIR, `qa-firstrun-${name}.png`) })
}

console.log('profile dir:', profile.dir)

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`)
})

await page.waitForSelector('.app', { timeout: 40_000 })
await sleep(3000)
await shot(page, '01-launch')

const snap = async (label) =>
  page.evaluate(() => ({
    treeRoot: window.__store?.getState?.().treeRoot ?? null,
    sidebarOpen: document.querySelector('.sidebar') !== null,
    bodyText: (document.querySelector('.app')?.innerText ?? '').slice(0, 1500)
  }))

// The store isn't exposed; read what we can from the DOM instead.
const readDom = () =>
  page.evaluate(() => ({
    sidebar: document.querySelector('.sidebar')
      ? {
          view: document.querySelector('.sidebar').dataset.view,
          title: document.querySelector('.sidebar__title')?.textContent,
          text: document.querySelector('.sidebar').innerText
        }
      : null,
    treeRootLabel: document.querySelector('.tree__root')?.textContent ?? null,
    treeRootTitle: document.querySelector('.tree__root')?.getAttribute('title') ?? null,
    activity: Array.from(document.querySelectorAll('.activity__item')).map((b) => ({
      view: b.dataset.view,
      selected: b.getAttribute('aria-selected'),
      badge: b.querySelector('.activity__badge')?.textContent ?? null
    })),
    tabs: Array.from(document.querySelectorAll('.tab')).map((t) => t.innerText),
    panes: Array.from(document.querySelectorAll('.pane')).map((p) => ({
      integration: p.dataset.integration ?? null
    }))
  }))

console.log('=== after launch ===')
console.log(JSON.stringify(await readDom(), null, 2))

const views = ['explorer', 'search', 'scm', 'github', 'problems']
for (const view of views) {
  await page.click(`.activity__item[data-view="${view}"]`)
  await sleep(1200)
  const dom = await readDom()
  console.log(`=== view ${view} ===`)
  console.log(JSON.stringify(dom.sidebar, null, 2))
  console.log('root label:', dom.treeRootLabel, '|', dom.treeRootTitle)
  await shot(page, `02-${view}`)
  // Report enabled/disabled controls in the sidebar.
  const controls = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.sidebar button, .sidebar input, .sidebar textarea')).map(
      (el) => ({
        tag: el.tagName,
        cls: el.className,
        title: el.getAttribute('title'),
        text: (el.textContent ?? '').trim().slice(0, 30),
        placeholder: el.getAttribute('placeholder'),
        disabled: el.disabled === true
      })
    )
  )
  console.log('controls:', JSON.stringify(controls))
}

await app.close()
profile.cleanup()
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 10))
