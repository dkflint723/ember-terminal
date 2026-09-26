import type { ITheme } from '@xterm/xterm'
import { resolveTheme, type ResolvedTheme, type TerminalPalette } from '@shared/theme'

/**
 * Resolving an empty theme file yields the built-in dark defaults, so the app has
 * something correct to paint with before the real theme arrives over IPC — and
 * the defaults live in exactly one place.
 */
export const DEFAULT_THEME: ResolvedTheme = resolveTheme('ember-deep', {
  name: 'Ember Dark',
  type: 'dark'
})

/**
 * The palette as xterm takes it.
 *
 * On glass the background keeps its colour and loses its alpha: xterm then draws
 * nothing under the text (with allowTransparency on, which both renderers honour —
 * the WebGL one clears its viewport to this colour, alpha included), so a running
 * command and a full-screen program sit on the same translucent ground as the
 * blocks, rather than on an opaque slab of the solid background. The ANSI colours
 * are the glass palette's, which were lifted for exactly that ground.
 */
export function toXtermTheme(palette: TerminalPalette, glass = false): ITheme {
  if (!glass || !/^#[0-9a-f]{6}$/i.test(palette.background)) return { ...palette }
  return { ...palette, background: `${palette.background}00` }
}

/** The half of a theme in use: its glass derivation while a backdrop is drawn. */
export function variantOf(theme: ResolvedTheme, glass: boolean): Pick<ResolvedTheme, 'vars' | 'terminal'> {
  return glass ? theme.glass : theme
}

/**
 * Themes are applied as CSS custom properties on the root element rather than by
 * swapping stylesheets, so every component restyles itself with no re-render.
 */
export function applyTheme(theme: ResolvedTheme, glass = false): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(variantOf(theme, glass).vars)) {
    root.style.setProperty(`--${name}`, value)
  }
  // Exposed for the rare rule that must branch on light vs dark.
  root.dataset.themeType = theme.type
  root.style.colorScheme = theme.type
}
