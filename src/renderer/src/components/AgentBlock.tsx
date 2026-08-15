import { memo } from 'react'
import type { AttachedBlock, ConversationBlock } from '../state/store'

interface Props {
  block: ConversationBlock
  onToggle: () => void
  /** Run the proposed command for real, as a command block of its own. */
  onRun: (command: string) => void
  onDismiss: () => void
  stuck?: boolean
}

function formatTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * What one attached block is, named in the head of the conversation it fed.
 *
 * The arrow points back up the list at the block the output came from, which is
 * where it is: attaching is always backwards, at something that already ran.
 * `(elided)` is said out loud because the agent was answering about a cut-down
 * copy — a claim about what the command printed is only as good as how much of
 * it was sent.
 */
function attachLabel(attached: AttachedBlock): string {
  return `↑ ${attached.command} output${attached.elided ? ' (elided)' : ''}`
}

/**
 * The attachments, tolerating their absence.
 *
 * Conversations written to the session file before context could be attached come
 * back without the field, and they are restored into the same list as everything
 * else — the same reason blocks older than conversations are read as commands.
 */
function attachmentsOf(block: ConversationBlock): AttachedBlock[] {
  return block.attached ?? []
}

/** What a collapsed conversation says it did, so the row still carries meaning. */
function summarise(block: ConversationBlock): string {
  /*
   * The chips name the attachments in the same row, so this only counts them —
   * but it counts them rather than leaving it to the chips, because the chips are
   * what a narrow pane cuts first and a fixed count survives it. The words are
   * the composer's own, so what was attached when the question was asked and what
   * the block says it was asked with read as the same sentence.
   */
  const n = attachmentsOf(block).length
  const context = n === 0 ? '' : `, ${n} ${n === 1 ? 'block' : 'blocks'} attached`
  if (block.streaming) return `— thinking${context}`
  if (block.error) return `— failed${context}`
  if (block.proposal?.state === 'run') return `— 1 command run${context}`
  if (block.proposal) return `— 1 command proposed${context}`
  return `— answered${context}`
}

/**
 * A conversation with the agent, as an entry in the block list.
 *
 * It used to be a column on the right: a 340px panel that was equally far from
 * every command it might be about, and that cost the window a third of its width
 * whether or not anything had been asked. Here the answer sits under the question,
 * in the place the question was asked, next to the error it is usually about.
 *
 * Distinguished from a command block by an --info edge and the one surface fill
 * left in the app — the prompt is prose, so it is set in the UI face rather than
 * the mono one, and what the agent offers to do is a card inside the block rather
 * than a card in the composer.
 */
export const AgentBlock = memo(function AgentBlock({
  block,
  onToggle,
  onRun,
  onDismiss,
  stuck
}: Props) {
  const proposal = block.proposal
  const attached = attachmentsOf(block)

  return (
    <section
      className="block block--agent"
      data-block-id={block.id}
      aria-label={`Asked Claude: ${block.prompt}`}
    >
      <div
        className={`block__head ${stuck ? 'block__head--stuck' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={!block.collapsed}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          onToggle()
        }}
      >
        <span className="block__chevron">{block.collapsed ? '▸' : '▼'}</span>
        <span className="block__status block__status--agent">✦</span>
        {/* Prose, not a command line — so it is set in the interface face at the
            same size, rather than in mono like the thing it is asking about. */}
        <span className="block__prompt">{block.prompt}</span>
        {/*
          What the question was asked with, beside the question.

          The output of these blocks went to the agent, so the block has to say so:
          an answer that read a command's output and a guess about the same thing
          look identical otherwise. They sit next to the prompt rather than in the
          answer because they are part of what was asked, not part of what came back.

          Each carries its own text as a title. The head is one line and it is the
          chips that give way in it — a command long enough to be interesting is
          exactly the one that gets cut — so the full label stays reachable on hover.
          How far they give way is the stylesheet's, not this file's.
        */}
        {attached.map((a) => {
          const label = attachLabel(a)
          return (
            <span className="block__attach" key={a.blockId} title={label}>
              {label}
            </span>
          )
        })}
        {block.collapsed && <span className="block__summary">{summarise(block)}</span>}
        <span className="block__meta">
          <span className="block__time">{formatTime(block.startedAt)}</span>
        </span>
      </div>

      {!block.collapsed && (
        <>
          <div className="block__answer">
            {block.error ? (
              <div className="block__answer-error">{block.error}</div>
            ) : block.answer ? (
              block.answer.split('\n').map((line, i) => <div key={i}>{line || ' '}</div>)
            ) : (
              <div className="block__thinking">Thinking…</div>
            )}
          </div>

          {proposal && (
            /*
             * The proposal card, moved out of the composer and squared off.
             *
             * Nothing here runs by arriving: the command is shown, and one of the
             * two buttons has to be pressed. That was true when this lived in the
             * composer and it stays true here — the only thing that changed is
             * that it is now beside the question it answers.
             *
             * A sibling of the answer, not a child of it. The answer is prose and
             * carries a prose measure — a wide right inset to keep the line length
             * readable — and nesting the card inside that meant its own margins
             * were counted from the text column rather than from the block, which
             * drew the card 152px narrower than it is specified.
             */
            <div className="proposal">
              <div className="proposal__body">{proposal.command}</div>
              {proposal.note && <div className="proposal__note">{proposal.note}</div>}
              <div className="proposal__actions">
                {proposal.state === 'open' ? (
                  <>
                    <button
                      className="proposal__primary"
                      onClick={() => onRun(proposal.command)}
                    >
                      Run
                    </button>
                    <button className="proposal__secondary" onClick={onDismiss}>
                      Dismiss
                    </button>
                  </>
                ) : (
                  <span className="proposal__state">
                    {proposal.state === 'run' ? 'Run' : 'Dismissed'}
                  </span>
                )}
                <span className="proposal__gap" />
                {proposal.destructive && (
                  <span className="proposal__warn">this one is hard to undo</span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
})
