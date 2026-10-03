import { verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalFeed, isLocalFeed, signatureUrl, UPDATE_PUBLIC_KEY, type FeedInfo } from '../shared/feed-signature.js'

/**
 * Whether an update the updater found is signed by the release key: see
 * shared/feed-signature.ts. The signature is fetched from beside the feed the updater
 * itself read, as its configuration names it.
 *
 * `EMBER_UPDATE_PUBKEY` stands in another key for a suite, and only for a feed served
 * on this machine (isLocalFeed). It was honoured everywhere in 0.5.0, so a variable
 * left set in someone's environment turned the check off for real updates; against
 * GitHub the release's key is the only key.
 */
export async function checkFeedSignature(
  info: FeedInfo,
  fetchText: (url: string) => Promise<{ ok: boolean; status: number; text: string }>,
  resourcesPath: string
): Promise<{ ok: true } | { ok: false; reason: string; transient?: boolean }> {
  const config = feedConfig(resourcesPath)
  if (config === null) return { ok: false, reason: 'the updater has no feed configured' }
  const url = signatureUrl(config, info.version)
  if (!url) return { ok: false, reason: 'this feed has no place for a signature' }
  let fetched: { ok: boolean; status: number; text: string }
  try {
    fetched = await fetchText(url)
  } catch (err) {
    // The network, not the release: said as something to try again, not as tampering.
    return { ok: false, reason: `its signature could not be fetched (${err instanceof Error ? err.message : String(err)})`, transient: true }
  }
  if (fetched.status >= 500) return { ok: false, reason: `GitHub could not hand over its signature just now (HTTP ${fetched.status})`, transient: true }
  if (!fetched.ok) return { ok: false, reason: `no signature is published with it (HTTP ${fetched.status})` }
  const signature = Buffer.from(fetched.text.trim(), 'base64')
  const key = isLocalFeed(url) && process.env.EMBER_UPDATE_PUBKEY ? process.env.EMBER_UPDATE_PUBKEY : UPDATE_PUBLIC_KEY
  try {
    const good = verify(null, Buffer.from(canonicalFeed(info), 'utf8'), key, signature)
    return good ? { ok: true } : { ok: false, reason: 'its signature does not match what the feed says' }
  } catch (err) {
    return { ok: false, reason: `its signature could not be read (${err instanceof Error ? err.message : String(err)})` }
  }
}

/**
 * Whether an unsigned or badly signed update is refused, or only noted. Refused.
 *
 * 0.5.0 noted it and downloaded anyway, because the builds before it could not check
 * and the first signed release had to reach them; every build from 0.5.0 on checks,
 * so from the release after it a signature that does not hold stops the download.
 * `EMBER_UPDATE_SIGNATURE=log` puts back the noting, for a suite, and — like the key —
 * only for a feed served on this machine.
 */
export function signatureRequired(resourcesPath: string): boolean {
  const config = feedConfig(resourcesPath)
  const url = config === null ? null : signatureUrl(config, '0')
  if (url && isLocalFeed(url) && process.env.EMBER_UPDATE_SIGNATURE === 'log') return false
  return true
}

function feedConfig(resourcesPath: string): string | null {
  try {
    return readFileSync(join(resourcesPath, 'app-update.yml'), 'utf8')
  } catch {
    return null
  }
}
