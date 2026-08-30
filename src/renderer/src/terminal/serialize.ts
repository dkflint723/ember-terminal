import type { IBufferCell, IBufferLine, Terminal } from '@xterm/xterm'
import { contrastRatio, type TerminalPalette } from '@shared/theme'

/**
 * Renders a terminal buffer to HTML as *logical* lines.
 *
 * The serialize addon emits one element per grid row, which bakes the capture
 * width into the markup: blocks then wrap at whatever width they were produced at
 * and look wrong after the window is resized, and copying a wrapped path yields it
 * broken across lines.
 *
 * xterm marks a row that is the continuation of a soft-wrapped line, so those rows
 * are joined back into the single line the program actually wrote. CSS then
 * reflows blocks at any width for free, and copied text has no artificial breaks.
 * A newline the program emitted itself still starts a new line, which is the
 * distinction that matters.
 */

/** The 256-colour palette: 16 themed, then the 6x6x6 cube, then the greys. */
function buildPalette(theme: TerminalPalette): string[] {
  const colors: string[] = [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite
  ]

  const steps = [0, 95, 135, 175, 215, 255]
  const hex = (n: number): string => n.toString(16).padStart(2, '0')
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        colors.push(`#${hex(steps[r])}${hex(steps[g])}${hex(steps[b])}`)
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    colors.push(`#${hex(v)}${hex(v)}${hex(v)}`)
  }
  return colors
}

