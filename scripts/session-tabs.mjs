// Switching sessions from a verification script, whichever mode the window is in.
//
// The tab strip left the title bar for the session list, and the list fills the
// side slot only while the window is a terminal — in the IDE that slot shows
// files. The mode-independent way to reach a session, for a person and for these
// scripts alike, is the title bar's search: its list opens with the sessions
// first, in the same order the strip used to keep them.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Switch to the nth session (0-based), through the global search. */
export async function pickTab(page, index) {
  await page.click('.titlebar__searchbox')
  await page.waitForSelector('.qp__box', { timeout: 10_000 })
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await sleep(1000)
}

/**
 * How many sessions are open, counted where a person can count them.
 *
 * The session cards when the list is on screen; through the search's list when it
 * is not — the entries whose detail reads `session` are exactly the open tabs.
 */
export async function tabCount(page) {
  const cards = await page.locator('.sessions__card').count()
  if (cards > 0) return cards
  await page.click('.titlebar__searchbox')
  await page.waitForSelector('.qp__box', { timeout: 10_000 })
  const n = await page.locator('.qp__item .qp__detail', { hasText: 'session' }).count()
  await page.keyboard.press('Escape')
  await sleep(400)
  return n
}
