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
/*
 * Every surface text can land on, INCLUDING both ends of the window's gradient.
 *
 * The ground is a ramp, not a fill — grad-top at the top of the window, grad-bottom
 * at the floor — and a token measured only against --bg is measured against a colour
 * that exists on exactly one line of the window. The status chips sit at the bottom,
 * where the dark themes fall away hardest, and were never checked there at all.
 *
 * --card is here for a different reason: it is derived for every theme and used
 * nowhere, which is what a surface looks like just before somebody starts painting
 * things with it. Checked now, while the answer is still free, rather than after.
 */
const SURFACES = [
  'bg',
  'bg-chrome',
  'bg-elevated',
  'bg-hover',
  'bg-block',
  'grad-top',
  'grad-bottom',
  'card',
  'card-top',
  'card-bottom'
]

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
   * And the ground descends.
   *
   * The window is one ramp: grad-top at the ceiling, the base at 46%, grad-bottom at
   * the floor. That is only a light source if it actually falls the whole way down.
   * On the three light themes it did not — grad-top was mix(fg, bg, 0.02), DARKER
   * than the base, so a light window was a valley with a band of light across its
   * middle and the light came from nowhere. The dark branch was the only one anybody
   * had reasoned about.
   *
   * Measured as relative luminance rather than as the formulas, because the defect
   * was in the shape and the shape is what a person sees. A ramp that merely has
   * three different values passes nothing here.
   */
  const lum = (hex) => {
    const c = hex.replace('#', '')
    const ch = [0, 2, 4].map((i) => {
      const u = parseInt(c.slice(i, i + 2), 16) / 255
      return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
  }
  const crown = lum(v['grad-crown'])
  const top = lum(v['grad-top'])
  const mid = lum(v.bg)
  const foot = lum(v['grad-bottom'])
  check(
    `${theme.name}: the ground is lit from above`,
    top > mid && mid > foot,
    `top ${top.toFixed(4)} (${v['grad-top']}), base ${mid.toFixed(4)} (${v.bg}), foot ${foot.toFixed(4)} (${v['grad-bottom']})`
  )
  /*
   * And it descends from the window's FIRST pixel, not from the workspace's.
   *
   * The title bar sits outside the workspace and used to carry a flat chrome fill,
   * which composited darker than the ramp beneath it on all ten themes — so the
   * brightest row in the window was row forty-one, those forty pixels read as a
   * lid, and the seam under them read as a slot of light. The descent check above
   * started below the bar, so the one band that inverted the ramp was the one band
   * nothing measured.
   */
  check(
    `${theme.name}: and it starts at the window's first pixel`,
    crown > top,
    `crown ${crown.toFixed(4)} (${v['grad-crown']}) vs top ${top.toFixed(4)} (${v['grad-top']})`
  )

  /*
   * And a raised face stays inside the envelope that is already paid for.
   *
   * Being in SURFACES above proves the face is READABLE. It does not prove the face
   * is cheap: `readable()` would happily lift the whole palette to accommodate a
   * brighter card, and the first sign of that is not a failure here but every text
   * colour in the theme quietly getting paler. The hover fill is the lightest ground
   * on a dark theme and the darkest on a light one, and it is what every token is
   * already lifted against — so a face capped there costs the palette nothing, and
   * one that is not is spending contrast the theme does not have.
   */
  const face = theme.type === 'dark' ? lum(v['card-top']) : lum(v['card-bottom'])
  const paid = lum(v['bg-hover'])
  check(
    `${theme.name}: a raised face costs the palette nothing`,
    theme.type === 'dark' ? face <= paid : face >= paid,
    `face ${face.toFixed(4)} vs hover ${paid.toFixed(4)} (${theme.type})`
  )

  /*
   * Black ANSI output has to be visible too. Several dark themes set ansiBlack to
   * exactly their own background, so anything a program printed in black — which
   * is a normal thing for a program to do — vanished completely.
   */
  /*
   * And every other ANSI colour is text, so it is held to text's floor.
   *
   * Only black was ever lifted. The light fallback's bright yellow, #b8860b on
   * #fdfdfd, is 3.2:1 — a warning printed in it is the thing on the screen least
   * likely to be read. Measured against the terminal's own background and the
   * surfaces a block's output is drawn on, resting and hovered.
   */
  const grounds = [theme.terminal.background, v.bg, v['bg-block'], v['bg-hover']]
  for (const name of [
    'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
    'brightMagenta', 'brightCyan', 'brightWhite'
  ]) {
    const color = theme.terminal[name]
    const worst = Math.min(...grounds.map((g) => contrastRatio(color, g)))
    check(`${theme.name}: ANSI ${name} is readable`, worst >= 4.5, `${worst.toFixed(2)}:1 (${color})`)
  }

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
