import { useEffect, useRef, type RefObject } from 'react'

const TABBABLE = 'input, select, textarea, button, a[href], [tabindex]'

/**
 * A modal's two keyboard duties: Tab stays inside it, and closing it gives focus
 * back.
 *
 * Tab walked out of the palette into the page behind it — every row was a button
 * in the tab order, so a few presses left the overlay entirely while it was still
 * drawn over everything — and closing it only set state, so focus fell to the
 * document body and the next keystroke went nowhere. Whatever had focus when the
 * dialog opened gets it back, unless something else has taken it by then: a pick
 * that opens a file or runs a command focuses where it means to, and the editor
 * that mounts afterwards still wins.
 *
 * Not back into a terminal that is idle. Its input is a textarea in a box of height
 * zero, and focus there is invisible typing that runs on Enter — the thing the
 * composer's Escape and Shift+Tab were changed to stop doing.
 */
export function useDialog(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void
): void {
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    if (!open) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = ref.current

    const onKeyDown = (e: KeyboardEvent): void => {
      /*
       * Escape closes from anywhere inside, not only from the search box.
       *
       * Keeping Tab inside is what made this necessary: history search's filters are
       * stops now, and Escape was handled by the input alone — so once Tab had
       * reached a filter, the dialog could not be closed from the keyboard at all.
       * Stopped here so it is handled once, rather than again by the input's own
       * handler below.
       */
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close.current()
        return
      }
      if (e.key !== 'Tab' || !root) return
      const stops = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
        (el) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.offsetParent !== null
      )
      e.preventDefault()
      if (stops.length === 0) return
      const at = stops.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey
        ? at <= 0
          ? stops.length - 1
          : at - 1
        : at === -1 || at === stops.length - 1
          ? 0
          : at + 1
      stops[next].focus()
    }
    root?.addEventListener('keydown', onKeyDown)

    return () => {
      root?.removeEventListener('keydown', onKeyDown)
      const now = document.activeElement
      const lost = now === null || now === document.body || (root !== null && root.contains(now))
      if (!lost || !before?.isConnected) return
      if (before.closest('.live--idle')) return
      before.focus()
    }
  }, [ref, open])
}
