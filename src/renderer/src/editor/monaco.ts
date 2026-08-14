/**
 * Monaco setup.
 *
 * Monaco 0.56 exposes a package `exports` map that rewrites subpaths, so the
 * familiar `monaco-editor/esm/vs/...` specifiers resolve to the wrong place — the
 * root import is the supported entry point and it registers every bundled language
 * on its own.
 *
 * Language services run in web workers. Vite compiles each `?worker` import into a
 * real file at build time, so they load same-origin and satisfy the page's CSP;
 * that is why the workers are wired up explicitly rather than left to Monaco's
 * default loader, which would fetch them at runtime.
 */
import * as monaco from 'monaco-editor'
import { pathKey } from '@shared/paths'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'

window.MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    switch (label) {
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      default:
        return new EditorWorker()
    }
  }
}

/** Language ids Monaco knows, matched against a file's extension. */
export function languageForPath(filePath: string): string {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot === -1 ? '' : lower.slice(dot)

  // Files identified by name rather than extension.
  const base = lower.split(/[\\/]/).pop() ?? ''
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  if (base.startsWith('.gitignore') || base.startsWith('.npmignore')) return 'plaintext'

  for (const language of monaco.languages.getLanguages()) {
    if (language.extensions?.some((e) => e.toLowerCase() === ext)) return language.id
    if (language.filenames?.some((f) => f.toLowerCase() === base)) return language.id
  }
  return 'plaintext'
}

/**
 * The URI a file's editor buffer is keyed by.
 *
 * It has to be the same spelling the language server sees, because that is what
 * comes back in a definition, a reference or a rename. The transport canonicalises
 * every file URI crossing it to lower case, so a model keyed by the path as
 * Windows spells it — `D:\git_projects\…` — could never be found from a server's
 * reply, and Go to Definition failed even within a single file.
 *
 * Matching `pathKey` exactly matters: a buffer keyed one way and compared another
 * is how one file ends up with two models.
 */
export function modelUri(filePath: string): monaco.Uri {
  return monaco.Uri.file(pathKey(filePath))
}

export { monaco }
