// Imported first by a unit table that loads main's or shared's TypeScript directly.
//
// Those sources import each other by their compiled names (`../shared/secrets.js`),
// which Node's type stripping does not map back to the .ts on disk. This does only
// that: a relative `.js` that does not exist, beside a `.ts` that does.
import * as fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const js = new URL(specifier, context.parentURL)
      const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (!fs.existsSync(fileURLToPath(js)) && fs.existsSync(fileURLToPath(ts))) {
        return next(ts.href, context)
      }
    }
    return next(specifier, context)
  }
})
