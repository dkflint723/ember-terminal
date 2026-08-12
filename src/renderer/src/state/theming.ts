import { useStore } from './store'
import { applyTheme } from '../terminal/theme'
import { allControllers } from '../terminal/controller'

/**
 * Load a theme by id and push it everywhere it matters: CSS custom properties for
 * the chrome, and every live terminal's palette. Safe to call for a theme that no
 * longer exists — the main process substitutes the default.
 */
export async function activateTheme(id: string): Promise<void> {
  const theme = await window.ember.getTheme(id)
  if (!theme) return

  applyTheme(theme)
  useStore.getState().setTheme(theme)
  for (const controller of allControllers()) controller.setPalette(theme.terminal)
}

/** Re-read the themes folder, picking up files added since launch. */
export async function refreshThemeList(): Promise<void> {
  useStore.getState().setThemes(await window.ember.listThemes())
}
