// What the window has to load before it can show a prompt, weighed.
// Run after a build: node scripts/check-bundle.mjs [out/renderer]
//
// Monaco was in the startup bundle — 9.5 MB of entry chunk, most of it the editor —
// because a chain of static imports reached it from the store and three always-on
// components, and nothing noticed, because nothing measured. A terminal-only
// session paid for an editor it never drew on every launch.
//
// This weighs the entry chunk and every chunk it imports statically, which is all
// that must arrive before the first frame, and fails if that grows past the budget
// or if any of it is Monaco. Lazy chunks are free: they load when asked for.
import * as fs from 'node:fs'
import * as path from 'node:path'

const BUDGET = 3 * 1024 * 1024
const OUT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'out', 'renderer'))

const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8')
const entry = /<script[^>]+src="\.\/([^"]+\.js)"/.exec(html)?.[1]
if (!entry) {
  console.log(`bundle: FAIL — no entry script in ${path.join(OUT, 'index.html')}`)
  process.exit(1)
}

// Static imports only: `import … from "./x.js"` and bare `import "./x.js"`. A
// dynamic `import("./x.js")` is a lazy chunk and is deliberately not followed.
const STATIC = /(?:^|[;\n}])\s*import\s*(?:[^"'()]*?\s*from\s*)?["'](\.\/[^"']+\.js)["']/g

const seen = new Set()
const walk = (file) => {
  if (seen.has(file)) return
  seen.add(file)
  const text = fs.readFileSync(path.join(OUT, file), 'utf8')
  for (const m of text.matchAll(STATIC)) {
    walk(path.posix.join(path.posix.dirname(file), m[1]))
  }
}
walk(entry)

const files = [...seen].map((f) => ({ f, size: fs.statSync(path.join(OUT, f)).size }))
const total = files.reduce((n, x) => n + x.size, 0)
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

const failures = []
if (total > BUDGET) failures.push(`startup chunks weigh ${mb(total)}, over the ${mb(BUDGET)} budget`)
const editor = files.filter(({ f }) => /(^|\/)monaco[-.]/.test(f))
if (editor.length > 0) failures.push(`Monaco is loaded at startup: ${editor.map((x) => x.f).join(', ')}`)
// Belt and braces: a chunk name is Vite's choice, and Monaco's own service names
// are not. (A first version looked for a source path the bundle does not keep, and
// found it nowhere — the Monaco chunk included.)
for (const { f } of files) {
  if (fs.readFileSync(path.join(OUT, f), 'utf8').includes('IStandaloneThemeService')) {
    failures.push(`${f} carries Monaco's editor core`)
  }
}

for (const { f, size } of files.sort((a, b) => b.size - a.size)) console.log(`  ${mb(size).padStart(9)}  ${f}`)
for (const f of failures) console.log(`  - ${f}`)
console.log(`bundle (${mb(total)} at startup):`, failures.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 ? 0 : 1)
