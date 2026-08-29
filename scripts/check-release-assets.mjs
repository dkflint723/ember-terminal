// The update feed must name files that exist, spelled exactly as they are.
//
// This exists because of a bug that made every release un-installable while
// looking perfect from the outside: electron-builder writes latest.yml naming
// `Ember-Setup-<version>.exe`, the NSIS target used to *build* `Ember Setup
// <version>.exe`, and GitHub stores a file with spaces as `Ember.Setup...`.
// Three spellings, one of which nobody ever compared. The feed downloaded
// fine — so the app cheerfully reported an update was available — and then the
// installer fetch 404'd, silently, for ever.
//
// Run automatically at the end of `npm run dist`.
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const RELEASE = path.join(APP_DIR, 'release')
const feedPath = path.join(RELEASE, 'latest.yml')

if (!fs.existsSync(feedPath)) {
  console.error('release check: no latest.yml — nothing to publish from.')
  process.exit(1)
}

const feed = fs.readFileSync(feedPath, 'utf8')
/** Every filename the feed points an updater at: the `path:` and each `url:`. */
const named = new Set(
  [...feed.matchAll(/^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/gm)].map((m) => m[1].trim())
)

const failures = []
for (const name of named) {
  if (!fs.existsSync(path.join(RELEASE, name))) {
    failures.push(`latest.yml names "${name}", which is not in release/`)
  }
  // A name GitHub will rewrite is a name the updater will not find: spaces
  // become dots on upload, and the feed keeps asking for the original.
  if (/\s/.test(name)) failures.push(`"${name}" contains a space; GitHub would rename it`)
}

const version = /^version:\s*(.+)$/m.exec(feed)?.[1]?.trim()
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))
if (version !== pkg.version) {
  failures.push(`latest.yml says ${version}, package.json says ${pkg.version}`)
}

for (const f of failures) console.log(`  - ${f}`)
console.log('release assets:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log(failures.length === 0 ? `  publishing ${[...named].join(', ')}` : '')
process.exit(failures.length === 0 ? 0 : 1)
