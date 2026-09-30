// Accepted proposals, kept so the last can be put back. Run: node scripts/test-journal.mjs
//
// Accepting a proposal was final (audit R27, SE-05). The journal keeps what each wrote
// over and puts the newest back only if the file is still what the proposal left.
// Driven with a stand-in file service, over a real temporary folder.
import './ts-resolve.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
const { AcceptJournal } = await import('../src/main/journal.ts')

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

// Files as a map, stamped by their text: enough to hold compare-and-swap to account.
const disk = new Map()
const stampOf = (text) => ({ size: text.length, hash: `h:${text}`, mtimeMs: 1 })
const trashed = []
const files = {
  read: async (p) => (disk.has(p) ? { ok: true, content: disk.get(p), stamp: stampOf(disk.get(p)), encoding: 'utf8' } : { ok: false, error: 'ENOENT', missing: true }),
  write: async (p, content, opts) => {
    if (opts?.expect && (!disk.has(p) || stampOf(disk.get(p)).hash !== opts.expect.hash)) return { ok: false, conflict: 'changed', error: 'changed' }
    disk.set(p, content)
    return { ok: true, stamp: stampOf(content) }
  },
  trash: async (p) => {
    trashed.push(p)
    disk.delete(p)
    return { ok: true }
  }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-journal-'))
const journal = new AcceptJournal(dir, files)

// An edit: kept, and put back.
disk.set('C:\\p\\a.ts', 'proposed')
check('an accepted edit is kept', 'kept' === await journal.record({ path: 'C:\\p\\a.ts', before: { content: 'original' }, after: stampOf('proposed'), at: 0 }))
check('and named as the last', journal.last()?.path === 'C:\\p\\a.ts')
const back = await journal.revert()
check('revert puts it back', back.ok && disk.get('C:\\p\\a.ts') === 'original', JSON.stringify(back))
check('and it is no longer kept', journal.last() === null)

// Changed since: not overwritten.
disk.set('C:\\p\\b.ts', 'proposed')
await journal.record({ path: 'C:\\p\\b.ts', before: { content: 'original' }, after: stampOf('proposed'), at: 0 })
disk.set('C:\\p\\b.ts', 'someone else’s work')
const refused = await journal.revert()
check('a file changed since is not put back', !refused.ok && disk.get('C:\\p\\b.ts') === 'someone else’s work', JSON.stringify(refused))
check('and stays kept, for after it is sorted out', journal.last()?.path === 'C:\\p\\b.ts')
disk.set('C:\\p\\b.ts', 'proposed')
await journal.revert()

// Created: to the Recycle Bin, not deleted.
disk.set('C:\\p\\new.ts', 'made')
await journal.record({ path: 'C:\\p\\new.ts', before: null, after: stampOf('made'), at: 0 })
const gone = await journal.revert()
check('a file the proposal created goes to the Recycle Bin', gone.ok && trashed.includes('C:\\p\\new.ts') && !disk.has('C:\\p\\new.ts'), JSON.stringify(gone))

// Bounded.
for (let i = 0; i < 25; i += 1) await journal.record({ path: `C:\\p\\${i}.ts`, before: { content: String(i) }, after: stampOf('x'), at: 0 })
const kept = JSON.parse(fs.readFileSync(path.join(dir, 'accepted-changes.json'), 'utf8'))
check('twenty are kept, the newest', kept.length === 20 && kept.at(-1).path === 'C:\\p\\24.ts', String(kept.length))
check('a file too large to keep is said to be', (await journal.record({ path: 'C:\\p\\big', before: { content: 'x'.repeat(3 * 1024 * 1024) }, after: stampOf('y'), at: 0 })) === 'too-large')
const token = 'ghp_' + 'EmberJournalNotARealToken0123456789'.padEnd(36, 'z')
check('a file holding a credential is not kept', (await journal.record({ path: 'C:\\p\\.env', before: { content: `GITHUB_TOKEN=${token}\n` }, after: stampOf('y'), at: 0 })) === 'secret')
check('and no copy of it is anywhere in the journal', !fs.readFileSync(path.join(dir, 'accepted-changes.json'), 'utf8').includes(token))
check('nothing to revert says so', !(await new AcceptJournal(fs.mkdtempSync(path.join(os.tmpdir(), 'ember-journal-')), files).revert()).ok)

fs.rmSync(dir, { recursive: true, force: true })
console.log(`accept journal: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