function rgbToHex(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A cell's visual attributes, reduced to a comparable key plus a style string. */
interface Style {
  key: string
  css: string
}

function styleOf(cell: IBufferCell, palette: string[], theme: TerminalPalette): Style {
  const parts: string[] = []

  let fg: string | null = null
  if (cell.isFgRGB()) fg = rgbToHex(cell.getFgColor())
  else if (cell.isFgPalette()) fg = palette[cell.getFgColor()] ?? null

  let bg: string | null = null
  if (cell.isBgRGB()) bg = rgbToHex(cell.getBgColor())
  else if (cell.isBgPalette()) bg = palette[cell.getBgColor()] ?? null

  // Inverse swaps the two, falling back to the pane's own colours where a side
  // is default — otherwise inverted text on a default background disappears.
  if (cell.isInverse()) {
    const nextFg = bg ?? 'var(--bg)'
    const nextBg = fg ?? 'var(--fg)'
    fg = nextFg
    bg = nextBg
  }

  /*
   * A program that paints a background has chosen the fill, not the text on it.
   *
   * PowerShell marks directories with `ESC[44;1m` — a blue background and no
   * foreground at all — so the names keep whatever the pane's default foreground
   * happens to be. On a dark theme with a dark blue that is fine; on a theme whose
   * blue is light it is light text on a light fill, and a listing became unreadable
   * exactly where the shell was drawing attention to something.
   *
   * The fill is kept as asked and the text is made legible on it, using the theme's
   * own two ends rather than black and white so a dark theme stays dark. Only for
   * real colours: the inverse fallbacks above are CSS variables that resolve at
   * paint time and cannot be measured here.
   */
  if (bg?.startsWith('#')) {
    const onIt = fg?.startsWith('#') ? fg : theme.foreground
    if (contrastRatio(onIt, bg) < 4.5) {
      fg =
        contrastRatio(theme.background, bg) >= contrastRatio(theme.foreground, bg)
          ? theme.background
          : theme.foreground
    }
  }

  if (fg) parts.push(`color:${fg}`)
  if (bg) parts.push(`background-color:${bg}`)
  if (cell.isBold()) parts.push('font-weight:bold')
  if (cell.isItalic()) parts.push('font-style:italic')
  if (cell.isDim()) parts.push('opacity:.65')
  if (cell.isStrikethrough() && cell.isUnderline()) {
    parts.push('text-decoration:underline line-through')
  } else if (cell.isUnderline()) {
    parts.push('text-decoration:underline')
  } else if (cell.isStrikethrough()) {
    parts.push('text-decoration:line-through')
  }

  const css = parts.join(';')
  return { key: css, css }
}

/** Append one grid row's cells onto the logical line being built. */
function appendRow(
  line: IBufferLine,
  palette: string[],
  theme: TerminalPalette,
  runs: { style: Style; text: string }[]
): void {
  const cell = line.getCell(0)
  if (!cell) return

  for (let x = 0; x < line.length; x++) {
    if (!line.getCell(x, cell)) continue
    // Width 0 is the trailing half of a wide glyph; its chars belong to the lead.
    if (cell.getWidth() === 0) continue

    const chars = cell.getChars()
    const text = chars.length === 0 ? ' ' : chars
    const style = styleOf(cell, palette, theme)
    const last = runs[runs.length - 1]
    if (last && last.style.key === style.key) last.text += text
    else runs.push({ style, text })
  }
}

export function renderBufferAsHtml(term: Terminal, theme: TerminalPalette): string {
  const buffer = term.buffer.active
  const palette = buildPalette(theme)

  let logical: { style: Style; text: string }[][] = []
  let current: { style: Style; text: string }[] = []

  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line) continue

    // A row that is not a continuation begins a new logical line.
    if (!line.isWrapped && y > 0) {
      logical.push(current)
      current = []
    }
    appendRow(line, palette, theme, current)
  }
  logical.push(current)

  // Drop the trailing spaces the grid pads every row with, then the blank lines
  // left over from the unused part of the buffer.
  for (const runs of logical) {
    while (runs.length > 0) {
      const last = runs[runs.length - 1]
      last.text = last.text.replace(/\s+$/, '')
      if (last.text.length === 0 && !last.style.css.includes('background')) runs.pop()
      else break
    }
  }
  while (logical.length > 0 && logical[logical.length - 1].every((r) => r.text.length === 0)) {
    logical.pop()
  }
  while (logical.length > 0 && logical[0].every((r) => r.text.length === 0)) logical.shift()

  /*
   * Collapse the grid's padding in the middle, which is not blank output.
   *
   * conpty repaints a screen rather than streaming a stream: it positions the
   * cursor where the next thing goes and leaves the rows it stepped over untouched,
   * so a capture holds runs of rows nothing ever wrote. `Get-ChildItem` measured
   * nineteen rows here, thirteen of them empty, between the `Directory:` line and
   * the table — where PowerShell itself prints exactly one blank line.
   *
   * One is kept rather than none, because a blank line between paragraphs is real
   * output and losing it would jam a report together. A program that meant to print
   * five in a row loses four, which is a trade worth making against every block
   * being padded to the height of a screen.
   */
  const spaced: typeof logical = []
  let blanks = 0
  for (const runs of logical) {
    if (runs.every((r) => r.text.length === 0)) {
      blanks += 1
      if (blanks === 1) spaced.push(runs)
    } else {
      blanks = 0
      spaced.push(runs)
    }
  }
  logical = spaced

  return logical
    .map((runs) => {
      if (runs.length === 0) return '<div class="row"></div>'
      const inner = runs
        .map((run) =>
          run.style.css.length > 0
            ? `<span style="${run.style.css}">${escapeHtml(run.text)}</span>`
            : escapeHtml(run.text)
        )
        .join('')
      return `<div class="row">${inner}</div>`
    })
    .join('')
}

/**
 * The inverse of the above: rendered output back to the plain text it came from.
 *
 * Not `innerText`, which is the obvious answer and the wrong one. `innerText` is
 * only specified to insert a line break per block-level element when the element
 * is *being rendered*; on a detached node — which is what every caller here builds,
 * because none of them want to touch the document — it is defined to fall back to
 * `textContent`. So it returns the right characters in the right order with every
 * newline missing, and nothing anywhere reports a problem.
 *
 * This cost more than a copy button. The same call wrote every command's output
 * into the searchable history as one run-on line, and handed the model the same
 * thing whenever a block was attached to a prompt.
 *
 * The rows are the lines, so the rows are what gets joined.
 */
export function textFromHtml(html: string): string {
  const el = document.createElement('div')
  el.innerHTML = html
  const rows = el.querySelectorAll('.row')
  // Output that is not row markup at all — nothing produces it today, but a
  // caller reaching here with a bare fragment should get its text, not nothing.
  if (rows.length === 0) return el.textContent ?? ''
  return Array.from(rows, (row) => row.textContent ?? '').join('\n')
}
