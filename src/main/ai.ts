import Anthropic from '@anthropic-ai/sdk'
import type { AiRequest, AiResponse } from '../shared/types.js'
import type { SettingsStore } from './settings.js'

/**
 * Command generation is latency-sensitive and produces a couple of lines of
 * output, so we run adaptive thinking at low effort. (Disabling thinking outright
 * on Opus 5 risks leaking `<thinking>` tags into the visible response, and low
 * effort already gets most of the token and latency saving.)
 */
const EFFORT = 'low'

/**
 * `max_tokens` caps thinking plus response text together, so this is deliberately
 * far above the size of the answer itself — it is a ceiling, not a target.
 */
const MAX_TOKENS = 8192

const COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'A single runnable command line for the requested shell. No prose, no markdown fences, no leading prompt characters.'
    },
    note: {
      type: 'string',
      description:
        'One short sentence explaining what the command does, or naming the risk if it is destructive.'
    },
    destructive: {
      type: 'boolean',
      description:
        'True when the command deletes data, overwrites files, changes permissions, or is otherwise hard to undo.'
    }
  },
  required: ['command', 'note', 'destructive'],
  additionalProperties: false
}

function commandSystemPrompt(shell: string, cwd: string): string {
  return [
    `You translate a natural-language request into one runnable command line for ${shell} on Windows.`,
    `The user's working directory is ${cwd}.`,
    '',
    'Emit the command that a competent user of this shell would actually type: use the',
    'idioms of the target shell rather than a generic POSIX equivalent, and prefer the',
    'tools most likely to be installed over ones the user may not have.',
    '',
    'Put the whole thing on one line. If the request genuinely needs several steps, chain',
    'them with the operator this shell uses. When a request is ambiguous, pick the reading',
    'a careful colleague would and say which one you chose in the note.',
    '',
    'Set destructive to true whenever running the command could lose work — deletions,',
    'overwrites, force pushes, recursive permission changes — so the UI can warn first.'
  ].join('\n')
}

function explainSystemPrompt(shell: string): string {
  return [
    `You explain ${shell} command failures to the person who just hit one.`,
    '',
    'Lead with the cause in one sentence, then give the fix as a command they can run.',
    'Keep it to a short paragraph: they are in the middle of something, not reading a manual.',
    'If the output does not actually say why it failed, name the most likely cause and how',
    'to confirm it rather than guessing at a fix.'
  ].join('\n')
}

function buildUserMessage(req: AiRequest): string {
  const parts: string[] = []

  if (req.recent && req.recent.length > 0) {
    parts.push('Recent commands from this session:')
    for (const r of req.recent) {
      // Cap each block: a runaway build log would otherwise dominate the request.
      const output = r.output.length > 4000 ? `${r.output.slice(0, 4000)}\n…[truncated]` : r.output
      parts.push(`$ ${r.command}\n(exit ${r.exitCode})\n${output}`)
    }
    parts.push('')
  }

  parts.push(req.mode === 'command' ? `Request: ${req.intent}` : req.intent)
  return parts.join('\n')
}

export class AiService {
  constructor(private settings: SettingsStore) {}

  async run(req: AiRequest): Promise<AiResponse> {
    const apiKey = this.settings.resolveApiKey()
    if (!apiKey) {
      return {
        ok: false,
        error:
          'No Anthropic API key. Set one in Settings, or export ANTHROPIC_API_KEY before launching.'
      }
    }

    // Bounded on purpose. Someone waiting on a one-line command has given up long
    // before a default timeout would fire, and the composer is disabled while the
    // request is in flight — an unbounded call is indistinguishable from a hang.
    const client = new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 })
    const model = this.settings.get().aiModel

    try {
      const message = await this.create(client, model, req)

      // A terminal assistant sits close to topics the safety classifiers watch,
      // so a refusal is a normal outcome here rather than an exceptional one.
      // It arrives as a successful response with an empty or partial content
      // array, so this has to be checked before reading any block.
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category ?? 'unspecified'
        return {
          ok: false,
          error: `Claude declined this request (${category}). Rephrasing it usually helps.`
        }
      }

      if (message.stop_reason === 'max_tokens') {
        return { ok: false, error: 'The response was cut off before it finished. Try again.' }
      }

      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()

      if (text.length === 0) {
        return { ok: false, error: 'Claude returned an empty response.' }
      }

      if (req.mode === 'explain') return { ok: true, explanation: text }

      return this.parseCommand(text)
    } catch (err) {
      return { ok: false, error: this.describeError(err) }
    }
  }

  private async create(
    client: Anthropic,
    model: string,
    req: AiRequest
  ): Promise<Anthropic.Beta.BetaMessage> {
    const system =
      req.mode === 'command'
        ? commandSystemPrompt(req.shell, req.cwd)
        : explainSystemPrompt(req.shell)

    const outputConfig: Record<string, unknown> = { effort: EFFORT }
    if (req.mode === 'command') {
      outputConfig.format = { type: 'json_schema', schema: COMMAND_SCHEMA }
    }

    const params = {
      model,
      max_tokens: MAX_TOKENS,
      system,
      thinking: { type: 'adaptive' as const },
      output_config: outputConfig,
      messages: [{ role: 'user' as const, content: buildUserMessage(req) }]
    }

    // Route refusals to a model with broader availability rather than surfacing
    // them to the user. `fallbacks: "default"` lets the server pick the right
    // substitute per refusal category, so there is no model list to maintain.
    try {
      return await client.beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default'
      } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming)
    } catch (err) {
      // If this deployment does not accept the fallback beta, the feature should
      // still work — just without the automatic retry.
      if (!this.isFallbackUnsupported(err)) throw err
      return (await client.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming
      )) as unknown as Anthropic.Beta.BetaMessage
    }
  }

  private isFallbackUnsupported(err: unknown): boolean {
    if (!(err instanceof Anthropic.BadRequestError)) return false
    return /fallback|beta/i.test(err.message)
  }

  private parseCommand(text: string): AiResponse {
    try {
      const parsed = JSON.parse(text) as { command?: string; note?: string; destructive?: boolean }
      if (typeof parsed.command !== 'string' || parsed.command.trim().length === 0) {
        return { ok: false, error: 'Claude did not return a command.' }
      }
      const note = parsed.destructive
        ? `⚠ ${parsed.note ?? 'This command is destructive.'}`
        : parsed.note
      return { ok: true, command: parsed.command.trim(), explanation: note }
    } catch {
      // Structured outputs should make this unreachable, but a malformed body
      // must not take the whole feature down.
      return { ok: false, error: 'Could not read the command Claude returned.' }
    }
  }

  private describeError(err: unknown): string {
    if (err instanceof Anthropic.AuthenticationError) {
      return 'That API key was rejected. Check it in Settings.'
    }
    if (err instanceof Anthropic.RateLimitError) {
      return 'Rate limited. Wait a moment and try again.'
    }
    if (err instanceof Anthropic.NotFoundError) {
      return 'That model is unavailable to this key. Pick another in Settings.'
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return 'Could not reach the Anthropic API. Check your connection.'
    }
    if (err instanceof Anthropic.APIError) {
      return `Anthropic API error${err.status ? ` (${err.status})` : ''}: ${err.message}`
    }
    return err instanceof Error ? err.message : 'Unknown error contacting Claude.'
  }
}
