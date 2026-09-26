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
const { parseThemeJson, resolveTheme, contrastRatio, GLASS } = await import(
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

/** The stops of the window's ground: the title bar's crown, then the workspace's ramp. */
const GROUND = ['grad-crown', 'grad-top', 'bg', 'grad-bottom']
/** The two ends of any desktop a translucent window can be over. */
const DESKS = ['#000000', '#ffffff']
const ANSI = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite'
]

/*
 * Alpha compositing, written out here rather than borrowed from theme.ts: this is
 * the measurement, and a check that composited with the code it is checking would
 * agree with it by construction.
 */
const channels = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16))
const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`
/** `top` at `alpha` over an opaque `under`. */
const over = (top, alpha, under) => {
  const t = channels(top)
  const u = channels(under)
  return toHex(t.map((c, i) => c * alpha + u[i] * (1 - alpha)))
}
const rgbaOf = (css) => {
  const parts = /rgba\(([^)]+)\)/.exec(css)[1].split(',').map(Number)
  return { colour: toHex(parts.slice(0, 3)), alpha: parts[3] }
}
const distance = (a, b) => Math.max(...channels(a).map((c, i) => Math.abs(c - channels(b)[i])))
/** The lowest contrast any of `colours` has on any of `grounds`, and where. */
const worstOf = (colours, grounds) => {
  let ratio = Infinity
  let detail = ''
  for (const c of colours) {
    for (const ground of grounds) {
      const r = contrastRatio(c, ground)
      if (r < ratio) {
        ratio = r
        detail = `${r.toFixed(2)}:1 (${c} on ${ground})`
      }
    }
  }
  return { ratio, detail }
}
const measured = []

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
  const outputGrounds = [theme.terminal.background, v.bg, v['bg-block'], v['bg-hover']]
  for (const name of ANSI) {
    const color = theme.terminal[name]
    const worst = Math.min(...outputGrounds.map((g) => contrastRatio(color, g)))
    check(`${theme.name}: ANSI ${name} is readable`, worst >= 4.5, `${worst.toFixed(2)}:1 (${color})`)
  }

  const black = theme.terminal.black
  check(
    `${theme.name}: black ANSI output is visible`,
    contrastRatio(black, theme.terminal.background) >= 1.6,
    `${contrastRatio(black, theme.terminal.background).toFixed(2)}:1 (${black} on ${theme.terminal.background})`
  )

  /*
   * --- a frosted panel over whatever it is opened on ---------------------------
   *
   * Dialogs, the palette and menus are drawn at GLASS.panel over what they cover,
   * with a blur, so the colour text lands on is part panel and part whatever is
   * behind. The blur averages what is behind, so the grounds are the right model
   * for it: every stop of the ground, and every stop under the scrim a dialog puts
   * down first. The palette is not re-derived for this; it has to pass as it is.
   */
  const panelOver = (vars, behind) => {
    // Two scrims: the theme's, under a dialog, and the palette's own flat
    // rgba(0, 0, 0, 0.35) (`.qp__scrim`), which is heavier on a light theme.
    const scrims = [rgbaOf(vars.scrim), rgbaOf('rgba(0, 0, 0, 0.35)')]
    const under = behind.flatMap((b) => [b, ...scrims.map((s) => over(s.colour, s.alpha, b))])
    return under.map((b) => over(vars['bg-elevated'], GLASS.panel, b))
  }
  const plainPanels = panelOver(v, GROUND.map((s) => v[s]))
  const panelWorst = worstOf(TEXT.map((t) => v[t]), plainPanels)
  check(`${theme.name}: text on a frosted panel is readable`, panelWorst.ratio >= 4.5, panelWorst.detail)

  /*
   * --- and the same theme over the desktop -------------------------------------
   *
   * With a backdrop material the ground is kept at GLASS.ground and the desktop
   * shows through the rest, and nobody knows what the desktop is. So it is measured
   * at both ends — over pure black and over pure white — which bounds anything a
   * wallpaper, Mica's tint or the window behind can do to it. The terminal's own
   * background is transparent on glass (xterm draws on the same ground the blocks
   * do), so the ANSI colours are measured there too.
   *
   * This is `theme.glass`, the derivation the window switches to while a material
   * is drawn; the ordinary palette would fail it at any alpha that shows anything.
   */
  const g = theme.glass.vars
  const grounds = GROUND.flatMap((s) => DESKS.map((desk) => over(g[s], GLASS.ground, desk)))
  const glassSurfaces = [
    ...SURFACES.map((s) => g[s]),
    ...grounds,
    ...grounds.map((ground) => over(g['bg-chrome'], 0.78, ground)),
    ...panelOver(g, grounds)
  ]
  const glassText = worstOf(TEXT.map((t) => g[t]), glassSurfaces)
  check(`${theme.name}: on glass, text is readable over any desktop`, glassText.ratio >= 4.5, glassText.detail)
  const glassMarks = worstOf(MARKS.map((t) => g[t]), glassSurfaces)
  check(`${theme.name}: on glass, borders are visible over any desktop`, glassMarks.ratio >= 3, glassMarks.detail)
  const glassAnsi = worstOf(
    ANSI.map((name) => theme.glass.terminal[name]),
    [...grounds, g.bg, g['bg-block'], g['bg-hover']]
  )
  check(`${theme.name}: on glass, ANSI output is readable over any desktop`, glassAnsi.ratio >= 4.5, glassAnsi.detail)
  const glassBlack = worstOf([theme.glass.terminal.black], grounds)
  check(`${theme.name}: on glass, black ANSI output is visible`, glassBlack.ratio >= 1.6, glassBlack.detail)

  // What the glass cost this theme: how far its furthest-moved colour went.
  const moved = [
    ...TEXT.map((t) => [`--${t}`, v[t], g[t]]),
    ...ANSI.map((a) => [a, theme.terminal[a], theme.glass.terminal[a]])
  ]
    .map(([name, from, to]) => ({ name, from, to, d: distance(from, to) }))
    .sort((a, b) => b.d - a.d)[0]
  measured.push(
    `  ${theme.name.padEnd(26)} glass text ${glassText.ratio.toFixed(2)}  ansi ${glassAnsi.ratio.toFixed(2)}  ` +
      `panel ${panelWorst.ratio.toFixed(2)}  furthest move ${moved.name} ${moved.from}→${moved.to}`
  )
}

fs.rmSync(out, { recursive: true, force: true })
console.log(
  `worst contrast on glass (ground ${GLASS.ground} over black and white desktops) and on a frosted panel (${GLASS.panel}):`
)
for (const line of measured) console.log(line)
for (const f of failures) console.log(`  - ${f}`)
console.log(`theme contrast (${checked} themes):`, failures.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 ? 0 : 1)
