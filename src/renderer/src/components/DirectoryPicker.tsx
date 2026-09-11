import { useEffect, useState } from 'react'
import type { DirEntry } from '@shared/types'
import { QuickPick, type QuickPickItem } from './QuickPick'

interface Props {
  /** Where the browsing starts, and where a relative pick is resolved from. */
  cwd: string
  /**
   * Change the shell's directory. Sent as a command so the shell really moves;
   * answers whether it was sent, which it is not when the terminal is busy.
   */
  onChangeDirectory: (path: string) => boolean
  onOpenFile: (path: string) => void
  onClose: () => void
}

/**
 * Walk the directory a terminal is standing in.
 *
 * `cd` into a project four levels down means typing the whole path, or typing `cd`
 * and Tab and Tab and Tab. The list is right there — the shell knows it, the
 * explorer knows it — and the one place a person is actually thinking about the
 * directory is the path at the bottom of the window, which said where they were and
 * offered nothing to do about it.
 *
 * Directories and files together, because "go there" and "open that" are the same
 * gesture from here and separating them would mean knowing which list a name is in
 * before looking for it. Enter on a directory walks into it, and the first line of
 * any directory but the starting one moves the shell there; Enter on a file opens
 * it in an editor.
 *
 * Escape, or a click outside, leaves the shell where it was. It used to be the move
 * — closing anywhere but the start sent the `cd` — so the gesture every picker in
 * the app means as "never mind" was the one that acted.
 */
export function DirectoryPicker({
  cwd,
  onChangeDirectory,
  onOpenFile,
  onClose
}: Props): React.JSX.Element {
  const [at, setAt] = useState(cwd)
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setEntries(null)
    setError(null)
    void window.ember.readDir(at).then((res) => {
      if (!live) return
      if (res.ok) setEntries(res.entries)
      else {
        setEntries([])
        setError(res.error)
      }
    })
    return () => {
      live = false
    }
  }, [at])

  /*
   * Directories first, then files, each alphabetically — the order every file
   * browser uses, and the one that makes "somewhere below here" findable by
   * scanning rather than by reading every line.
   *
   * Hidden entries are kept. A terminal is where `.git`, `.env` and `.claude` are
   * the whole reason for looking, and a browser that omits them is one you have to
   * stop using at exactly the moment it would help.
   */
  const sorted = [...(entries ?? [])].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  // Both separators: Windows paths arrive with backslashes and a path typed by hand
  // can hold either, and a parent that only understands one silently has none.
  const parent = at.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
  const items: QuickPickItem[] = [
    // First, once the walking has gone anywhere: so Enter, pressed again on
    // arriving, is the move. Matched against nothing, it gives way as soon as a
    // name is being typed.
    ...(at !== cwd ? [{ id: `here:${at}`, label: 'Move the shell here', detail: at, haystack: '' }] : []),
    // Only when there is one: the root of a drive has no parent, and an entry that
    // goes nowhere is worse than no entry.
    ...(parent && parent !== at ? [{ id: `up:${parent}`, label: '..', detail: 'Parent directory' }] : []),
    ...sorted.map((e) => ({
      id: `${e.isDirectory ? 'dir' : 'file'}:${e.path}`,
      label: e.name,
      detail: e.isDirectory ? '' : 'file',
      haystack: e.name
    }))
  ]

  return (
    <QuickPick
      /*
       * A fresh list for each directory. Kept across the walk, the words typed to
       * find one level went on filtering the next, which is a different list, and
       * the highlight stayed on a row number rather than on anything in it.
       */
      key={at}
      placeholder={`Search ${at}…`}
      items={items}
      empty={entries === null ? 'Reading…' : (error ?? 'Nothing here')}
      onPick={(item) => {
        const path = item.id.slice(item.id.indexOf(':') + 1)
        if (item.id.startsWith('file:')) {
          onClose()
          onOpenFile(path)
          return
        }
        if (item.id.startsWith('here:')) {
          // Closed either way: a move that could not be sent says why in a notice,
          // with what to do instead, and the picker would only be in its way.
          onChangeDirectory(path)
          onClose()
          return
        }
        // Directories keep the picker open, so walking down is one gesture per
        // level rather than a reopen each time.
        setAt(path)
      }}
      onClose={onClose}
    />
  )
}
