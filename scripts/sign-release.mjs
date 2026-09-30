// Sign a release's update feed with the offline key, and attach the signature.
//
//   node scripts/sign-release.mjs v0.4.4             (the draft the release job made)
//   node scripts/sign-release.mjs --file latest.yml  (a feed on disk; writes latest.yml.sig beside it)
//
// The key is read from EMBER_UPDATE_KEY, or %USERPROFILE%\.ember-release\update-signing.pem.
// It never goes near CI: whoever holds the GitHub account holds the feed, and this
// signature is what Ember checks the feed against before it downloads (audit R24;
// src/shared/feed-signature.ts says what is signed, and why).
import { execFileSync } from 'node:child_process'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import yaml from 'js-yaml'
import './ts-resolve.mjs'
const { canonicalFeed, UPDATE_PUBLIC_KEY } = await import('../src/shared/feed-signature.ts')

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const args = process.argv.slice(2)
const keyFile = process.env.EMBER_UPDATE_KEY ?? path.join(os.homedir(), '.ember-release', 'update-signing.pem')
if (!fs.existsSync(keyFile)) fail(`No signing key at ${keyFile}. Set EMBER_UPDATE_KEY to where it is kept.`)
const key = createPrivateKey({ key: fs.readFileSync(keyFile), passphrase: process.env.EMBER_UPDATE_KEY_PASSPHRASE })

// The key must be the one Ember is built with, or every installed copy would refuse the release.
const built = createPublicKey(UPDATE_PUBLIC_KEY).export({ type: 'spki', format: 'der' })
const held = createPublicKey(key).export({ type: 'spki', format: 'der' })
if (!built.equals(held)) fail('That key is not the one in src/shared/feed-signature.ts; the release would be refused.')

let feedFile
let tag = null
let work = null
if (args[0] === '--file') {
  feedFile = path.resolve(args[1] ?? 'latest.yml')
} else {
  tag = args[0]
  if (!tag) fail('Name the release: node scripts/sign-release.mjs v0.4.4')
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-sign-'))
  execFileSync('gh', ['release', 'download', tag, '--pattern', 'latest.yml', '--dir', work], { stdio: 'inherit' })
  feedFile = path.join(work, 'latest.yml')
}

const feed = yaml.load(fs.readFileSync(feedFile, 'utf8'))
if (!feed?.version || !Array.isArray(feed.files) || feed.files.length === 0) fail(`${feedFile} does not look like an update feed.`)
if (tag && `v${feed.version}` !== tag) fail(`The feed says ${feed.version}, not ${tag}.`)
const text = canonicalFeed({ version: feed.version, files: feed.files })
const signature = sign(null, Buffer.from(text, 'utf8'), key).toString('base64')
if (!verify(null, Buffer.from(text, 'utf8'), UPDATE_PUBLIC_KEY, Buffer.from(signature, 'base64'))) fail('The signature did not verify; nothing was written.')

const sigFile = `${feedFile}.sig`
fs.writeFileSync(sigFile, `${signature}\n`, 'utf8')
console.log(`Signed ${feed.version}:\n${text}`)
if (tag) {
  execFileSync('gh', ['release', 'upload', tag, sigFile, '--clobber'], { stdio: 'inherit' })
  console.log(`latest.yml.sig is attached to ${tag}. Publish the draft when you are ready.`)
  fs.rmSync(work, { recursive: true, force: true })
} else {
  console.log(`Wrote ${sigFile}`)
}
