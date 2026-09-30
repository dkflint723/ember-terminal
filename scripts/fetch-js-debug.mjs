// Fetch Microsoft's js-debug DAP server into resources/js-debug.
//
// It is the Node debugger VS Code itself uses, published only as a GitHub
// release tarball — not on npm — so it cannot be a dependency. It is not
// committed either: someone else's build products do not belong in this
// repository. This script puts it where the build's extraResources rule already
// ships everything, and detection prefers this copy at runtime.
//
// Run: node scripts/fetch-js-debug.mjs            get the pinned version
//      node scripts/fetch-js-debug.mjs --force    fetch it again anyway
//      node scripts/fetch-js-debug.mjs --update   what the pin would have to become
import { execFileSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/*
 * A version, and the bytes that version is.
 *
 * This used to ask the GitHub API for the latest release and ship whatever came
 * back, which has two costs. A release built today and a release built tomorrow
 * could hold different debuggers with nothing recording that they did — so no
 * build here could be reproduced, and "it works on the last build" said nothing
 * about this one. And nothing checked the download at all: whatever those bytes
 * turned out to be, they were extracted into the app and shipped.
 *
 * So the version is written down, the hash of its tarball is written down, and a
 * download that does not match is refused rather than unpacked. Moving the pin is
 * a deliberate act: --update says what the new lines would be, and a person
 * changes them.
 */
const PIN = {
  tag: 'v1.117.0',
  asset: 'js-debug-dap-v1.117.0.tar.gz',
  sha256: 'ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772'
}

const APP_DIR = path.resolve(import.meta.dirname, '..')
const target = path.join(APP_DIR, 'resources', 'js-debug')
const marker = path.join(target, 'src', 'dapDebugServer.js')
const flag = process.argv[2]

const releaseFor = async (ref) => {
  const api =
    ref === 'latest'
      ? 'https://api.github.com/repos/microsoft/vscode-js-debug/releases/latest'
      : `https://api.github.com/repos/microsoft/vscode-js-debug/releases/tags/${ref}`
  const res = await fetch(api, { headers: { 'user-agent': 'ember-terminal' } })
  if (!res.ok) {
    console.error(`GitHub answered ${res.status} for ${ref}`)
    process.exit(1)
  }
  return res.json()
}

const assetIn = (release) =>
  (release.assets ?? []).find((a) => /^js-debug-dap-.*\.tar\.gz$/.test(a.name))

// What the pin would have to become to take the newest release. Prints, changes
// nothing: a debugger is not something to update by side effect of a build.
if (flag === '--update') {
  const release = await releaseFor('latest')
  const asset = assetIn(release)
  if (!asset) {
    console.error('No js-debug-dap asset in the latest release:', release.tag_name)
    process.exit(1)
  }
  const bytes = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer())
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  if (release.tag_name === PIN.tag) {
    console.log(`the pin is already the newest release (${PIN.tag})`)
    process.exit(0)
  }
  console.log(`the newest release is ${release.tag_name}; the pin says ${PIN.tag}.`)
  console.log('To move it, put these in PIN and run this script with --force:')
  console.log(`  tag: '${release.tag_name}',`)
  console.log(`  asset: '${asset.name}',`)
  console.log(`  sha256: '${sha256}'`)
  process.exit(0)
}

if (fs.existsSync(marker) && flag !== '--force') {
  console.log(`already here: ${marker}`)
  process.exit(0)
}

/*
 * Straight from the release, by name, and tried more than once.
 *
 * The version and the file are pinned, so there is nothing to ask the GitHub API —
 * which allows sixty unauthenticated requests an hour per address, and a hosted
 * runner shares its address with everyone else's. And a download that fails once
 * is tried again before a CI run is failed for it: that failure sends somebody an
 * email about a network, not about Ember. The hash below still decides.
 */
const url = `https://github.com/microsoft/vscode-js-debug/releases/download/${PIN.tag}/${PIN.asset}`
const download = async () => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'ember-terminal' } })
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (attempt >= 3) {
        console.error(`Could not download ${PIN.asset}: ${err instanceof Error ? err.message : err}`)
        process.exit(1)
      }
      console.log(`download failed (${err instanceof Error ? err.message : err}); trying again`)
      await new Promise((r) => setTimeout(r, attempt * 3000))
    }
  }
}

console.log(`fetching ${PIN.asset}…`)
const body = await download()

/*
 * Checked before anything is written where the build can reach it.
 *
 * A tarball that is not the one this pin names is not unpacked, not kept, and not
 * shipped — whether that is a bad download, a moved tag, or somebody else's
 * bytes. The message says both hashes, because "it did not match" without them is
 * not something anybody can act on.
 */
const sha256 = crypto.createHash('sha256').update(body).digest('hex')
if (sha256 !== PIN.sha256) {
  console.error(`${PIN.asset} is not what the pin says it is.`)
  console.error(`  expected sha256 ${PIN.sha256}`)
  console.error(`  got      sha256 ${sha256}`)
  console.error('Nothing was written. If this is a deliberate change, run with --update.')
  process.exit(1)
}

const tarball = path.join(APP_DIR, "resources", PIN.asset)
fs.mkdirSync(path.dirname(tarball), { recursive: true })
fs.writeFileSync(tarball, body)

fs.rmSync(target, { recursive: true, force: true })
// The tarball's root directory is js-debug/, so extracting into resources/
// lands it exactly where detection looks. Relative paths, because GNU tar
// reads a Windows drive letter as a remote host name.
execFileSync('tar', ['-xzf', PIN.asset], {
  cwd: path.join(APP_DIR, 'resources'),
  stdio: 'inherit'
})
fs.rmSync(tarball, { force: true })

if (!fs.existsSync(marker)) {
  console.error('Extraction finished but the server script is missing.')
  process.exit(1)
}
console.log(`ready: ${marker} (${PIN.tag}, sha256 verified)`)
