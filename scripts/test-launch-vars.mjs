// Variables in a launch.json. Run: node scripts/test-launch-vars.mjs
//
// Only five were substituted; the rest reached the debugger as literal text (audit
// R16, DA-05). EMBER_OLD_RULE=1 runs the cases against that five-variable rule,
// copied as it was, to show they catch it.
import { resolveEnvVariables, resolveLaunchVariables } from '../src/shared/launch-vars.ts'

/** The rule debug.ts had, copied as it was, answering the same shape. */
function oldRule(value, ctx) {
  const dirnameOf = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')))
  const walk = (v) => {
    if (typeof v === 'string') {
      return v
        .replace(/\$\{workspaceFolder\}/g, ctx.workspace)
        .replace(/\$\{workspaceFolderBasename\}/g, ctx.workspace.split(/[\\/]/).pop() ?? '')
        .replace(/\$\{file\}/g, ctx.file ?? '')
        .replace(/\$\{fileBasename\}/g, ctx.file?.split(/[\\/]/).pop() ?? '')
        .replace(/\$\{fileDirname\}/g, ctx.file ? dirnameOf(ctx.file) : '')
    }
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return { ok: true, value: walk(value) }
}
const resolve = process.env.EMBER_OLD_RULE ? oldRule : resolveLaunchVariables

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const ctx = {
  workspace: 'C:\\work\\proj',
  file: 'C:\\work\\proj\\src\\app.test.js',
  line: 12,
  selection: 'answer',
  home: 'C:\\Users\\someone'
}
const one = (s) => {
  const r = resolve(s, ctx)
  return r.ok ? r.value : `REFUSED ${r.unsupported.join(',')}`
}

// --- the five that always worked still do -----------------------------------------
check('workspaceFolder', one('${workspaceFolder}\\x') === 'C:\\work\\proj\\x', one('${workspaceFolder}\\x'))
check('file', one('${file}') === ctx.file)
check('fileDirname', one('${fileDirname}') === 'C:\\work\\proj\\src')

// --- the ones that passed through as text ----------------------------------------
check('userHome', one('${userHome}\\.config') === 'C:\\Users\\someone\\.config', one('${userHome}\\.config'))
check('fileBasenameNoExtension', one('${fileBasenameNoExtension}') === 'app.test', one('${fileBasenameNoExtension}'))
check('fileExtname', one('${fileExtname}') === '.js', one('${fileExtname}'))
check('relativeFile', one('${relativeFile}') === 'src\\app.test.js', one('${relativeFile}'))
check('relativeFileDirname', one('${relativeFileDirname}') === 'src', one('${relativeFileDirname}'))
check('fileDirnameBasename', one('${fileDirnameBasename}') === 'src', one('${fileDirnameBasename}'))
check('lineNumber', one('${lineNumber}') === '12', one('${lineNumber}'))
check('selectedText', one('${selectedText}') === 'answer', one('${selectedText}'))
check('pathSeparator', one('a${pathSeparator}b') === 'a\\b' && one('a${/}b') === 'a\\b', one('a${/}b'))
check('cwd', one('${cwd}') === 'C:\\work\\proj', one('${cwd}'))
check('nested in arrays and objects', JSON.stringify(resolve({ args: ['${fileBasenameNoExtension}'], env: { H: '${userHome}' } }, ctx)) === JSON.stringify({ ok: true, value: { args: ['app.test'], env: { H: 'C:\\Users\\someone' } } }))

// --- the ones that cannot be known refuse, by name ---------------------------------
check('a ${command:…} refuses the launch, naming it', one('${command:pickProcess}') === 'REFUSED ${command:pickProcess}', one('${command:pickProcess}'))
check('an ${input:…} refuses too', one('${input:port}') === 'REFUSED ${input:port}', one('${input:port}'))
check('and an unknown one', one('${nonsense}') === 'REFUSED ${nonsense}', one('${nonsense}'))

// --- ${env:…} is left for main, which resolves it ----------------------------------
check('${env:…} passes the window untouched', one('${env:PATH}') === '${env:PATH}', one('${env:PATH}'))
const env = { Path: 'C:\\bin', HOMEDRIVE: 'C:' }
check('main resolves it, without case', resolveEnvVariables('${env:PATH};${env:homedrive}', env) === 'C:\\bin;C:', String(resolveEnvVariables('${env:PATH};${env:homedrive}', env)))
check('an unset one is empty, as in VS Code', resolveEnvVariables('[${env:NOPE}]', env) === '[]')

console.log(`launch variables: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
