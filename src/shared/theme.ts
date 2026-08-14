/**
 * Theming built on the VS Code color-theme format.
 *
 * Adopting that schema rather than inventing one buys three things: the existing
 * ecosystem of community themes works here, the same file can later drive input
 * syntax highlighting via its `tokenColors`, and every colour in the UI is a
 * token rather than a literal.
 *
 * A theme names far more colours than a terminal needs, and most themes fill in
 * only part of the schema, so every token resolves through a fallback chain
 * ending in a built-in default for the theme's light/dark type.
 */

export interface TokenColor {
  scope?: string | string[]
  settings: { foreground?: string; fontStyle?: string; background?: string }
}

/** A theme file as authored, before fallbacks are applied. */
export interface ThemeFile {
  name?: string
  type?: 'dark' | 'light' | 'hcDark' | 'hcLight'
  /** Relative path to a theme this one extends, as VS Code's own themes do. */
  include?: string
  colors?: Record<string, string>
  tokenColors?: TokenColor[]
}

export interface ThemeSummary {
  id: string
  name: string
  type: 'dark' | 'light'
  builtin: boolean
}

/** xterm's ITheme, kept as plain strings so it can cross the IPC boundary. */
export interface TerminalPalette {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ResolvedTheme {
  id: string
  name: string
  type: 'dark' | 'light'
  /** CSS custom properties, without the leading `--`. */
  vars: Record<string, string>
  terminal: TerminalPalette
  tokenColors: TokenColor[]
}

/* ------------------------------------------------------------------ colours */

interface Rgb {
  r: number
  g: number
  b: number
}

function parseHex(value: string | undefined): Rgb | null {
  if (!value) return null
  const hex = value.trim().replace(/^#/, '')
  const expand = (s: string): string =>
    s.length === 3 || s.length === 4
      ? s
          .slice(0, 3)
          .split('')
          .map((c) => c + c)
          .join('')
      : s.slice(0, 6)
  if (!/^[0-9a-f]{3,8}$/i.test(hex)) return null
  const full = expand(hex)
  if (full.length !== 6) return null
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  }
}

function toHex({ r, g, b }: Rgb): string {
  const c = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** Blend `amount` of `a` over `b` (0 = all b, 1 = all a). */
function mix(a: string, b: string, amount: number): string {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return a
  return toHex({
    r: ca.r * amount + cb.r * (1 - amount),
    g: ca.g * amount + cb.g * (1 - amount),
    b: ca.b * amount + cb.b * (1 - amount)
  })
}

/** WCAG relative luminance, which is what a contrast ratio is computed from. */
function luminance(color: string): number {
  const rgb = parseHex(color)
  if (!rgb) return 0
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/** How readable one colour is on another, 1 (invisible) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Push a colour until it is readable on every background it will be used against.
 *
 * The derived palette was built by mixing toward the foreground by a fixed
 * fraction, which produces pleasant-looking values and no guarantee at all: every
 * one of the built-in themes had `--fg-faint` below 4.5:1, and one had its error
 * colour at 2.81:1 — a red that fails is worse than no colour, because it is the
 * one people are meant to notice.
 *
 * A theme's own colours are still the starting point; this only moves them as far
 * as it has to, and towards the theme's own foreground rather than to black or
 * white, so a dark theme stays dark and a tinted one keeps its tint.
 */
function readable(color: string, against: string[], target: number, toward: string): string {
  const worst = (candidate: string): number =>
    Math.min(...against.map((bg) => contrastRatio(candidate, bg)))

  if (worst(color) >= target) return color

  /*
   * Toward the theme's own foreground first, and only then past it.
   *
   * Some themes are built around a foreground that itself falls short — Solarized
   * dark reads 4.01:1 — and mixing toward it converges on a colour that still
   * fails, which is how every token in one theme collapsed to the same grey and
   * none of them passed. When the theme's own foreground is not enough, the only
   * place left to go is white or black.
   */
  const extreme = luminance(against[0]) < 0.5 ? '#ffffff' : '#000000'
  for (const end of [toward, extreme]) {
    let best = color
    for (let i = 1; i <= 20; i++) {
      best = mix(end, color, i / 20)
      if (worst(best) >= target) return best
    }
    color = best
  }
  return color
}

/** Drop any alpha channel; several xterm colour slots reject 8-digit hex. */
function opaque(value: string, over: string): string {
  const hex = value.trim().replace(/^#/, '')
  if (hex.length !== 8 && hex.length !== 4) return value
  const rgb = parseHex(value)
  const bg = parseHex(over)
  if (!rgb || !bg) return value
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : parseInt(hex[3] + hex[3], 16) / 255
  return toHex({
    r: rgb.r * alpha + bg.r * (1 - alpha),
    g: rgb.g * alpha + bg.g * (1 - alpha),
    b: rgb.b * alpha + bg.b * (1 - alpha)
  })
}

/* ------------------------------------------------------------- resolution */

const DARK_ANSI = {
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

const LIGHT_ANSI = {
  black: '#1f1f1f',
  red: '#c72e2e',
  green: '#2c7a2c',
  yellow: '#9a6700',
  blue: '#1a63c4',
  magenta: '#9b2fae',
  cyan: '#0f7c8c',
  white: '#4d4d4d',
  brightBlack: '#767676',
  brightRed: '#e2453f',
  brightGreen: '#3a9b3a',
  brightYellow: '#b8860b',
  brightBlue: '#2a7fe0',
  brightMagenta: '#b845c9',
  brightCyan: '#1897a8',
  brightWhite: '#000000'
}

export function resolveTheme(id: string, file: ThemeFile): ResolvedTheme {
  const colors = file.colors ?? {}
  const type: 'dark' | 'light' =
    file.type === 'light' || file.type === 'hcLight' ? 'light' : 'dark'
  const dark = type === 'dark'

  /** First key that the theme actually defines, else the given default. */
  const pick = (keys: string[], fallback: string): string => {
    for (const key of keys) {
      const value = colors[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return fallback
  }

  const bg = pick(['terminal.background', 'editor.background'], dark ? '#0c0c0c' : '#fdfdfd')
  const fg = pick(['terminal.foreground', 'editor.foreground'], dark ? '#e6e6e6' : '#24292e')

  const ansiDefaults = dark ? DARK_ANSI : LIGHT_ANSI
  const ansi = (name: keyof typeof DARK_ANSI, key: string): string =>
    opaque(pick([`terminal.ansi${key}`], ansiDefaults[name]), bg)

  const terminal: TerminalPalette = {
    background: opaque(bg, dark ? '#000000' : '#ffffff'),
    foreground: opaque(fg, bg),
    cursor: opaque(pick(['terminalCursor.foreground', 'editorCursor.foreground'], dark ? '#ff9d5c' : '#c05621'), bg),
    cursorAccent: opaque(bg, dark ? '#000000' : '#ffffff'),
    selectionBackground: pick(
      ['terminal.selectionBackground', 'editor.selectionBackground'],
      dark ? '#3a4a63' : '#cfe3ff'
    ),
    /*
     * Black has to be visible against the terminal's own background.
     *
     * Several themes set it to exactly their background colour, so anything a
     * program printed in black — an ordinary thing for a program to do, and what
     * many prompts and spinners use — disappeared entirely. Nudged toward the
     * foreground only as far as it takes to be seen, so it still reads as black.
     */
    black: readable(ansi('black', 'Black'), [opaque(bg, dark ? '#000000' : '#ffffff')], 1.6, fg),
    red: ansi('red', 'Red'),
    green: ansi('green', 'Green'),
    yellow: ansi('yellow', 'Yellow'),
    blue: ansi('blue', 'Blue'),
    magenta: ansi('magenta', 'Magenta'),
    cyan: ansi('cyan', 'Cyan'),
    white: ansi('white', 'White'),
    brightBlack: ansi('brightBlack', 'BrightBlack'),
    brightRed: ansi('brightRed', 'BrightRed'),
    brightGreen: ansi('brightGreen', 'BrightGreen'),
    brightYellow: ansi('brightYellow', 'BrightYellow'),
    brightBlue: ansi('brightBlue', 'BrightBlue'),
    brightMagenta: ansi('brightMagenta', 'BrightMagenta'),
    brightCyan: ansi('brightCyan', 'BrightCyan'),
    brightWhite: ansi('brightWhite', 'BrightWhite')
  }

  const chrome = pick(
    [
      'titleBar.activeBackground',
      'editorGroupHeader.tabsBackground',
      'tab.inactiveBackground',
      'sideBar.background'
    ],
    mix(fg, bg, dark ? 0.06 : 0.05)
  )
  const elevated = pick(
    ['editorWidget.background', 'menu.background', 'dropdown.background', 'sideBar.background'],
    mix(fg, bg, dark ? 0.1 : 0.04)
  )
  const hover = pick(
    ['list.hoverBackground', 'toolbar.hoverBackground', 'tab.hoverBackground'],
    mix(fg, bg, dark ? 0.16 : 0.08)
  )
  const border = opaque(
    pick(['panel.border', 'editorGroup.border', 'sideBar.border', 'contrastBorder'], mix(fg, bg, 0.15)),
    bg
  )
  const borderStrong = opaque(
    pick(['input.border', 'dropdown.border', 'widget.border'], mix(fg, bg, 0.28)),
    bg
  )
  const fgDim = opaque(pick(['descriptionForeground', 'tab.inactiveForeground'], mix(fg, bg, 0.62)), bg)
  const fgFaint = opaque(
    pick(['disabledForeground', 'editorLineNumber.foreground'], mix(fg, bg, 0.42)),
    bg
  )
  const accent = opaque(
    pick(['focusBorder', 'progressBar.background', 'button.background', 'textLink.foreground'], dark ? '#ff9d5c' : '#c05621'),
    bg
  )
  const ok = opaque(pick(['gitDecoration.addedResourceForeground', 'charts.green'], terminal.green), bg)
  const fail = opaque(
    pick(['errorForeground', 'editorError.foreground', 'charts.red'], terminal.red),
    bg
  )
  const info = opaque(pick(['textLink.foreground', 'charts.blue'], terminal.blue), bg)

  /*
   * Every background text can land on.
   *
   * A colour is only readable if it is readable everywhere it is used, and these
   * surfaces differ enough to matter — a value that passes on the pane background
   * can fail on an elevated panel or a hovered row.
   */
  const surfaces = [bg, chrome, elevated, hover, mix(fg, bg, dark ? 0.03 : 0.02)]
  const text = (color: string): string => readable(color, surfaces, 4.5, fg)
  // 3:1 is the floor for borders, icons and other non-text marks.
  const mark = (color: string): string => readable(color, surfaces, 3, fg)

  const vars: Record<string, string> = {
    bg,
    'bg-chrome': chrome,
    'bg-elevated': elevated,
    'bg-hover': hover,
    // Blocks sit just off the pane background so their edges read without a border.
    'bg-block': mix(fg, bg, dark ? 0.03 : 0.02),
    border: mark(border),
    'border-strong': mark(borderStrong),
    // The body text of a theme built around a foreground that itself falls short —
    // Solarized dark is the well-known one — is lifted like everything else. A theme
    // is entitled to its palette, but not to text nobody can read.
    fg: text(fg),
    'fg-dim': text(fgDim),
    'fg-faint': text(fgFaint),
    accent: text(accent),
    'accent-dim': mix(accent, bg, 0.32),
    ok: text(ok),
    fail: text(fail),
    'fail-border': mix(fail, bg, 0.35),
    'fail-bg': mix(fail, bg, 0.08),
    info: text(info),
    'info-fg': text(mix(info, fg, dark ? 0.55 : 0.75)),
    'info-bg': mix(info, bg, dark ? 0.12 : 0.08),
    'info-border': mix(info, bg, 0.42),
    'primary-bg': mix(info, bg, dark ? 0.38 : 0.85),
    'primary-border': mix(info, bg, dark ? 0.55 : 0.95),
    'primary-fg': dark ? mix('#ffffff', info, 0.85) : '#ffffff',
    'close-hover': dark ? '#c42b1c' : '#e11d48',
    selection: terminal.selectionBackground,
    // A heavy black scrim reads as muddy over a light theme, so lighten it there.
    scrim: dark ? 'rgba(0, 0, 0, 0.58)' : 'rgba(24, 24, 27, 0.28)'
  }

  return {
    id,
    name: file.name?.trim() || id,
    type,
    vars,
    terminal,
    tokenColors: file.tokenColors ?? []
  }
}

/**
 * Themes are commonly distributed as JSON with comments and trailing commas,
 * which `JSON.parse` rejects, so strip both before parsing. String contents are
 * preserved so colours and scope selectors survive intact.
 */
export function parseThemeJson(text: string): ThemeFile {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i++
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }

  // Trailing commas before a closing brace or bracket.
  out = out.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(out) as ThemeFile
}
