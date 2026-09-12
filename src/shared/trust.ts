/**
 * Which folders may run their own code.
 *
 * Opening a repository is not the same as agreeing to run it, and several
 * ordinary actions here did not know the difference: formatting runs the
 * project's prettier, which loads the project's `prettier.config.js`; Tab runs a
 * completion helper; a launch configuration and a package script are somebody
 * else's command lines. None of those look like "running" anything, which is
 * exactly why they were worth someone else's while.
 *
 * A folder is trusted or it is not, and the answer is remembered per folder. The
 * comparison has to be canonical: Windows hands the same directory back with
 * different capitalisation, through junctions, and under 8.3 short names, and a
 * trust check that can be walked around by spelling is not a trust check. The
 * canonical form is resolved by the caller — only the main process can follow a
 * junction — and this module decides what the answer means.
 *
 * Pure and free of node imports, so the rules can be exercised without a disk.
 */

// The `.ts` extension on purpose: the unit tests run this file through Node's own
// type stripping, which resolves a specifier as written and has no `.js` to find.
import { isInside } from './paths.ts'

/** What an untrusted folder is allowed to do. */
export interface TrustVerdict {
  trusted: boolean
  /** Said where the person can read it, when something was withheld. */
  reason?: string
}

/**
 * Whether this path sits in a trusted folder.
 *
 * Containment rather than equality, because trust is given to a project and a
 * project is a tree: a file two directories down is the same decision as the
 * root. Both sides are compared with the case-insensitive, separator-agnostic
 * rule the rest of the app uses for "same file".
 */
export function isTrustedPath(path: string, trustedFolders: readonly string[]): boolean {
  if (!path) return false
  return trustedFolders.some((root) => root.length > 0 && isInside(root, path))
}

/**
 * The verdict for an action that would run the folder's own code.
 *
 * Written as one function so every caller refuses for the same reason and says
 * the same thing. The wording names the folder rather than the action, because
 * the decision belongs to the folder and one answer covers all of them.
 */
export function mayRunFolderCode(
  path: string | null,
  trustedFolders: readonly string[]
): TrustVerdict {
  if (!path) {
    return { trusted: false, reason: 'There is no folder open to trust.' }
  }
  if (isTrustedPath(path, trustedFolders)) return { trusted: true }
  return {
    trusted: false,
    reason: 'This folder is restricted — nothing in it runs until you trust it.'
  }
}

/**
 * The same verdict with the way back applied.
 *
 * `workspaceTrust: false` restores exactly the old behaviour — every open folder
 * may run its own code — and exists for one release, in case a folder this
 * refuses turns out to be one nobody would have thought to trust. It is written
 * once, here, rather than checked at each of the four call sites: a rollback
 * honoured in three places and forgotten in the fourth is worse than none.
 */
export function mayRunIn(
  path: string | null,
  settings: { trustedFolders?: readonly string[]; workspaceTrust?: boolean }
): TrustVerdict {
  if (settings.workspaceTrust === false) return { trusted: true }
  return mayRunFolderCode(path, settings.trustedFolders ?? [])
}

/**
 * Add a folder to the trusted list, without letting it accumulate duplicates or
 * children of folders already trusted.
 *
 * Trusting a parent subsumes its children: keeping both would mean revoking the
 * parent silently left the child trusted, which is the kind of half-revocation
 * nobody would expect.
 */
export function withTrust(trustedFolders: readonly string[], folder: string): string[] {
  if (!folder) return [...trustedFolders]
  if (isTrustedPath(folder, trustedFolders)) return [...trustedFolders]
  const kept = trustedFolders.filter((root) => !isInside(folder, root))
  return [...kept, folder]
}

/**
 * Take trust away from a folder, and from anything under it.
 *
 * Revoking a parent revokes its children: a subtree that stayed trusted after
 * its root was revoked would be trust the person believes they have withdrawn.
 */
export function withoutTrust(trustedFolders: readonly string[], folder: string): string[] {
  if (!folder) return [...trustedFolders]
  return trustedFolders.filter((root) => !isInside(folder, root) && !isInside(root, folder))
}
