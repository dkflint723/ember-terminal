import type { ITheme } from '@xterm/xterm'
import { resolveTheme, type ResolvedTheme, type TerminalPalette } from '@shared/theme'

/**
 * Resolving an empty theme file yields the built-in dark defaults, so the app has
 * something correct to paint with before the real theme arrives over IPC — and
 * the defaults live in exactly one place.
 */
export const DEFAULT_THEME: ResolvedTheme = resolveTheme('ember-dark', {
  name: 'Ember Dark',
  type: 'dark'
})

export function toXtermTheme(palette: TerminalPalette): ITheme {
  return { ...palette }
}

/**
 * Themes are applied as CSS custom properties on the root element rather than by
 * swapping stylesheets, so every component restyles itself with no re-render.
 */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(theme.vars)) {
    root.style.setProperty(`--${name}`, value)
  }
  // Exposed for the rare rule that must branch on light vs dark.
  root.dataset.themeType = theme.type
  root.style.colorScheme = theme.type
}
