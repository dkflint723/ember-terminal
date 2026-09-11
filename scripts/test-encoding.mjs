// Text files in the encodings Windows leaves lying around, read and written back
// as they were. Run: node scripts/test-encoding.mjs
//
// The editor read everything as UTF-8 with replacement characters and wrote UTF-8
// back, so a Windows-1252 file lost every accented letter on its first save, and
// refused UTF-16 outright as binary. Every case here is bytes in, text out, bytes
// back — and the bytes must come back exactly as they went in, including when a
// line nowhere near them was edited.
import { decodeText, encodeText, isEncodingName } from '../src/shared/encoding.ts'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
const hex = (bytes) => Buffer.from(bytes).toString('hex')
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b))
const roundTrip = (label, bytes, encoding) => {
  const decoded = decodeText(bytes)
  check(`${label} is read as ${encoding}`, decoded.encoding === encoding, JSON.stringify(decoded).slice(0, 120))
  if (!('text' in decoded)) return null
  const encoded = encodeText(decoded.text, decoded.encoding)
  check(`${label} is written back byte for byte`, 'bytes' in encoded && same(encoded.bytes, bytes), 'bytes' in encoded ? `${hex(encoded.bytes).slice(0, 60)} vs ${hex(bytes).slice(0, 60)}` : JSON.stringify(encoded))
  return decoded
}

// --- Windows-1252, which strict UTF-8 refuses ---------------------------------------
// café, a euro sign, curly quotes, and the five bytes the code page leaves undefined.
const cp1252 = Uint8Array.from([
  ...Buffer.from('[settings]\r\nname=caf'), 0xe9, 0x0d, 0x0a,
  ...Buffer.from('price='), 0x80, 0x35, 0x0d, 0x0a,
  ...Buffer.from('quote='), 0x93, 0x68, 0x69, 0x94, 0x0d, 0x0a,
  0x81, 0x8d, 0x8f, 0x90, 0x9d, 0x0d, 0x0a
])
const read1252 = roundTrip('a Windows-1252 file', cp1252, 'windows1252')
check('and its é reads as é', read1252?.text.includes('café') === true, JSON.stringify(read1252?.text))
check('and its € as €', read1252?.text.includes('€5') === true, JSON.stringify(read1252?.text))
// The acceptance test: change one line, and every other byte is untouched.
if (read1252) {
  const edited = read1252.text.replace('[settings]', '[options]')
  const back = encodeText(edited, 'windows1252')
  const expected = Uint8Array.from([...Buffer.from('[options]'), ...cp1252.subarray('[settings]'.length)])
  check('editing one line leaves every other byte as it was', 'bytes' in back && same(back.bytes, expected), 'bytes' in back ? hex(back.bytes).slice(-40) : '')
}
const cannot = encodeText('café 日本', 'windows1252')
check('a character Windows-1252 cannot hold is named, not dropped', 'unrepresentable' in cannot && cannot.unrepresentable === '日', JSON.stringify(cannot))
const emoji = encodeText('ok \u{1f600}', 'windows1252')
check('and an emoji is named whole, not as half a pair', 'unrepresentable' in emoji && emoji.unrepresentable === '\u{1f600}', JSON.stringify(emoji))

// --- UTF-16, which a NUL byte used to call binary ------------------------------------
const text16 = 'Get-ChildItem > out.txt\r\ncafé 日本 \u{1f600}\r\n'
const le = Uint8Array.from([0xff, 0xfe, ...Buffer.from(text16, 'utf16le')])
roundTrip('a UTF-16 LE file with its mark', le, 'utf16lebom')
const beBody = Buffer.from(text16, 'utf16le')
beBody.swap16()
const be = Uint8Array.from([0xfe, 0xff, ...beBody])
roundTrip('a UTF-16 BE file with its mark', be, 'utf16bebom')
// PowerShell 5.1 writes a mark; not every tool does. The shape is enough to read
// it by, and a file that had no mark is written back without one.
const bare = Uint8Array.from(Buffer.from('plain text, no mark\r\n'.repeat(20), 'utf16le'))
roundTrip('UTF-16 LE without a mark', bare, 'utf16le')
const bareBe = Buffer.from('plain text, no mark\r\n'.repeat(20), 'utf16le')
bareBe.swap16()
roundTrip('UTF-16 BE without a mark', Uint8Array.from(bareBe), 'utf16be')

// --- UTF-8, with and without a mark -----------------------------------------------------
roundTrip('a UTF-8 file', Uint8Array.from(Buffer.from('const s = "café \u{1f600}"\n')), 'utf8')
roundTrip('a UTF-8 file with a BOM', Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('x = 1\n')]), 'utf8bom')
roundTrip('an empty file', new Uint8Array(0), 'utf8')

// --- and binary stays binary ---------------------------------------------------------------
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0])
check('an image is binary', 'binary' in decodeText(png))
const zeros = new Uint8Array(4096)
check('a page of zeros is binary, not UTF-16', 'binary' in decodeText(zeros))
const brokenMark = Uint8Array.from([0xef, 0xbb, 0xbf, 0xe9, 0x41])
check('a UTF-8 mark over bytes that are not UTF-8 is refused', 'binary' in decodeText(brokenMark))

// --- and the names that come over IPC ---------------------------------------------------
check('an encoding the editor knows is a name', isEncodingName('windows1252') && isEncodingName('utf16lebom'))
check(
  'anything else is not, including what every object has',
  !isEncodingName('latin1') && !isEncodingName('toString') && !isEncodingName(undefined) && !isEncodingName(1)
)

console.log('text encodings:', failures === 0 ? 'PASS' : 'FAIL')
process.exit(failures === 0 ? 0 : 1)
