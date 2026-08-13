import { app } from 'electron'
import AdmZip from 'adm-zip'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { parseThemeJson } from '../shared/theme.js'
import type { Snippet } from '../shared/types.js'

/**
 * Snippets in the VS Code format, from the user's own folder and from extensions.
 *
 * Like themes, these are data rather than code: a snippet is a prefix and a body,
 * and the body's `${1:placeholder}` syntax is the one Monaco already implements. So
 * they work with nothing to run them, which is what makes them worth importing when
 * whole extensions are not.
 *
 * Two shapes are read. A file named for a language (`typescript.json`) belongs to
 * that language, and a `.code-snippets` file carries a `scope` on each entry. Both
 * are how VS Code stores them, so a folder copied across from it works as it is.
 */
export class SnippetStore {
  private cache: Map<string, Snippet[]> | null = null

  dir(): string {
    const path = join(app.getPath('userData'), 'snippets')
    try {
      mkdirSync(path, { recursive: true })
    } catch {
      // A folder we cannot create just means no snippets.
    }
    return path
  }

  /** Every snippet, indexed by the language it applies to. */
  private all(): Map<string, Snippet[]> {
    if (this.cache) return this.cache

    const byLanguage = new Map<string, Snippet[]>()
    const add = (language: string, snippet: Snippet): void => {
      const list = byLanguage.get(language) ?? []
      list.push(snippet)
      byLanguage.set(language, list)
    }

    let names: string[] = []
    try {
      names = readdirSync(this.dir())
    } catch {
      this.cache = byLanguage
      return byLanguage
    }

    for (const name of names) {
      const lower = name.toLowerCase()
      if (!lower.endsWith('.json') && !lower.endsWith('.code-snippets')) continue

      let parsed: Record<string, unknown>
      try {
        // The same lenient reader the themes use: these files are written by hand
        // and VS Code has always allowed comments and trailing commas in them.
        parsed = parseThemeJson(readFileSync(join(this.dir(), name), 'utf8')) as Record<
          string,
          unknown
        >
      } catch {
        // One unreadable file should not cost the others.
        continue
      }

      const fromFileName = lower.endsWith('.code-snippets')
        ? null
        : basename(name, extname(name)).toLowerCase()

      for (const [label, body] of Object.entries(parsed)) {
        const snippet = toSnippet(label, body)
        if (!snippet) continue
        const scopes = scopeList(body, fromFileName)
        for (const language of scopes) add(language, snippet)
      }
    }

    this.cache = byLanguage
    return byLanguage
  }

  forLanguage(languageId: string): Snippet[] {
    const all = this.all()
    // Entries in a `.code-snippets` file with no scope apply everywhere, which is
    // what VS Code does with them and the reason to write one in the first place.
    return [...(all.get(ANY_LANGUAGE) ?? []), ...(all.get(languageId.toLowerCase()) ?? [])]
  }

  /** Copy a snippet file the user picked into their snippets folder. */
  install(sourcePath: string): { ok: boolean; error?: string } {
    const lower = sourcePath.toLowerCase()
    if (!lower.endsWith('.json') && !lower.endsWith('.code-snippets')) {
      return { ok: false, error: 'Pick a .json or .code-snippets file.' }
    }
    try {
      // Parsed before installing, so a broken file is refused up front rather than
      // silently contributing nothing.
      parseThemeJson(readFileSync(sourcePath, 'utf8'))
      copyFileSync(sourcePath, join(this.dir(), basename(sourcePath)))
      this.cache = null
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read that file.' }
    }
  }

  /**
   * Import the snippets from a `.vsix`.
   *
   * The manifest names a language per file, which is the part that would be lost by
   * simply copying the files out — so each is written under the language it is for.
   */
  installVsix(sourcePath: string): { ok: boolean; count?: number; error?: string } {
    try {
      const zip = new AdmZip(sourcePath)
      const entries = zip.getEntries()
      const read = (path: string): string | null => {
        const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
        const found = entries.find((e) => e.entryName.replace(/\\/g, '/') === normalized)
        return found ? found.getData().toString('utf8') : null
      }

      const manifestText = read('extension/package.json')
      if (!manifestText) return { ok: false, error: 'That does not look like a .vsix.' }

      const manifest = JSON.parse(manifestText) as {
        name?: string
        contributes?: { snippets?: { language?: string; path?: string }[] }
      }
      const contributed = manifest.contributes?.snippets ?? []
      if (contributed.length === 0) {
        return { ok: false, error: 'That extension contributes no snippets.' }
      }

      const from = safeName(manifest.name ?? basename(sourcePath, extname(sourcePath)))
      let count = 0
      for (const entry of contributed) {
        if (!entry.path || !entry.language) continue
        const body = read(`extension/${entry.path.replace(/^\.\//, '')}`)
        if (!body) continue

        let parsed: Record<string, unknown>
        try {
          parsed = parseThemeJson(body) as Record<string, unknown>
        } catch {
          continue
        }

        /*
         * Written as a scoped `.code-snippets` file named after the extension, not
         * as `<language>.json`.
         *
         * Naming it for the language would have been tidier and would have silently
         * overwritten a file the user wrote themselves — importing a TypeScript
         * extension destroying your own typescript.json is not a trade anyone would
         * accept. The language moves onto each entry as a scope instead, which is
         * the format's own way of saying the same thing.
         */
        const scoped: Record<string, unknown> = {}
        for (const [label, snippet] of Object.entries(parsed)) {
          if (typeof snippet !== 'object' || snippet === null) continue
          scoped[label] = { ...(snippet as object), scope: entry.language.toLowerCase() }
        }
        if (Object.keys(scoped).length === 0) continue

        const target = join(this.dir(), `${from}-${safeName(entry.language)}.code-snippets`)
        writeFileSync(target, JSON.stringify(scoped, null, 2), 'utf8')
        count += 1
      }

      if (count === 0) return { ok: false, error: 'No usable snippets in that extension.' }
      this.cache = null
      return { ok: true, count }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read that .vsix.' }
    }
  }
}

/** Snippets that belong to no particular language and are offered in all of them. */
const ANY_LANGUAGE = '*'

/**
 * The languages an entry applies to: its own `scope` if it has one, otherwise the
 * language the file is named for. An entry with neither — which only a
 * `.code-snippets` file can produce — is for every language.
 */
function scopeList(body: unknown, fromFileName: string | null): string[] {
  const scope = (body as { scope?: unknown } | null)?.scope
  if (typeof scope === 'string' && scope.trim()) {
    return scope
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  }
  return [fromFileName ?? ANY_LANGUAGE]
}

/** A name safe to use as a file name, so an extension cannot pick its own path. */
function safeName(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'snippets'
  )
}

function toSnippet(label: string, body: unknown): Snippet | null {
  if (typeof body !== 'object' || body === null) return null
  const entry = body as { prefix?: unknown; body?: unknown; description?: unknown }

  const prefix = Array.isArray(entry.prefix)
    ? entry.prefix.find((p) => typeof p === 'string')
    : entry.prefix
  if (typeof prefix !== 'string' || !prefix) return null

  // A body is a list of lines or one string already containing them.
  const text = Array.isArray(entry.body)
    ? entry.body.filter((l) => typeof l === 'string').join('\n')
    : entry.body
  if (typeof text !== 'string' || !text) return null

  return {
    label,
    prefix,
    body: text,
    description: typeof entry.description === 'string' ? entry.description : null
  }
}
