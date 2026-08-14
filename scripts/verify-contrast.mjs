// Contrast, for every theme the app ships.
//
// The palette is derived by mixing a theme's foreground toward its background by a
// fixed fraction, which looks pleasant and guarantees nothing: every built-in theme
// had --fg-faint below the 4.5:1 floor, --border below the 3:1 one, and Solar Dusk
// rendered its error colour at 2.81:1 — a red that fails is worse than no colour,
// because it is the one people are meant to notice.
//
// Runs against the resolver rather than the UI: this is arithmetic on the theme
// files, so it needs no window and no waiting.
//
// Run: node scripts/verify-contrast.mjs
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const THEMES = path.join(APP_DIR, 'resources', 'themes')

// The resolver is TypeScript, so it is compiled to a scratch directory first —
// cheaper and more honest than reimplementing the derivation here, where a copy
// would drift and start passing while the app failed.
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-contrast-'))
execFileSync(
  'npx',
  [
    'tsc',
    path.join(APP_DIR, 'src/shared/theme.ts'),
    '--outDir',
    out,
    '--module',
    'esnext',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--skipLibCheck'
  ],
  { cwd: APP_DIR, stdio: 'pipe', shell: true }
)
fs.renameSync(path.join(out, 'theme.js'), path.join(out, 'theme.mjs'))
const { parseThemeJson, resolveTheme, contrastRatio } = await import(
  `file:///${path.join(out, 'theme.mjs').replace(/\\/g, '/')}`
)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/** Text has to clear 4.5:1; borders, icons and other marks 3:1. */
const TEXT = ['fg', 'fg-dim', 'fg-faint', 'accent', 'ok', 'fail', 'info', 'info-fg']
const MARKS = ['border', 'border-strong']
const SURFACES = ['bg', 'bg-chrome', 'bg-elevated', 'bg-hover', 'bg-block']

let checked = 0
for (const name of fs.readdirSync(THEMES).filter((f) => f.endsWith('.json'))) {
  const file = parseThemeJson(fs.readFileSync(path.join(THEMES, name), 'utf8'))
  const theme = resolveTheme(name.replace(/\.json$/, ''), file)
  const v = theme.vars
  checked += 1

  for (const token of TEXT) {
    const worst = Math.min(...SURFACES.map((s) => contrastRatio(v[token], v[s])))
    check(
      `${theme.name}: --${token} is readable`,
      worst >= 4.5,
      `${worst.toFixed(2)}:1 (${v[token]})`
    )
  }
  for (const token of MARKS) {
    const worst = Math.min(...SURFACES.map((s) => contrastRatio(v[token], v[s])))
    check(`${theme.name}: --${token} is visible`, worst >= 3, `${worst.toFixed(2)}:1 (${v[token]})`)
  }

  /*
   * Black ANSI output has to be visible too. Several dark themes set ansiBlack to
   * exactly their own background, so anything a program printed in black — which
   * is a normal thing for a program to do — vanished completely.
   */
  const black = theme.terminal.black
  check(
    `${theme.name}: black ANSI output is visible`,
    contrastRatio(black, theme.terminal.background) >= 1.6,
    `${contrastRatio(black, theme.terminal.background).toFixed(2)}:1 (${black} on ${theme.terminal.background})`
  )
}

fs.rmSync(out, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log(`theme contrast (${checked} themes):`, failures.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 ? 0 : 1)
