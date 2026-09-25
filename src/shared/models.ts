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
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    note: 'The default. The newest Opus: strongest on hard, long-running work, and cheaper than Opus 5.'
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    note: 'The previous default, for comparing against.'
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
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    note: 'The most capable there is, and the most expensive.'
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    note: 'The previous Opus, for comparing against.'
  }
]

/*
 * What a model does with a request that does not mention thinking.
 *
 * The newer models think whether or not they are asked to — Opus 5 and Sonnet 5 by
 * default, Opus 5.5 and the Fable and Mythos lines always — and what they think is
 * counted against `max_tokens`. A one-line suggestion asked for in a hundred tokens
 * can spend all hundred thinking and come back with nothing to show. So the few
 * places that ask for something short need to know which models these are.
 *
 * Read from the id, not from the list above: a model typed into Settings by hand is
 * held to the same rules as one chosen from the menu.
 */
export function thinksByDefault(id: string): boolean {
  return /^claude-(opus-5|sonnet-5|fable-|mythos-)/.test(id)
}

/**
 * Whether `output_config.effort` is accepted. Opus 4.5 and later, Sonnet 4.6 and
 * later, and the Fable and Mythos lines; Haiku 4.5 and Sonnet 4.5 reject it.
 */
export function takesEffort(id: string): boolean {
  return /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable-|mythos-)/.test(id)
}

/**
 * Whether a declined request can be retried on another model by the API itself.
 *
 * These are the models that run safety classifiers and can answer a request with
 * `stop_reason: "refusal"`; server-side fallback, in its `"default"` form, lets the
 * API rerun a declined request on the model's own configured fallback inside the
 * same call, rather than handing back an empty answer.
 */
export function hasServerFallback(id: string): boolean {
  return /^claude-(opus-5(-5)?|fable-5-1)$/.test(id)
}

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
