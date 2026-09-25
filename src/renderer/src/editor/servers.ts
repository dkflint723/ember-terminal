import { useStore } from '../state/store'

/*
 * Which language server answers for which language — a table and a lookup, kept
 * apart from the client in lsp.ts because that module brings Monaco with it, and
 * the outline in the sidebar only needs to know which server to ask.
 */

/**
 * Monaco language ids that have a server, mapped to the server's id. Several
 * Monaco languages share one server, and some need none: Monaco's bundled
 * TypeScript worker already covers javascript.
 */
export const SERVER_FOR: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'typescript',
  typescriptreact: 'typescript',
  javascriptreact: 'typescript',
  python: 'python',
  // Monaco calls this 'shell'; VS Code calls it 'shellscript'. The key is Monaco's.
  shell: 'shell',
  yaml: 'yaml',
  powershell: 'powershell'
}

/**
 * A server taught in settings answers for its languageId directly — the id is
 * both the Monaco language and the main-process server key. Consulted after
 * the bundled table so the built-in four keep their shared-server mappings.
 */
export function taughtServerFor(language: string): string | null {
  const taught = useStore
    .getState()
    .settings.languageServers?.some((c) => c.languageId === language)
  return taught ? language : null
}

export function serverFor(language: string): string | null {
  return SERVER_FOR[language] ?? taughtServerFor(language)
}
