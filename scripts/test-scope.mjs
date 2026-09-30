// Where a window's file requests are expected to go. Run: node scripts/test-scope.mjs
//
// Main noted nothing about where file requests went, and would have refused none
// (audit R25). scope.ts notes each one outside a window's workspace roots and dialog
// picks; this holds it to noting the right ones, once each, and never refusing.
import './ts-resolve.mjs'
const { PathScope } = await import('../src/main/scope.ts')

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const notes = []
// A stand-in for longPath: the one short name this test uses, expanded.
const canonical = (p) => p.replace(/PROGRA~1/i, 'Program Files')
const scope = new PathScope(() => ['C:\\Users\\me\\AppData\\Roaming\\Ember'], canonical, (line) => notes.push(line))
scope.setRoots(1, ['C:\\work\\proj', 42, ''])
scope.pick(1, 'D:\\notes\\todo.md')
scope.pick(2, 'E:\\other')

check('a file in a root is within', scope.within(1, 'c:/WORK/proj/src/a.ts'))
check('the root itself is within', scope.within(1, 'C:\\work\\proj'))
check('a sibling that shares a prefix is not', !scope.within(1, 'C:\\work\\project2\\a.ts'))
check('a picked file is within', scope.within(1, 'D:\\notes\\todo.md'))
check('its neighbour is not', !scope.within(1, 'D:\\notes\\other.md'))
check('user data is within for every window', scope.within(3, 'C:\\Users\\me\\AppData\\Roaming\\Ember\\settings.json'))
check('another window’s pick is not this one’s', !scope.within(1, 'E:\\other\\x'))
check('non-strings in the roots are ignored', !scope.within(1, '42\\x'))
scope.setRoots(4, ['C:\\PROGRA~1\\App'])
check('a root named by its short name covers the long one', scope.within(4, 'C:\\Program Files\\App\\a.txt'))

check('outside is noted, and still allowed', scope.check(1, 'file:write', 'C:\\Windows\\x.txt', 'write') === true && notes.length === 1, JSON.stringify(notes))
check('with the channel, the access and the path', /file:write \(write\) from window 1: C:\\Windows\\x\.txt/.test(notes[0] ?? ''), notes[0])
scope.check(1, 'file:write', 'c:/windows/X.TXT', 'write')
check('once per window, channel and path', notes.length === 1, JSON.stringify(notes))
scope.check(1, 'file:read', 'C:\\Windows\\x.txt', 'read')
check('a different channel is noted again', notes.length === 2)
scope.check(1, 'file:read', 'C:\\work\\proj\\a.ts', 'read')
check('inside is not noted', notes.length === 2)
scope.check(1, 'file:read', undefined, 'read')
check('a path that is not a string is left to the handler', notes.length === 2)
scope.forget(1)
check('a closed window’s roots go with it', !scope.within(1, 'C:\\work\\proj\\a.ts'))

console.log(`scope: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
