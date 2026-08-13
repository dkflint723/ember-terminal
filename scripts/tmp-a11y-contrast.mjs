// Scratch probe: compute WCAG contrast for every built-in theme's resolved CSS vars.
// Replicates src/shared/theme.ts resolveTheme() exactly.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const THEMES = 'd:/git_projects/terminal/resources/themes'

/* ---- copied from src/shared/theme.ts ---- */
function parseHex(value) {
  if (!value) return null
  const hex = value.trim().replace(/^#/, '')
  const expand = (s) =>
    s.length === 3 || s.length === 4 ? s.slice(0, 3).split('').map((c) => c + c).join('') : s.slice(0, 6)
  if (!/^[0-9a-f]{3,8}$/i.test(hex)) return null
  const full = expand(hex)
  if (full.length !== 6) return null
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) }
}
function toHex({ r, g, b }) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}
function mix(a, b, amount) {
  const ca = parseHex(a), cb = parseHex(b)
  if (!ca || !cb) return a
  return toHex({ r: ca.r * amount + cb.r * (1 - amount), g: ca.g * amount + cb.g * (1 - amount), b: ca.b * amount + cb.b * (1 - amount) })
}
function opaque(value, over) {
  const hex = value.trim().replace(/^#/, '')
  if (hex.length !== 8 && hex.length !== 4) return value
  const rgb = parseHex(value), bg = parseHex(over)
  if (!rgb || !bg) return value
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : parseInt(hex[3] + hex[3], 16) / 255
  return toHex({ r: rgb.r * alpha + bg.r * (1 - alpha), g: rgb.g * alpha + bg.g * (1 - alpha), b: rgb.b * alpha + bg.b * (1 - alpha) })
}
const DARK_ANSI = { black: '#0c0c0c', red: '#e05561', green: '#8cc265', yellow: '#d18f52', blue: '#4aa5f0', magenta: '#c162de', cyan: '#42b3c2', white: '#d6d6d6', brightBlack: '#6b6b6b', brightRed: '#ff616e', brightGreen: '#a5e075', brightYellow: '#f0a45d', brightBlue: '#4dc4ff', brightMagenta: '#de73ff', brightCyan: '#4cd1e0', brightWhite: '#ffffff' }
const LIGHT_ANSI = { black: '#1f1f1f', red: '#c72e2e', green: '#2c7a2c', yellow: '#9a6700', blue: '#1a63c4', magenta: '#9b2fae', cyan: '#0f7c8c', white: '#4d4d4d', brightBlack: '#767676', brightRed: '#e2453f', brightGreen: '#3a9b3a', brightYellow: '#b8860b', brightBlue: '#2a7fe0', brightMagenta: '#b845c9', brightCyan: '#1897a8', brightWhite: '#000000' }

function resolveTheme(id, file) {
  const colors = file.colors ?? {}
  const type = file.type === 'light' || file.type === 'hcLight' ? 'light' : 'dark'
  const dark = type === 'dark'
  const pick = (keys, fallback) => {
    for (const key of keys) { const v = colors[key]; if (typeof v === 'string' && v.trim().length > 0) return v.trim() }
    return fallback
  }
  const bg = pick(['terminal.background', 'editor.background'], dark ? '#0c0c0c' : '#fdfdfd')
  const fg = pick(['terminal.foreground', 'editor.foreground'], dark ? '#e6e6e6' : '#24292e')
  const ansiDefaults = dark ? DARK_ANSI : LIGHT_ANSI
  const ansi = (name, key) => opaque(pick([`terminal.ansi${key}`], ansiDefaults[name]), bg)
  const terminal = {
    background: opaque(bg, dark ? '#000000' : '#ffffff'),
    foreground: opaque(fg, bg),
    cursor: opaque(pick(['terminalCursor.foreground', 'editorCursor.foreground'], dark ? '#ff9d5c' : '#c05621'), bg),
    selectionBackground: pick(['terminal.selectionBackground', 'editor.selectionBackground'], dark ? '#3a4a63' : '#cfe3ff'),
    black: ansi('black', 'Black'), red: ansi('red', 'Red'), green: ansi('green', 'Green'), yellow: ansi('yellow', 'Yellow'),
    blue: ansi('blue', 'Blue'), magenta: ansi('magenta', 'Magenta'), cyan: ansi('cyan', 'Cyan'), white: ansi('white', 'White'),
    brightBlack: ansi('brightBlack', 'BrightBlack'), brightRed: ansi('brightRed', 'BrightRed'), brightGreen: ansi('brightGreen', 'BrightGreen'),
    brightYellow: ansi('brightYellow', 'BrightYellow'), brightBlue: ansi('brightBlue', 'BrightBlue'),
    brightMagenta: ansi('brightMagenta', 'BrightMagenta'), brightCyan: ansi('brightCyan', 'BrightCyan'), brightWhite: ansi('brightWhite', 'BrightWhite')
  }
  const chrome = pick(['titleBar.activeBackground', 'editorGroupHeader.tabsBackground', 'tab.inactiveBackground', 'sideBar.background'], mix(fg, bg, dark ? 0.06 : 0.05))
  const elevated = pick(['editorWidget.background', 'menu.background', 'dropdown.background', 'sideBar.background'], mix(fg, bg, dark ? 0.1 : 0.04))
  const hover = pick(['list.hoverBackground', 'toolbar.hoverBackground', 'tab.hoverBackground'], mix(fg, bg, dark ? 0.16 : 0.08))
  const border = opaque(pick(['panel.border', 'editorGroup.border', 'sideBar.border', 'contrastBorder'], mix(fg, bg, 0.15)), bg)
  const borderStrong = opaque(pick(['input.border', 'dropdown.border', 'widget.border'], mix(fg, bg, 0.28)), bg)
  const fgDim = opaque(pick(['descriptionForeground', 'tab.inactiveForeground'], mix(fg, bg, 0.62)), bg)
  const fgFaint = opaque(pick(['disabledForeground', 'editorLineNumber.foreground'], mix(fg, bg, 0.42)), bg)
  const accent = opaque(pick(['focusBorder', 'progressBar.background', 'button.background', 'textLink.foreground'], dark ? '#ff9d5c' : '#c05621'), bg)
  const ok = opaque(pick(['gitDecoration.addedResourceForeground', 'charts.green'], terminal.green), bg)
  const fail = opaque(pick(['errorForeground', 'editorError.foreground', 'charts.red'], terminal.red), bg)
  const info = opaque(pick(['textLink.foreground', 'charts.blue'], terminal.blue), bg)
  const vars = {
    bg, 'bg-chrome': chrome, 'bg-elevated': elevated, 'bg-hover': hover, 'bg-block': mix(fg, bg, dark ? 0.03 : 0.02),
    border, 'border-strong': borderStrong, fg, 'fg-dim': fgDim, 'fg-faint': fgFaint,
    accent, 'accent-dim': mix(accent, bg, 0.32), ok, fail,
    'fail-border': mix(fail, bg, 0.35), 'fail-bg': mix(fail, bg, 0.08),
    info, 'info-fg': mix(info, fg, dark ? 0.55 : 0.75), 'info-bg': mix(info, bg, dark ? 0.12 : 0.08), 'info-border': mix(info, bg, 0.42),
    'primary-bg': mix(info, bg, dark ? 0.38 : 0.85), 'primary-border': mix(info, bg, dark ? 0.55 : 0.95),
    'primary-fg': dark ? mix('#ffffff', info, 0.85) : '#ffffff'
  }
  return { id, name: file.name?.trim() || id, type, vars, terminal }
}
function parseThemeJson(text) {
  let out = '', inString = false, inLine = false, inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (inLine) { if (c === '\n') { inLine = false; out += c } continue }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++ } continue }
    if (inString) { out += c; if (c === '\\') { out += next ?? ''; i++ } else if (c === '"') inString = false; continue }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { inLine = true; i++; continue }
    if (c === '/' && next === '*') { inBlock = true; i++; continue }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/* ---- WCAG ---- */
