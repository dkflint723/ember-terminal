/**
 * The Claude models Ember offers.
 *
 * A curated list rather than everything that exists: the point of the switcher is
 * to make the choice in one gesture, and a menu of every model ever published is
 * not that. Anything not listed can still be typed into settings — the field takes
 * a model id, not a member of this list.
 *
 * Deliberately no prices. They change, and a number baked into a menu is a number
 * that quietly goes wrong; the notes say what each model is *for*, which is the
 * thing being chosen between anyway.
 */
export interface AiModelChoice {
  id: string
  label: string
  note: string
}

export const AI_MODELS: AiModelChoice[] = [
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    note: 'The default. Strongest on hard, long-running work.'
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    note: 'Close to Opus on most work, and quicker to answer.'
  },
  {
    // The dated id rather than the family alias: an alias is a promise the API
    // makes and can stop making, and a model name that quietly stops resolving is
    // a wrong answer rather than an error somebody can read.
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    note: 'Fastest and cheapest.'
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    note: 'The previous Opus, for comparing against.'
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    note: 'The most capable there is, and the most expensive.'
  }
]

/*
 * There is no mode here, and that is the point.
 *
 * Manual, Auto and Bypass were offered, and Auto and Bypass were implemented once:
 * an answer carrying a "hard to undo" flag the model set about its own proposal
 * ran on arrival unless it set that flag. Moving Claude into its own panel deleted
 * the running, the flag and the effort field, and left the menu — so for several
 * releases the app asked how much rope to hand a model and then did the same thing
 * whatever the answer. Nothing auto-runs now and nothing offers to. If it ever
 * comes back it goes through the rule about which pane may be typed into and a
 * risk check made here, never a flag a model sets about its own proposal.
 */

/** The listed model with this id, if it is one of them. */
export function modelChoice(id: string): AiModelChoice | undefined {
  return AI_MODELS.find((m) => m.id === id)
}

/** How to name a model that was typed in rather than chosen. */
export function modelLabel(id: string): string {
  return modelChoice(id)?.label ?? id
}
