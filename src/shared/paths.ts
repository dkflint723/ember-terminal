/**
 * One answer to "are these the same file?".
 *
 * Windows hands the same file back with different separators and different
 * capitalisation depending on how it was reached — a drag from Explorer, a command
 * line argument, a git status, a language server. Several places compared paths
 * with `===` and one normalised them, which meant the editor could believe it had
 * two different files open while the buffer they shared believed it was one. The
 * comparison has to be the same everywhere or the disagreement is the bug.
 */
export function pathKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase()
}

/** Whether two paths name the same file. Nulls are never the same as anything. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return pathKey(a) === pathKey(b)
}

/**
 * A path short enough to sit in a strip of chrome, keeping the end.
 *
 * Truncating from the right would leave every one reading the same few drive
 * letters, so this drops the head and marks it with an ellipsis.
 */
export function shortenPath(full: string, keep = 34): string {
  const clean = full.replace(/[\\/]+$/, '')
  if (clean.length <= keep) return clean
  const parts = clean.split(/[\\/]/)
  let out = parts[parts.length - 1] ?? clean
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}\\${out}`
    if (next.length > keep) break
    out = next
  }
  /*
   * The budget was a guide rather than a bound: the loop only refuses to *add* a
   * segment, so a single folder with a long name came back whole however long it
   * was. Whatever displayed it then had to cut it, and cutting is done on the
   * right — which took off the end, the one part this function exists to keep.
   * Cut here instead, from the same side the ellipsis is on.
   */
  if (out.length > keep) return `…${out.slice(out.length - keep)}`
  return `…\\${out}`
}

/** Whether `child` is `parent` itself or something inside it. */
export function isInside(parent: string, child: string): boolean {
  const p = pathKey(parent).replace(/\/$/, '')
  const c = pathKey(child)
  return c === p || c.startsWith(`${p}/`)
}