function lum(hex) {
  const c = parseHex(hex)
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}
function ratio(a, b) {
  const la = lum(a), lb = lum(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const rows = []
for (const f of readdirSync(THEMES).filter((f) => f.endsWith('.json'))) {
  const t = resolveTheme(f.replace(/\.json$/, ''), parseThemeJson(readFileSync(join(THEMES, f), 'utf8')))
  const v = t.vars
  // (label, fg, bg, required-ratio, where it is used)
  const pairs = [
    ['fg on bg (body 13px)', v.fg, v.bg, 4.5],
    ['fg-dim on bg-chrome (tab label 12px)', v['fg-dim'], v['bg-chrome'], 4.5],
    ['fg-dim on bg-chrome (tree row 12px)', v['fg-dim'], v['bg-chrome'], 4.5],
    ['fg-faint on bg-block (block meta 11px)', v['fg-faint'], v['bg-block'], 4.5],
    ['fg-faint on bg-chrome (composer meta 11px)', v['fg-faint'], v['bg-chrome'], 4.5],
    ['fg-faint on bg-elevated (qp detail 11px)', v['fg-faint'], v['bg-elevated'], 4.5],
    ['fg-faint on bg (find hint 10px)', v['fg-faint'], v.bg, 4.5],
    ['ok on bg-elevated (block ✓ status)', v.ok, v['bg-elevated'], 4.5],
    ['ok on bg-chrome (git added / gh pass)', v.ok, v['bg-chrome'], 4.5],
    ['fail on bg-elevated (block ✕ status)', v.fail, v['bg-elevated'], 4.5],
    ['fail on bg-chrome (git deleted, probs)', v.fail, v['bg-chrome'], 4.5],
    ['fail on fail-bg (scm__error text 11px)', v.fail, v['fail-bg'], 4.5],
    ['fail on bg-block (block__exit "exit 1")', v.fail, v['bg-block'], 4.5],
    ['accent on bg-chrome (git modified)', v.accent, v['bg-chrome'], 4.5],
    ['accent on bg (composer sigil)', v.accent, v.bg, 4.5],
    ['info-fg on info-bg (scm note / diff waiting)', v['info-fg'], v['info-bg'], 4.5],
    ['info-fg on bg-chrome (probs info dot, gh pending)', v['info-fg'], v['bg-chrome'], 4.5],
    ['primary-fg on primary-bg (Save button)', v['primary-fg'], v['primary-bg'], 4.5],
    ['fg on accent-dim (qp/complete selected row)', v.fg, v['accent-dim'], 4.5],
    ['bg on accent (activity badge 9px bold)', v.bg, v.accent, 4.5],
    ['bg on fail (error badge 9px bold)', v.bg, v.fail, 4.5],
    ['accent focus ring vs bg (UI 3:1)', v.accent, v.bg, 3],
    ['border-strong vs bg (input border 3:1)', v['border-strong'], v.bg, 3],
    ['border vs bg (block border 3:1)', v.border, v.bg, 3],
    ['ansiGreen on terminal bg', t.terminal.green, t.terminal.background, 4.5],
    ['ansiRed on terminal bg', t.terminal.red, t.terminal.background, 4.5],
    ['ansiYellow on terminal bg', t.terminal.yellow, t.terminal.background, 4.5],
    ['ansiBlue on terminal bg', t.terminal.blue, t.terminal.background, 4.5],
    ['ansiBlack on terminal bg', t.terminal.black, t.terminal.background, 4.5],
    ['ansiBrightBlack on terminal bg', t.terminal.brightBlack, t.terminal.background, 4.5],
    ['ansiCyan on terminal bg', t.terminal.cyan, t.terminal.background, 4.5],
    ['ansiMagenta on terminal bg', t.terminal.magenta, t.terminal.background, 4.5],
    ['ansiWhite on terminal bg', t.terminal.white, t.terminal.background, 4.5]
  ]
  console.log(`\n===== ${t.name}  (${t.id}, ${t.type}) =====`)
  console.log(`   bg=${v.bg} bg-chrome=${v['bg-chrome']} bg-elevated=${v['bg-elevated']} bg-block=${v['bg-block']}`)
  console.log(`   fg=${v.fg} fg-dim=${v['fg-dim']} fg-faint=${v['fg-faint']} accent=${v.accent} ok=${v.ok} fail=${v.fail} info-fg=${v['info-fg']}`)
  for (const [label, a, b, need] of pairs) {
    const r = ratio(a, b)
    const pass = r >= need
    if (!pass) rows.push({ theme: t.name, label, a, b, r: r.toFixed(2), need })
    console.log(`   ${pass ? 'PASS' : 'FAIL'} ${r.toFixed(2).padStart(6)} (need ${need})  ${label}   ${a} on ${b}`)
  }
}

console.log('\n\n############ FAILURES ############')
for (const r of rows) console.log(`${r.theme.padEnd(24)} ${String(r.r).padStart(6)} / ${r.need}   ${r.label}   ${r.a} on ${r.b}`)
console.log(`\ntotal failures: ${rows.length}`)
