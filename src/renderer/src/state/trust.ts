import { mayRunIn, type TrustVerdict } from '@shared/trust'
import { useStore, workspaceRoot } from './store'

/**
 * Workspace trust, from the side that has to explain it.
 *
 * The rules live in shared/trust.ts, where they are exercised without a disk, and
 * the authority lives in main, which owns the settings. What is here is the part
 * a person meets: which folder is in question, how a refusal is said, and the one
 * way forward offered alongside it.
 *
 * A refusal nobody can see is indistinguishable from a button that is broken, so
 * nothing in here fails quietly.
 */

/** The folder whose trust is in question: the project in front of you. */
export function folderInQuestion(): string | null {
  return workspaceRoot(useStore.getState())
}

/** Whether that folder may run its own code. */
export function mayRunHere(): TrustVerdict {
  const s = useStore.getState()
  return mayRunIn(workspaceRoot(s), s.settings)
}

/**
 * Grant or withdraw, through main.
 *
 * Through main rather than by writing the list from here, for the reason the
 * recent folders go that way: the settings cache is one object shared by every
 * window, so a renderer that sent the whole array would send the copy it
 * happened to be holding, and two windows would each drop the other's.
 */
export async function setTrust(folder: string, trusted: boolean): Promise<void> {
  const next = await window.ember.noteTrust(folder, trusted)
  useStore.getState().applySettings(next)
}

/**
 * Say what was withheld, why, and what can be done about it.
 *
 * One function so every refusal reads the same way and offers the same action —
 * four call sites each writing their own wording is four chances to describe the
 * same rule differently.
 */
export function explainRestricted(what: string): void {
  const folder = folderInQuestion()
  const reason = mayRunHere().reason ?? ''
  const actions = folder
    ? [{ label: 'Trust this folder', run: () => void setTrust(folder, true) }]
    : []
  useStore.getState().setNotice(`${what} ${reason}`.trim(), 'error', actions)
}
