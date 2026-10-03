/**
 * An update feed signed by a key that never leaves the maintainer's hands (audit
 * R24, SE-06).
 *
 * Whoever controls the GitHub account controls the feed, and so what every installed
 * Ember downloads next — the installer's hash is checked, but against a feed the same
 * person wrote. Now each release carries `latest.yml.sig`: a signature, made offline,
 * over what the feed says — the version, and each file's name, SHA-512 and size.
 * Ember checks it against the public key it was built with before it downloads
 * anything; the updater then checks the installer against that same SHA-512, so the
 * signature covers the bytes that run.
 *
 * What is signed is written out from the feed's meaning, not its text, so the app —
 * which sees the feed only as the updater parsed it — and the signing script, which
 * reads the file, arrive at the same bytes.
 */

/** The key the release feed is signed with. Its private half is kept offline. */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAtIxDZxbXGeS7bLVTKv4RvSWb2yEmJ9bBxfQt4PWkck8=
-----END PUBLIC KEY-----
`

export interface FeedInfo {
  version: string
  files: { url: string; sha512: string; size?: number }[]
}

/** The bytes a signature covers: one line for the version, one per file, in name order. */
export function canonicalFeed(info: FeedInfo): string {
  const files = [...(info.files ?? [])]
    .map((f) => `file ${String(f.url)} ${String(f.sha512)} ${f.size ?? '-'}`)
    .sort()
  return ['ember-update-feed 1', `version ${String(info.version)}`, ...files, ''].join('\n')
}

/**
 * Where a release's signature is, from the updater's own configuration
 * (resources/app-update.yml): beside `latest.yml` on a generic feed, and among the
 * release's assets on GitHub. Null for anything else.
 */
/**
 * Whether a signature is to be fetched from this machine — a feed a suite serves on
 * localhost — which is the only place a suite's own key and mode may stand in for the
 * release's. A real update never comes from here: Ember's feed is GitHub's.
 */
export function isLocalFeed(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

export function signatureUrl(appUpdateYml: string, version: string): string | null {
  const field = (name: string): string | null => {
    const m = new RegExp(`^${name}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(appUpdateYml)
    return m ? m[1] : null
  }
  const provider = field('provider')
  if (provider === 'github') {
    const owner = field('owner')
    const repo = field('repo')
    return owner && repo ? `https://github.com/${owner}/${repo}/releases/download/v${version}/latest.yml.sig` : null
  }
  if (provider === 'generic') {
    const url = field('url')
    return url ? `${url.replace(/\/+$/, '')}/latest.yml.sig` : null
  }
  return null
}
