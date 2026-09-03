/*
 * Which local model should Ember recommend for ghost text?
 *
 * Not a published benchmark — the research was explicit that HumanEval-Infilling
 * ranks these models in the opposite order from how they behave in an editor. So
 * this is the actual task, on the actual codebase: take a real line out of a real
 * file, hand the model everything before it and everything after it, and see
 * whether it puts back what was there.
 *
 * Scored three ways, because "exact" is too harsh for code that has more than one
 * right spelling: exact after trimming, the first token, and a crude similarity.
 * Latency is measured warm, after the model is already in VRAM.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/*
 * Each with the shape it actually understands, which is not the same for all of
 * them and is the reason the first run of this scored two of them at zero.
 *
 * Ollama's /api/generate takes a suffix field and applies the model's own
 * template — but only where it has one registered, and it flatly refuses for a
 * community GGUF ("does not support insert"). Those need raw sentinels through
 * /v1/completions, and the spelling differs by family: Qwen and StarCoder use
 * different tokens, and sending one family's to the other produces confident
 * nonsense rather than an error.
 */
const MODELS = [
  { name: 'qwen2.5-coder:1.5b', shape: 'suffix' },
  { name: 'qwen2.5-coder:7b', shape: 'suffix' },
  { name: 'qwen2.5-coder:14b', shape: 'suffix' },
  { name: 'qwen3-coder:30b', shape: 'raw' }
]

const SRC = 'D:/git_projects/terminal/src'
const SAMPLES = 150
const PREFIX_CHARS = 3000
const SUFFIX_CHARS = 1000

/** Every .ts/.tsx file under src, so the sample is this project's own code. */
function sources(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * A line worth predicting: real code, indented (so it is inside something), long
 * enough to be a claim rather than a brace, and with room either side of it.
 */
function pickSamples() {
  const files = sources(SRC)
  const picked = []
  let seed = 7
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

  while (picked.length < SAMPLES && files.length > 0) {
    const file = files[Math.floor(next() * files.length)]
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n')
    if (lines.length < 60) continue

    const at = 20 + Math.floor(next() * (lines.length - 40))
    const line = lines[at]
    if (!/^\s+\S/.test(line)) continue
    if (line.trim().length < 18) continue
    if (/^\s*[/*]/.test(line)) continue // comments are prose, not prediction

    const before = lines.slice(0, at).join('\n')
    const after = lines.slice(at + 1).join('\n')
    picked.push({
      file: path.basename(file),
      line: at + 1,
      expected: line,
      prefix: before.slice(-PREFIX_CHARS) + '\n',
      suffix: '\n' + after.slice(0, SUFFIX_CHARS)
    })
  }
  return picked
}

async function ask(model, sample) {
  const started = Date.now()

  if (model.shape === 'suffix') {
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.name,
        prompt: sample.prefix,
        suffix: sample.suffix,
        stream: false,
        options: { temperature: 0, num_predict: 64 }
      })
    })
    const json = await res.json()
    return { ms: Date.now() - started, text: String(json.response ?? '') }
  }

  /*
   * Qwen3-Coder refuses the suffix field outright — Ollama answers "does not
   * support insert", because the instruct model ships no infill template. It was
   * still trained on the sentinels, so they work when sent raw, with the chat
   * template switched off. Which is the whole question this row exists to answer:
   * whether a model that has to be driven the hard way earns it.
   */
  if (model.shape === 'raw') {
    const prompt =
      '<|fim_prefix|>' + sample.prefix + '<|fim_suffix|>' + sample.suffix + '<|fim_middle|>'
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.name,
        prompt,
        raw: true,
        stream: false,
        options: {
          temperature: 0,
          num_predict: 64,
          stop: ['<|fim_pad|>', '<|endoftext|>', '<|fim_prefix|>', '<|file_sep|>', '<|im_end|>']
        }
      })
    })
    const json = await res.json()
    return { ms: Date.now() - started, text: String(json.response ?? '') }
  }

  const prompt =
    '<fim_prefix>' + sample.prefix + '<fim_suffix>' + sample.suffix + '<fim_middle>'
  const res = await fetch('http://127.0.0.1:11434/v1/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model.name,
      prompt,
      max_tokens: 64,
      temperature: 0,
      stop: ['<file_sep>', '<|endoftext|>', '<fim_prefix>']
    })
  })
  const json = await res.json()
  return { ms: Date.now() - started, text: String(json.choices?.[0]?.text ?? '') }
}

/** The same trim Ember applies before showing anything. */
function firstLine(text) {
  return text.replace(/^\n+/, '').split('\n')[0] ?? ''
}

function similarity(a, b) {
  const x = a.trim()
  const y = b.trim()
  if (!x || !y) return 0
  let same = 0
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] === y[i]) same++
  return same / Math.max(x.length, y.length)
}

const samples = pickSamples()
console.log(`${samples.length} samples from ${SRC}\n`)

const table = []
for (const model of MODELS) {
  // Warm it, so the first sample does not pay for loading into VRAM.
  await ask(model, samples[0]).catch(() => null)

  let exact = 0
  let firstToken = 0
  let simTotal = 0
  const times = []
  let failed = 0

  for (const sample of samples) {
    try {
      const { ms, text } = await ask(model, sample)
      times.push(ms)
      const got = firstLine(text)
      if (got.trim() === sample.expected.trim()) exact++
      const wantTok = sample.expected.trim().split(/[\s(.]/)[0]
      const gotTok = got.trim().split(/[\s(.]/)[0]
      if (wantTok && wantTok === gotTok) firstToken++
      simTotal += similarity(got, sample.expected)
    } catch {
      failed++
    }
  }

  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)] ?? 0
  table.push({
    model: model.name.replace('hf.co/mradermacher/', '').replace('-GGUF:latest', ''),
    exact: Math.round((exact / samples.length) * 100),
    firstToken: Math.round((firstToken / samples.length) * 100),
    similarity: Math.round((simTotal / samples.length) * 100),
    medianMs: median,
    p90Ms: times[Math.floor(times.length * 0.9)] ?? 0,
    failed
  })
  console.log(
    `${table[table.length - 1].model.padEnd(34)} exact ${String(table[table.length - 1].exact).padStart(3)}%   ` +
      `first-token ${String(table[table.length - 1].firstToken).padStart(3)}%   ` +
      `similarity ${String(table[table.length - 1].similarity).padStart(3)}%   ` +
      `median ${String(median).padStart(5)}ms   p90 ${String(table[table.length - 1].p90Ms).padStart(5)}ms` +
      (failed ? `   (${failed} failed)` : '')
  )
}

fs.writeFileSync(
  'D:/git_projects/terminal/.shots/bakeoff.json',
  JSON.stringify({ samples: samples.length, table }, null, 2)
)
