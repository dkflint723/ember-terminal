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
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
// Overridable so the check itself can be checked against a folder built to fail it.
const RELEASE = process.env.EMBER_RELEASE_DIR ?? path.join(APP_DIR, 'release')
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

/*
 * The bytes, not only the names.
 *
 * The updater downloads the installer and compares its sha512 with the one the feed
 * declared, and rejects it on a mismatch — which, like the misspelled name this
 * script was written for, happens inside the installed app, after "an update is
 * available" has already been said, with nothing in the window to show for it. A
 * feed written before a re-sign, a re-zip or an interrupted copy names the right
 * file with the wrong hash, and every check above passes it. So each entry's
 * sha512 and size are compared with the file on disk.
 *
 * And the blockmap beside the installer: it is what lets an update download only
 * what changed, electron-builder writes one for every NSIS build, and a release
 * uploaded without it quietly makes every update a full download.
 */
// Read line by line: a `- url:` opens an entry under `files:`, and its indented
// `sha512:`/`size:` belong to it; the unindented `path:`/`sha512:` are the top level.
const entries = []
const top = { name: undefined, sha512: undefined }
for (const line of feed.split(/\r?\n/)) {
  const url = /^\s*-\s*url:\s*(.+?)\s*$/.exec(line)
  if (url) {
    entries.push({ name: url[1], sha512: undefined, size: NaN })
    continue
  }
  const field = /^(\s*)(path|sha512|size):\s*(.+?)\s*$/.exec(line)
  if (!field) continue
  const [, indent, key, value] = field
  if (indent.length === 0) {
    if (key === 'path') top.name = value
    else if (key === 'sha512') top.sha512 = value
  } else if (entries.length > 0) {
    const e = entries[entries.length - 1]
    if (key === 'sha512') e.sha512 = value
    else if (key === 'size') e.size = Number(value)
  }
}
if (entries.length === 0) failures.push('latest.yml lists no files')
const digest = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
for (const e of [...entries, ...(top.name ? [top] : [])]) {
  const file = path.join(RELEASE, e.name)
  if (!fs.existsSync(file)) continue // already reported above
  if (!e.sha512) failures.push(`latest.yml gives no sha512 for "${e.name}"`)
  else if (digest(file) !== e.sha512) failures.push(`"${e.name}" does not match the sha512 latest.yml declares for it`)
  if (e !== top && Number.isFinite(e.size) && fs.statSync(file).size !== e.size) {
    failures.push(`"${e.name}" is ${fs.statSync(file).size} bytes; latest.yml says ${e.size}`)
  }
}
const uploads = new Set(['latest.yml', ...named])
for (const e of entries) {
  if (!/\.exe$/i.test(e.name)) continue
  const map = `${e.name}.blockmap`
  if (fs.existsSync(path.join(RELEASE, map))) uploads.add(map)
  else failures.push(`no ${map} beside the installer; every update would be a full download`)
}

for (const f of failures) console.log(`  - ${f}`)
console.log('release assets:', failures.length === 0 ? 'PASS' : 'FAIL')
// Everything a release has to carry for the updater to work, one per line, so the
// release job can upload exactly this list and nothing it has to remember.
if (failures.length === 0) for (const u of uploads) console.log(`  asset: ${u}`)
process.exit(failures.length === 0 ? 0 : 1)
