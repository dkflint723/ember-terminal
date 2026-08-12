import type { ITheme } from '@xterm/xterm'

/**
 * Deliberately close to the Windows Terminal "One Half Dark"/Campbell family so
 * the app reads as a native terminal rather than a themed toy.
 */
export const emberTheme: ITheme = {
  background: '#0c0c0c',
  foreground: '#e6e6e6',
  cursor: '#ff9d5c',
  cursorAccent: '#0c0c0c',
  selectionBackground: '#3a4a63',
  selectionForeground: '#ffffff',

  black: '#0c0c0c',
  red: '#e05561',
  green: '#8cc265',
  yellow: '#d18f52',
  blue: '#4aa5f0',
  magenta: '#c162de',
  cyan: '#42b3c2',
  white: '#d6d6d6',

  brightBlack: '#6b6b6b',
  brightRed: '#ff616e',
  brightGreen: '#a5e075',
  brightYellow: '#f0a45d',
  brightBlue: '#4dc4ff',
  brightMagenta: '#de73ff',
  brightCyan: '#4cd1e0',
  brightWhite: '#ffffff'
}
