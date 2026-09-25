import { useEffect } from 'react'
import { create } from 'zustand'
import { pathKey } from '@shared/paths'
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

/*
 * The real names of the folders asked about, as main reported them.
 *
 * Main keeps the trusted list by each folder's real name — 8.3 short names
 * written out, junctions followed — and only main can ask the filesystem, so the
 * other side of the comparison is asked for once per folder and kept here. Until
 * the answer arrives the folder is judged by its own spelling alone, which is
 * how it was judged before and can only err towards refusing.
 */
const useRealNames = create<{ real: Record<string, string> }>(() => ({ real: {} }))
const asking = new Map<string, Promise<string>>()

/** The real name of a folder, if main has said it. */
export function realNameOf(path: string | null): string | null {
  if (!path) return null
  return useRealNames.getState().real[pathKey(path)] ?? null
}

/**
 * Ask main for a folder's real name, and remember it.
 *
 * Asked afresh when a caller is about to act on the answer, since a junction can
 * be pointed somewhere else between one press and the next; a render reads what
 * is known and asks only when nothing is.
 */
export function learnRealName(path: string): Promise<string> {
  const key = pathKey(path)
  const pending = asking.get(key)
  if (pending) return pending
  const asked = window.ember
    .realFolder(path)
    .then(
      (real) => {
        const name = typeof real === 'string' && real ? real : path
        if (useRealNames.getState().real[key] !== name) {
          useRealNames.setState((s) => ({ real: { ...s.real, [key]: name } }))
        }
        return name
      },
      () => path
    )
    .finally(() => asking.delete(key))
  asking.set(key, asked)
  return asked
}

/** The folder whose trust is in question: the project in front of you. */
export function folderInQuestion(): string | null {
  return workspaceRoot(useStore.getState())
}

/** Whether a path may run its own code, by its own spelling or its real name. */
export function mayRunAt(path: string | null): TrustVerdict {
  return mayRunIn(path, useStore.getState().settings, realNameOf(path))
}

/** Whether that folder may run its own code. */
export function mayRunHere(): TrustVerdict {
  return mayRunAt(folderInQuestion())
}

/**
 * The same verdict, once the folder's real name has been asked for — for a press
 * that is about to run something, where the answer should not depend on whether
 * main had got round to replying yet.
 */
export async function mayRunHereNow(): Promise<TrustVerdict> {
  const folder = folderInQuestion()
  if (folder) await learnRealName(folder)
  return mayRunAt(folderInQuestion())
}

/**
 * Whether a folder is trusted, for something drawn on screen: re-rendered when the
 * trusted list changes and again when the folder's real name arrives.
 */
export function useTrustedAt(path: string | null): boolean {
  const settings = useStore((s) => s.settings)
  const real = useRealNames((s) => (path ? s.real[pathKey(path)] : undefined))
  useEffect(() => {
    if (path && real === undefined) void learnRealName(path)
  }, [path, real])
  return mayRunIn(path, settings, real ?? null).trusted
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
