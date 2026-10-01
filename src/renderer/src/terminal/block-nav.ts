/**
 * Moving between blocks from the keyboard, and hearing one (audit R30).
 *
 * Blocks make terminal output into separate things — each command, its status, its
 * output — which a screen reader can move between in a way a plain terminal's
 * scrollback never allows. But the only way to reach one was Tab through every
 * control of every block in between. Now Alt+↑ and Alt+↓ go to the previous and next
 * block's heading, Alt+Shift+↑ to the last one that failed, and Alt+Shift+R reads
 * the output of the block in focus.
 *
 * The chords are not PSReadLine's, and they are declined where they would take a key
 * from something that wants it: a full-screen program, and the code editor.
 */

/** The terminal pane in front: the one holding focus, or else the given one. */
function paneElement(paneId: string | undefined): HTMLElement | null {
  const focused = document.activeElement?.closest<HTMLElement>('.pane[data-pane]')
  if (focused) return focused
  return paneId ? document.querySelector<HTMLElement>(`.pane[data-pane="${CSS.escape(paneId)}"]`) : null
}

/** Each block's heading, top to bottom. */
function headings(pane: HTMLElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>('.block[data-block-id] > .block__head')]
}

/** Whether these chords are ours here, or belong to what has the keyboard. */
export function blockNavApplies(): boolean {
  const active = document.activeElement
  if (active?.closest('.monaco-editor')) return false
  // A full-screen program owns the whole terminal, arrows and all.
  if (active?.closest('.pane[data-mode="raw"]')) return false
  return true
}

/**
 * Focus the next block's heading in `direction`, from the block in focus — or from
 * the end, when focus is in the composer. Only failed blocks, when asked. Says so
 * when there is nowhere to go, rather than doing nothing silently.
 */
export function moveBetweenBlocks(paneId: string | undefined, direction: -1 | 1, failedOnly = false): boolean {
  const pane = paneElement(paneId)
  if (!pane) return false
  const list = headings(pane)
  if (list.length === 0) {
    announce('There are no commands in this terminal yet.')
    return true
  }
  const at = list.findIndex((h) => h.closest('.block')?.contains(document.activeElement))
  let i = at === -1 ? (direction < 0 ? list.length : -1) : at
  for (i += direction; i >= 0 && i < list.length; i += direction) {
    const block = list[i].closest('.block')
    if (failedOnly && !block?.classList.contains('block--failed')) continue
    list[i].focus()
    list[i].scrollIntoView({ block: 'nearest' })
    return true
  }
  announce(failedOnly ? 'No earlier command failed.' : direction < 0 ? 'This is the first command.' : 'This is the last command.')
  return true
}

/** Read the output of the block in focus, through the live region. */
export function readFocusedBlock(): boolean {
  const block = document.activeElement?.closest<HTMLElement>('.block[data-block-id]')
  if (!block) {
    announce('Move to a command first, with Alt+Up.')
    return true
  }
  const body = block.querySelector('.block__body, .block__answer')
  const text = (body?.textContent ?? '').replace(/\s+\n/g, '\n').trim()
  // Long enough to be useful, short enough to stop: the rest is there to arrow through.
  announce(text ? (text.length > 2000 ? `${text.slice(0, 2000)} … and more.` : text) : 'This command printed nothing.')
  return true
}

let region: HTMLElement | null = null
let flip = false

/**
 * Said through a live region of its own, which lives for the window's life: a region
 * is only listened to once it exists. The text alternates a trailing space so the
 * same sentence twice is still a change, and is said twice.
 */
export function announce(text: string): void {
  if (!region) {
    region = document.createElement('div')
    region.className = 'sr-only'
    region.setAttribute('role', 'status')
    region.setAttribute('aria-live', 'polite')
    region.setAttribute('aria-atomic', 'true')
    region.dataset.blockNav = 'announcer'
    document.body.appendChild(region)
  }
  flip = !flip
  region.textContent = flip ? text : `${text} `
}
