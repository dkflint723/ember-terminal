/**
 * How long ago, in the units a person would use.
 *
 * Deliberately coarse. The exact minute is never what is being asked — "3 months
 * ago" is read at a glance where a date has to be worked out — and every caller
 * here is annotating something with an age rather than recording a timestamp.
 */
export function ago(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return 'unknown'
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return 'just now'

  const steps: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86_400, 'day'],
    [604_800, 'week'],
    [2_629_800, 'month'],
    [31_557_600, 'year']
  ]

  let chosen = steps[0]
  for (const step of steps) if (seconds >= step[0]) chosen = step
  const n = Math.floor(seconds / chosen[0])
  return `${n} ${chosen[1]}${n === 1 ? '' : 's'} ago`
}
