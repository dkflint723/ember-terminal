/**
 * The Claude models Ember offers, and how hard it asks them to think.
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
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AiModelChoice {
  id: string
  label: string
  note: string
  /**
   * False where the model rejects `effort` outright rather than ignoring it —
   * sending it there is a 400, so the switcher greys the levels out instead.
   */
  effort: boolean
}

export const AI_MODELS: AiModelChoice[] = [
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    note: 'The default. Strongest on hard, long-running work.',
    effort: true
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    note: 'Close to Opus on most work, and quicker to answer.',
    effort: true
  },
  {
    // The dated id rather than the family alias: an alias is a promise the API
    // makes and can stop making, and a model name that quietly stops resolving is
    // a wrong answer rather than an error somebody can read.
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    note: 'Fastest and cheapest. Takes no effort setting.',
    effort: false
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    note: 'The previous Opus, for comparing against.',
    effort: true
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    note: 'The most capable there is, and the most expensive.',
    effort: true
  }
]

export const AI_EFFORTS: { level: AiEffort; note: string }[] = [
  { level: 'low', note: 'Answer quickly. Right for one-line commands.' },
  { level: 'medium', note: 'Some thinking, without the wait.' },
  { level: 'high', note: 'What the API does when nobody says.' },
  { level: 'xhigh', note: 'For coding and multi-step work.' },
  { level: 'max', note: 'Everything it has, when being right matters more.' }
]

/**
 * How much of a command the agent is allowed to run without being asked.
 *
 * This is a setting about a shell, so it is written to be read by someone deciding
 * how much rope to hand over rather than as three interchangeable words. `manual`
 * is the default and the only one where nothing can happen without a press.
 *
 * `auto` leans on the flag main already computes for every proposal: the model is
 * asked to say whether what it is proposing is hard to undo, and anything it marks
 * that way still waits. That flag is a model's judgement rather than a guarantee,
 * which is exactly why the mode that trusts it is not the default.
 */
export type AiMode = 'manual' | 'auto' | 'bypass'

export interface AiModeChoice {
  mode: AiMode
  label: string
  note: string
  /** Worth drawing in the failure colour: this one can do something irreversible. */
  risky?: boolean
}

export const AI_MODES: AiModeChoice[] = [
  { mode: 'manual', label: 'Manual', note: 'Every command waits for you to press Run.' },
  { mode: 'auto', label: 'Auto', note: 'Runs on arrival, unless it looks hard to undo.' },
  {
    mode: 'bypass',
    label: 'Bypass',
    note: 'Runs everything, including what it warned about.',
    risky: true
  }
]

/** The listed mode, falling back to the careful one for anything unrecognised. */
export function modeChoice(mode: string): AiModeChoice {
  return AI_MODES.find((m) => m.mode === mode) ?? AI_MODES[0]
}

/** The listed model with this id, if it is one of them. */
export function modelChoice(id: string): AiModelChoice | undefined {
  return AI_MODELS.find((m) => m.id === id)
}

/** How to name a model that was typed in rather than chosen. */
export function modelLabel(id: string): string {
  return modelChoice(id)?.label ?? id
}

/**
 * Whether to send an effort level for this model at all. Unknown ids are assumed
 * to take one, since every current model does except the one listed above — and a
 * wrong guess here is a clear error message rather than a silent difference.
 */
export function supportsEffort(id: string): boolean {
  return modelChoice(id)?.effort ?? true
}
