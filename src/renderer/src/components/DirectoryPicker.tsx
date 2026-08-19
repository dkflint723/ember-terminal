import { useEffect, useState } from 'react'
import type { DirEntry } from '@shared/types'
import { useStore } from '../state/store'
import { QuickPick, type QuickPickItem } from './QuickPick'

interface Props {
  /** Where the browsing starts, and where a relative pick is resolved from. */
  cwd: string
  /** Change the shell's directory. Sent as a command so the shell really moves. */
  onChangeDirectory: (path: string) => void
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
 * before looking for it. Picking a directory moves the shell; picking a file opens
 * it in an editor.
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
  const setNotice = useStore((s) => s.setNotice)

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
        // Directories keep the picker open, so walking down is one gesture per
        // level rather than a reopen each time. Enter on the one you want is the
        // only thing that closes it.
        setAt(path)
      }}
      onClose={() => {
        // Closing on a directory other than the one it opened in means the walking
        // was the point: take the shell there.
        if (at !== cwd) {
          onChangeDirectory(at)
          setNotice(`Moved to ${at}`, 'info')
        }
        onClose()
      }}
    />
  )
}
