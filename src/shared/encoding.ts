/**
 * Text files in the encodings Windows actually leaves lying around, read and
 * written back as they were.
 *
 * The editor read every file as UTF-8 with replacement characters for anything
 * else, and wrote UTF-8 back. A Windows-1252 .ini or .csv holding "café" opened
 * as "caf�", looked unmodified, and the first save of an unrelated line
 * wrote EF BF BD over the é for good. And a NUL byte meant "binary", so every
 * UTF-16 file — what Windows PowerShell 5.1's `>` writes — was refused outright.
 *
 * Without a full code-page library this covers what is common on a Western
 * Windows machine: UTF-8, and UTF-16 in either byte order, each with or without a
 * byte-order mark, and Windows-1252 as the fallback for bytes that are not UTF-8.
 * Anything else is refused rather than guessed at, since a wrong guess is a
 * corrupted save.
 *
 * Platform-neutral on purpose — no Buffer — so the renderer can ask what a text
 * can be saved as, and Node can test all of it without a window.
 */

/** An encoding and whether the file carries a byte-order mark: both come back on save. */
export type TextEncodingName =
  | 'utf8'
  | 'utf8bom'
  | 'utf16le'
  | 'utf16lebom'
  | 'utf16be'
  | 'utf16bebom'
  | 'windows1252'

/** What the encodings are called where a person reads them. */
export const ENCODING_LABELS: Record<TextEncodingName, string> = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 with BOM',
  utf16le: 'UTF-16 LE',
  utf16lebom: 'UTF-16 LE with BOM',
  utf16be: 'UTF-16 BE',
  utf16bebom: 'UTF-16 BE with BOM',
  windows1252: 'Windows-1252'
}

/** Whether a value that came over IPC names one of these encodings. */
export function isEncodingName(value: unknown): value is TextEncodingName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ENCODING_LABELS, value)
}

export type Decoded = { text: string; encoding: TextEncodingName } | { binary: true }

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const strictUtf16le = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true })
const strictUtf16be = new TextDecoder('utf-16be', { fatal: true, ignoreBOM: true })
const windows1252 = new TextDecoder('windows-1252')

/**
 * Whether bytes with no byte-order mark look like UTF-16, and in which order.
 *
 * UTF-16 text in any Latin script is mostly one zero byte per character, all on the
 * same side of each pair. Asked of the first few kilobytes only, with a margin
 * wide enough that binary data — which has zeros everywhere, or nowhere in
 * particular — does not pass for it.
 */
function utf16Order(bytes: Uint8Array): 'utf16le' | 'utf16be' | null {
  const sample = Math.min(bytes.length, 4096) & ~1
  if (sample < 4) return null
  let evenZeros = 0
  let oddZeros = 0
  for (let i = 0; i < sample; i += 2) {
    if (bytes[i] === 0) evenZeros++
    if (bytes[i + 1] === 0) oddZeros++
  }
  const pairs = sample / 2
  if (oddZeros / pairs > 0.4 && evenZeros / pairs < 0.05) return 'utf16le'
  if (evenZeros / pairs > 0.4 && oddZeros / pairs < 0.05) return 'utf16be'
  return null
}

/**
 * Bytes as text, and the encoding to save them back in — or binary, for bytes
 * that are none of the encodings above.
 *
 * In this order: a byte-order mark says what it is; then the UTF-16 shape; then a
 * NUL anywhere early means binary; then strict UTF-8, which almost never accepts
 * bytes that were meant as anything else; and Windows-1252 for what is left,
 * which decodes every byte and so is only ever the last resort.
 */
export function decodeText(bytes: Uint8Array): Decoded {
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: strictUtf8.decode(bytes.subarray(3)), encoding: 'utf8bom' }
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: strictUtf16le.decode(bytes.subarray(2)), encoding: 'utf16lebom' }
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: strictUtf16be.decode(bytes.subarray(2)), encoding: 'utf16bebom' }
    }
    const order = utf16Order(bytes)
    if (order === 'utf16le') return { text: strictUtf16le.decode(bytes), encoding: 'utf16le' }
    if (order === 'utf16be') return { text: strictUtf16be.decode(bytes), encoding: 'utf16be' }
  } catch {
    // A mark or a shape that promised UTF-16 or UTF-8 and did not deliver it is not
    // a text file this can hold faithfully.
    return { binary: true }
  }
  if (bytes.subarray(0, 8192).includes(0)) return { binary: true }
  try {
    return { text: strictUtf8.decode(bytes), encoding: 'utf8' }
  } catch {
    return { text: windows1252.decode(bytes), encoding: 'windows1252' }
  }
}

/*
 * Windows-1252's upper half, char to byte, taken from the decoder itself so the
 * encoder is its exact inverse — including the five bytes the code page leaves
 * undefined, which the decoder passes through as C1 controls and which therefore
 * come back as the bytes they were.
 */
const HIGH_1252 = new Map<number, number>()
{
  const upper = windows1252.decode(Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i))
  for (let i = 0; i < upper.length; i++) HIGH_1252.set(upper.charCodeAt(i), 0x80 + i)
}

export type Encoded = { bytes: Uint8Array } | { unrepresentable: string }

/**
 * Text as bytes in an encoding, or the first character that encoding cannot
 * hold — which is the question to ask the person, not a thing to drop quietly.
 */
export function encodeText(text: string, encoding: TextEncodingName): Encoded {
  if (encoding === 'utf8' || encoding === 'utf8bom') {
    const body = new TextEncoder().encode(text)
    if (encoding === 'utf8') return { bytes: body }
    const bytes = new Uint8Array(body.length + 3)
    bytes.set([0xef, 0xbb, 0xbf], 0)
    bytes.set(body, 3)
    return { bytes }
  }
  if (encoding !== 'windows1252') {
    // UTF-16. The byte-order mark goes back if the file had one and stays off if it
    // did not: either way the bytes come back as they were.
    const le = encoding === 'utf16le' || encoding === 'utf16lebom'
    const mark = encoding === 'utf16lebom' || encoding === 'utf16bebom' ? 2 : 0
    const bytes = new Uint8Array(mark + text.length * 2)
    if (mark > 0) {
      bytes[0] = le ? 0xff : 0xfe
      bytes[1] = le ? 0xfe : 0xff
    }
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i)
      bytes[mark + i * 2] = le ? unit & 0xff : unit >> 8
      bytes[mark + i * 2 + 1] = le ? unit >> 8 : unit & 0xff
    }
    return { bytes }
  }
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes[i] = code
    else {
      const byte = HIGH_1252.get(code)
      if (byte === undefined) return { unrepresentable: String.fromCodePoint(text.codePointAt(i) ?? code) }
      bytes[i] = byte
    }
  }
  return { bytes }
}
