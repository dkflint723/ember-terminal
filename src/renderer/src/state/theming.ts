import { useStore } from './store'
import { applyTheme, variantOf } from '../terminal/theme'
import { allControllers } from '../terminal/controller'
import type { AppliedLook } from '@shared/types'

/**
 * Load a theme by id and push it everywhere it matters: CSS custom properties for
 * the chrome, and every live terminal's palette. Safe to call for a theme that no
 * longer exists — the main process substitutes the default.
 */
export async function activateTheme(id: string): Promise<void> {
  const theme = await window.ember.getTheme(id)
  if (!theme) return

  useStore.getState().setTheme(theme)
  paint()
}

/** Put the current theme, in the variant the window's glass calls for, everywhere. */
function paint(): void {
  const { theme, glass } = useStore.getState()
  applyTheme(theme, glass)
  const palette = variantOf(theme, glass).terminal
  for (const controller of allControllers()) controller.setPalette(palette, glass)
}

/**
 * What main did to this window's backdrop, taken as the word on whether the page is
 * glass.
 *
 * The attribute is what the stylesheet reads to tint the ground; the palette swap
 * is what keeps text readable on it. Both follow what main applied rather than
 * what the setting asked for, so a system that cannot draw Mica keeps a solid page
 * and the palette measured for one.
 */
export function takeLook(look: AppliedLook): void {
  const glass = look.applied !== 'none'
  document.documentElement.dataset.backdrop = look.applied
  if (useStore.getState().glass === glass) return
  useStore.getState().setGlass(glass)
  paint()
}

/** Re-read the themes folder, picking up files added since launch. */
export async function refreshThemeList(): Promise<void> {
  useStore.getState().setThemes(await window.ember.listThemes())
}
