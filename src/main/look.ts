import type { BrowserWindow } from 'electron'
import { release } from 'node:os'
import type { AppliedLook, WindowBackdrop } from '../shared/types.js'

/**
 * What a window is painted with, from outside the page: the Windows 11 backdrop
 * material behind it, and its opacity.
 *
 * Kept apart from main/index.ts because it is asked from three places — a window
 * being made, a save from any window, and the Settings dialog previewing in one —
 * and all three have to agree on what "applied" means for the check that reads it
 * back.
 */

/** The window's colour before the page paints, and whenever no material is drawn. */
export const SOLID_BACKGROUND = '#0c0c0c'

const MATERIALS: readonly WindowBackdrop[] = ['none', 'mica', 'acrylic', 'tabbed']

/**
 * Whether this system can draw a backdrop material at all.
 *
 * DWM's system backdrop arrived in Windows 11 22H2, build 22621. Electron quietly
 * ignores the request anywhere older, which is exactly the problem: the window is
 * then transparent with nothing drawn behind it, and a page tinted for glass is
 * drawn over black. So support is decided here, once, and a window on a system
 * without it is made solid and told to use the solid palette.
 */
export function backdropSupported(): boolean {
  if (process.platform !== 'win32') return false
  // For scripts/verify-look.mjs: the solid path, on a machine that could draw Mica.
  if (process.env.EMBER_BACKDROP === 'unsupported') return false
  const build = Number(release().split('.')[2])
  return Number.isFinite(build) && build >= 22621
}

const SUPPORTED = backdropSupported()

const looks = new WeakMap<BrowserWindow, AppliedLook>()

const materialOf = (backdrop: unknown): WindowBackdrop =>
  MATERIALS.includes(backdrop as WindowBackdrop) ? (backdrop as WindowBackdrop) : 'none'

const opacityOf = (opacity: unknown): number =>
  typeof opacity === 'number' && Number.isFinite(opacity) ? Math.min(Math.max(opacity, 0.6), 1) : 1

/**
 * The constructor's share: a window that is going to have a material has to be
 * made with a transparent background, or the first frames are a solid block that
 * the material then appears behind.
 */
export function constructionLook(backdrop: unknown, opacity: unknown): {
  backgroundColor: string
  backgroundMaterial?: Exclude<WindowBackdrop, 'none'>
  opacity: number
} {
  const material = SUPPORTED ? materialOf(backdrop) : 'none'
  return material === 'none'
    ? { backgroundColor: SOLID_BACKGROUND, opacity: opacityOf(opacity) }
    : { backgroundColor: '#00000000', backgroundMaterial: material, opacity: opacityOf(opacity) }
}

/**
 * Put a material and an opacity on a window, now.
 *
 * The background colour moves with the material: transparent while one is drawn,
 * so it shows, and solid again the moment it is not — a transparent window with no
 * material is black behind the page. Order matters for the same reason: the colour
 * clears before a material goes on, and returns only after it has come off.
 */
export function applyLook(win: BrowserWindow, backdrop: unknown, opacity: unknown): AppliedLook {
  const requested = materialOf(backdrop)
  const look: AppliedLook = {
    requested,
    applied: SUPPORTED ? requested : 'none',
    opacity: opacityOf(opacity),
    supported: SUPPORTED
  }
  if (win.isDestroyed()) return look
  try {
    if (look.applied === 'none') {
      if (SUPPORTED) win.setBackgroundMaterial('none')
      win.setBackgroundColor(SOLID_BACKGROUND)
    } else {
      win.setBackgroundColor('#00000000')
      win.setBackgroundMaterial(look.applied)
    }
  } catch (err) {
    // Refused: solid, and said, rather than a transparent window with nothing behind it.
    look.error = err instanceof Error ? err.message : String(err)
    look.applied = 'none'
    try {
      win.setBackgroundColor(SOLID_BACKGROUND)
    } catch {
      // The window is going away.
    }
  }
  win.setOpacity(look.opacity)
  looks.set(win, look)
  return look
}

/** What a window was last given — or, for one never given anything, what it has. */
export function lookOf(win: BrowserWindow | null): AppliedLook {
  return (
    (win && looks.get(win)) ?? { requested: 'none', applied: 'none', opacity: 1, supported: SUPPORTED }
  )
}
