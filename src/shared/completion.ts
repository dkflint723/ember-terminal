/**
 * Longest common prefix of the candidates, compared case-insensitively because
 * Windows paths and PowerShell commands are.
 *
 * Inserting this on the first Tab is what makes completion feel responsive: the
 * unambiguous part of the token lands immediately, and the list only has to
 * resolve what is genuinely ambiguous.
 */
export function commonPrefix(values: string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0]
  for (const value of values.slice(1)) {
    let i = 0
    while (
      i < prefix.length &&
      i < value.length &&
      prefix[i].toLowerCase() === value[i].toLowerCase()
    ) {
      i++
    }
    prefix = prefix.slice(0, i)
    if (prefix.length === 0) break
  }
  return prefix
}
