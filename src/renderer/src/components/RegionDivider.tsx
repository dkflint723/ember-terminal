import { useStore } from '../state/store'

/**
 * The drag handle between a region and the middle of the window.
 *
 * Separate from the divider inside a split view: that one moves a boundary between
 * two panes in the same tree and stores its sizes on the tab, while this one moves
 * the edge of a whole region and stores a fraction of the window. Sharing the code
 * would mean one of them carrying the other's arguments everywhere.
 */
interface Props {
  region: 'panel' | 'secondary'
}

export function RegionDivider({ region }: Props): React.JSX.Element {
  const setRegionSize = useStore((s) => s.setRegionSize)
  const vertical = region === 'secondary'

  const onDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const workspace = (e.currentTarget as HTMLElement).closest('.workspace')
    if (!workspace) return
    const box = workspace.getBoundingClientRect()
    const target = e.currentTarget as HTMLElement
    target.classList.add('divider--dragging')

    const onMove = (ev: MouseEvent): void => {
      // Measured from the edge the region is attached to, so the handle stays
      // under the pointer rather than drifting as the region resizes.
      const fraction = vertical
        ? (box.right - ev.clientX) / box.width
        : (box.bottom - ev.clientY) / box.height
      setRegionSize(region === 'panel' ? 'panel' : 'secondary', fraction)
    }

    const onUp = (): void => {
      target.classList.remove('divider--dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`divider region-divider region-divider--${region}`}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={region === 'panel' ? 'Resize the panel' : 'Resize the Claude sidebar'}
      onMouseDown={onDown}
    />
  )
}
