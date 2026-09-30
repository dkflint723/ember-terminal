import { isInside, pathKey } from '../shared/paths.js'

/**
 * Where each window's file requests are expected to go, and a note of any that go
 * elsewhere (audit R25, SE-07).
 *
 * Every file channel took any path the window named: read it, write it, rename it,
 * move it to the Recycle Bin. All that stood between a renderer injection and the
 * whole disk was the escaping in a handful of places. The aim is a main process that
 * accepts a path only inside the window's workspace roots, or one the user picked in
 * a dialog this session.
 *
 * This is the first half, and only notes. Ember opens files outside the folder on
 * purpose in more ways than can be listed with confidence — a path clicked in
 * terminal output, a definition in a library, a debugger frame in Node's own code —
 * and a rule that refused one of them would break it for everyone at once. So each
 * request outside is written to the log, once per window, channel and path, as
 * `ipc outside`; what those lines turn out to hold decides the rule before anything
 * is refused.
 *
 * Paths are compared as written, without case, after 8.3 short names are expanded:
 * a path reached through a junction or a SUBST drive into a root reads as outside.
 */
export type Access = 'read' | 'write'

export class PathScope {
  /** Each window's workspace roots, as the window reports them. */
  private roots = new Map<number, string[]>()
  /** Files and folders the user chose in a dialog, or named on the command line. */
  private picked = new Map<number, Set<string>>()
  private said = new Set<string>()
  /** Folders every window may use: the user-data folder, the app's own files. */
  private always: () => string[]
  private canonical: (p: string) => string
  private note: (line: string) => void

  constructor(always: () => string[], canonical: (p: string) => string, note: (line: string) => void) {
    this.always = always
    this.canonical = canonical
    this.note = note
  }

  setRoots(windowId: number, roots: unknown): void {
    const list = Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string' && r.length > 0) : []
    this.roots.set(windowId, list.slice(0, 64).map((r) => this.canonical(r)))
  }

  /** A path the user chose: it, and anything under it, is theirs to use. */
  pick(windowId: number, path: string | null | undefined): void {
    if (!path) return
    const set = this.picked.get(windowId) ?? new Set<string>()
    set.add(this.canonical(path))
    this.picked.set(windowId, set)
  }

  forget(windowId: number): void {
    this.roots.delete(windowId)
    this.picked.delete(windowId)
  }

  /** Whether the path is where this window's requests are expected to go. */
  within(windowId: number | null, path: string): boolean {
    const p = this.canonical(path)
    const places = [
      ...this.always(),
      ...(windowId !== null ? (this.roots.get(windowId) ?? []) : []),
      ...(windowId !== null ? [...(this.picked.get(windowId) ?? [])] : [])
    ]
    return places.some((place) => isInside(place, p))
  }

  /**
   * Note a request outside, once. Always true for now: this half notes, and refuses
   * nothing. A path that is not a string is left for the handler to reject.
   */
  check(windowId: number | null, channel: string, path: unknown, access: Access): boolean {
    if (typeof path !== 'string' || path.length === 0) return true
    if (this.within(windowId, path)) return true
    const key = `${windowId}|${channel}|${pathKey(path)}`
    if (!this.said.has(key) && this.said.size < 2000) {
      this.said.add(key)
      this.note(`${channel} (${access}) from window ${windowId ?? '?'}: ${path}`)
    }
    return true
  }
}
