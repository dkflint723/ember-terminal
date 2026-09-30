import { verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalFeed, signatureUrl, UPDATE_PUBLIC_KEY, type FeedInfo } from '../shared/feed-signature.js'

/**
 * Whether an update the updater found is signed by the release key: see
 * shared/feed-signature.ts. The signature is fetched from beside the feed the updater
 * itself read, as its configuration names it.
 *
 * `EMBER_UPDATE_PUBKEY` stands in another key, for a suite serving a feed of its own;
 * anyone able to set Ember's environment already runs code as its user.
 */
export async function checkFeedSignature(
  info: FeedInfo,
  fetchText: (url: string) => Promise<{ ok: boolean; status: number; text: string }>,
  resourcesPath: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let config: string
  try {
    config = readFileSync(join(resourcesPath, 'app-update.yml'), 'utf8')
  } catch {
    return { ok: false, reason: 'the updater has no feed configured' }
  }
  const url = signatureUrl(config, info.version)
  if (!url) return { ok: false, reason: 'this feed has no place for a signature' }
  let fetched: { ok: boolean; status: number; text: string }
  try {
    fetched = await fetchText(url)
  } catch (err) {
    return { ok: false, reason: `the signature could not be fetched (${err instanceof Error ? err.message : String(err)})` }
  }
  if (!fetched.ok) return { ok: false, reason: `no signature is published with it (HTTP ${fetched.status})` }
  const signature = Buffer.from(fetched.text.trim(), 'base64')
  try {
    const good = verify(null, Buffer.from(canonicalFeed(info), 'utf8'), process.env.EMBER_UPDATE_PUBKEY ?? UPDATE_PUBLIC_KEY, signature)
    return good ? { ok: true } : { ok: false, reason: 'its signature does not match what the feed says' }
  } catch (err) {
    return { ok: false, reason: `its signature could not be read (${err instanceof Error ? err.message : String(err)})` }
  }
}

/**
 * Whether an unsigned or badly signed update is refused, or only noted. Noted for one
 * release — the builds before this one cannot check, and the first signed release
 * has to reach them — then refused. `EMBER_UPDATE_SIGNATURE` sets it for a suite.
 */
export function signatureRequired(): boolean {
  const asked = process.env.EMBER_UPDATE_SIGNATURE
  if (asked === 'required') return true
  if (asked === 'log') return false
  return false
}
