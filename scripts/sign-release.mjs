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
if (feed.packages) fail('The feed names web-installer packages, which Ember does not ship and the signature would not cover.')

/*
 * And the files it names are the files the release holds. A signature vouches for
 * whatever the feed says, so the installer it describes is fetched and measured
 * first: a feed and an installer that disagree are not signed. (This cannot say the
 * installer is the one that should have been built — installing the draft before
 * signing, as the release notes ask, is how that is known.)
 */
const { createHash } = await import('node:crypto')
for (const file of feed.files) {
  const local = path.join(path.dirname(feedFile), String(file.url))
  if (tag) execFileSync('gh', ['release', 'download', tag, '--pattern', String(file.url), '--dir', path.dirname(feedFile), '--clobber'], { stdio: 'inherit' })
  if (!fs.existsSync(local)) fail(`${file.url} is not beside the feed, so it cannot be checked against it.`)
  const bytes = fs.readFileSync(local)
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  if (sha512 !== file.sha512 || (file.size !== undefined && bytes.length !== file.size)) {
    fail(`${file.url} does not match the feed (sha512 ${sha512.slice(0, 16)}…, ${bytes.length} bytes); nothing was signed.`)
  }
}
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
