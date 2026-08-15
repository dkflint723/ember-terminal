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
    id: 'claude-haiku-4-5',
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
    id: 'claude-fable-5',
    label: 'Fable 5',
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
