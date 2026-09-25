/**
 * The machine's monospace families, found rather than typed.
 *
 * Chromium's local-font access lists every installed family; each is then
 * measured on a canvas — a face where 'i' and 'W' come out the same width is a
 * monospace face, which is the only kind a terminal wants to offer. Where the
 * listing is refused (the API needs a recent user gesture, and permission can
 * be withheld), a curated set of well-known coding fonts is checked against
 * what the renderer can actually draw, so the picker never offers a font that
 * is not there.
 */

const CURATED = [
  'Cascadia Code',
  'Cascadia Mono',
  'Consolas',
  'Courier New',
  'DejaVu Sans Mono',
  'Fira Code',
  'Hack',
  'IBM Plex Mono',
  'Inconsolata',
  'Iosevka',
  'JetBrains Mono',
  'Lucida Console',
  'MesloLGS NF',
  'Monaspace Neon',
  'Noto Sans Mono',
  'Roboto Mono',
  'Source Code Pro',
  'Space Mono',
  'Ubuntu Mono',
  'Victor Mono'
]

async function allFamilies(): Promise<string[]> {
  try {
    const query = (
      window as { queryLocalFonts?: () => Promise<{ family: string }[]> }
    ).queryLocalFonts
    if (query) {
      const fonts = await query.call(window)
      const families = [...new Set(fonts.map((f) => f.family))]
      if (families.length > 0) return families
    }
  } catch {
    // Refused or unavailable; the curated list below still answers.
  }
  return CURATED.filter((f) => document.fonts.check(`12px "${f}"`))
}

function makeMeasurer(): ((family: string) => boolean) | null {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  return (family: string): boolean => {
    ctx.font = `16px "${family.replace(/"/g, '')}"`
    const narrow = ctx.measureText('iiii').width
    const wide = ctx.measureText('WWWW').width
    // Equal widths mean fixed pitch. A family the renderer cannot draw falls
    // back to the default proportional face and fails this test too — which is
    // the right answer for a font that is not really there.
    return narrow > 0 && Math.abs(narrow - wide) < 0.5
  }
}

/**
 * The families that measure as monospace, a slice at a time.
 *
 * Setting a canvas font makes Chromium load that face there and then, and the
 * whole list used to be measured in one go. On a hosted runner that was 89
 * families held in a single task for 1.7 to 4.6 seconds, and past 27 once — and
 * it starts on the keypress that opens Settings, so the dialog, already built,
 * could not be painted until the last face was measured. Every first open of
 * Settings froze the window for that long.
 *
 * So the work stops every sixteen milliseconds and lets the page have a frame.
 * The dialog paints at once with the current font in the picker, and the rest of
 * the list arrives when the measuring is done — the same list, just not in the
 * way.
 */
async function monospaceOnly(
  families: string[],
  measure: (family: string) => boolean
): Promise<string[]> {
  const kept: string[] = []
  let sliceFrom = performance.now()
  for (const family of families) {
    if (measure(family)) kept.push(family)
    if (performance.now() - sliceFrom > 16) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      sliceFrom = performance.now()
    }
  }
  return kept
}

let cached: Promise<string[]> | null = null

/** Monospace families on this machine, sorted, computed once per session. */
export function monospaceFamilies(): Promise<string[]> {
  if (!cached) {
    cached = (async () => {
      const measure = makeMeasurer()
      const families = await allFamilies()
      const mono = measure ? await monospaceOnly(families, measure) : families
      return (mono.length > 0 ? mono : families).sort((a, b) => a.localeCompare(b))
    })()
  }
  return cached
}

/** The family a stored stack leads with, unquoted, for showing in the picker. */
export function leadFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '')
}

/** A picked family becomes a stack with dependable fallbacks behind it. */
export function stackFor(family: string): string {
  return family === 'Consolas' ? 'Consolas, monospace' : `${family}, Consolas, monospace`
}
