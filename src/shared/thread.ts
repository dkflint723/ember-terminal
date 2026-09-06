import type { AgentTurn } from './types.js'

/**
 * No stream survives leaving the window it was routed to.
 *
 * A delta is addressed twice over: main sends it to the webContents that asked for
 * it, and the panel routes it through a map that lives in that window's own module.
 * So a turn still streaming when its session is written to disk — or handed to
 * another window — will never be finished by anybody. Cancelled is the truth of
 * what happened to it.
 *
 * `snapshot()` has always known this and said so; the two halves of a session move
 * did not, so a session carried out mid-answer arrived holding a turn that could
 * only spin. That is not cosmetic: the panel refuses to send while anything is
 * streaming, so its input was dead for the life of the window, and Stop takes the
 * FIRST streaming turn — so once a ghost was stranded, Stop aimed at the corpse for
 * ever and could never reach a genuinely live turn behind it.
 *
 * One function so the rule has one owner. It was stated in one place and forgotten
 * in two, which is what a rule kept as a `.map()` in the middle of a packer does.
 */
export function settleThread(thread: AgentTurn[]): AgentTurn[] {
  return thread.map((turn) =>
    turn.status === 'streaming' ? { ...turn, status: 'cancelled' as const } : turn
  )
}
