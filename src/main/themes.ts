import { app } from 'electron'
import AdmZip from 'adm-zip'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  parseThemeJson,
  resolveTheme,
  type ResolvedTheme,
  type ThemeFile,
  type ThemeSummary
} from '../shared/theme.js'
import { isInside } from '../shared/paths.js'

interface Entry {
  id: string
  file: string
  builtin: boolean
}

/**
 * Discovers themes in the VS Code color-theme format from two places: the ones
 * shipped with the app, and anything the user has dropped into their own themes
 * folder.
 */
export class ThemeStore {
  private cache = new Map<string, ResolvedTheme>()

  private builtinDir(): string {
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    return join(base, 'resources', 'themes')
  }

  userDir(): string {
    const dir = join(app.getPath('userData'), 'themes')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // A themes folder we cannot create just means no user themes.
    }
    return dir
  }

  private entries(): Entry[] {
    const out: Entry[] = []

    const scan = (dir: string, builtin: boolean): void => {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        if (extname(name).toLowerCase() !== '.json') continue
        // User themes are namespaced so they can never shadow a built-in id.
        const id = (builtin ? '' : 'user:') + basename(name, extname(name))
        out.push({ id, file: join(dir, name), builtin })
      }
    }

    scan(this.builtinDir(), true)
    scan(this.userDir(), false)
    return out
  }

  list(): ThemeSummary[] {
    const summaries: ThemeSummary[] = []
    for (const entry of this.entries()) {
      const theme = this.load(entry.id)
      if (theme) {
        summaries.push({
          id: theme.id,
          name: theme.name,
          type: theme.type,
          builtin: entry.builtin
        })
      }
    }
    // Built-ins first, then alphabetical, so the list is stable across launches.
    return summaries.sort(
      (a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)
    )
  }

  load(id: string): ResolvedTheme | null {
    const cached = this.cache.get(id)
    if (cached) return cached

    const entry = this.entries().find((e) => e.id === id)
    if (!entry) return null

    try {
      const file = this.readWithIncludes(entry.file, 0)
      const theme = resolveTheme(id, file)
      this.cache.set(id, theme)
      return theme
    } catch {
      // A malformed theme should never prevent the app from starting.
      return null
    }
  }

  /**
   * Themes may extend another file via `include`, which is how VS Code's own
   * dark_plus/dark_vs pair works. Parents are merged underneath the child so the
   * child's colours win.
   */
  private readWithIncludes(file: string, depth: number): ThemeFile {
    const self = parseThemeJson(readFileSync(file, 'utf8'))
    if (!self.include || depth >= 8) return self

    const parentPath = resolve(dirname(file), self.include)
    if (!existsSync(parentPath)) return self

    const parent = this.readWithIncludes(parentPath, depth + 1)
    return {
      ...parent,
      ...self,
      colors: { ...(parent.colors ?? {}), ...(self.colors ?? {}) },
      tokenColors: [...(parent.tokenColors ?? []), ...(self.tokenColors ?? [])]
    }
  }

  /**
   * Import from a `.vsix`, which is a zip with an extension manifest inside.
   *
   * Only `contributes.themes` is read. An extension's themes are plain JSON in the
   * format this app already understands, so they work with no host to run them —
   * unlike the rest of an extension, which needs code executing to mean anything.
   * Extensions that ship themes alongside code are common (the C# and PowerShell
   * extensions both do), so having code is not a reason to refuse the themes.
   *
   * Each theme is flattened on the way in. A theme may `include` a sibling file,
   * and once it is out of the archive that sibling is not there to include, so the
   * inheritance is resolved while the whole archive is still readable.
   */
  installVsix(sourcePath: string): { ok: boolean; ids?: string[]; error?: string } {
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
        contributes?: { themes?: { label?: string; uiTheme?: string; path?: string }[] }
      }
      const contributed = manifest.contributes?.themes ?? []
      if (contributed.length === 0) {
        return { ok: false, error: 'That extension contributes no colour themes.' }
      }

      const ids: string[] = []
      for (const theme of contributed) {
        if (!theme.path) continue
        // Paths in the manifest are relative to the extension root inside the zip.
        const inside = `extension/${theme.path.replace(/^\.\//, '')}`
        const body = read(inside)
        if (!body) continue

        const resolved = this.flattenFromArchive(body, inside, read)
        if (!resolved) continue

        const slug = safeName(theme.label ?? basename(inside, extname(inside)))
        const target = join(this.userDir(), `${slug}.json`)
        // Same belt-and-braces as the snippet importer: the slug is sanitised, and
        // the result is checked to be where it is supposed to be.
        if (!isInside(this.userDir(), target)) continue
        writeFileSync(target, JSON.stringify(resolved, null, 2), 'utf8')
        ids.push(`user:${slug}`)
      }

      if (ids.length === 0) return { ok: false, error: 'No usable themes in that extension.' }
      this.cache.clear()
      return { ok: true, ids }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read that .vsix.' }
    }
  }

  /**
   * Resolve a theme's `include` chain while the archive is still open, since the
   * files it points at do not travel with it.
   */
  private flattenFromArchive(
    body: string,
    path: string,
    read: (path: string) => string | null,
    depth = 0
  ): Record<string, unknown> | null {
    // Bounded: a theme that includes itself would otherwise recurse forever.
    if (depth > 8) return null
    const self = parseThemeJson(body) as Record<string, unknown> & {
      include?: string
      colors?: Record<string, string>
      tokenColors?: unknown[]
    }
    if (!self.include) return self

    const parentPath = `${dirname(path)}/${self.include}`.replace(/\/\.\//g, '/')
    const parentBody = read(parentPath)
    if (!parentBody) return self

    const parent = this.flattenFromArchive(parentBody, parentPath, read, depth + 1)
    if (!parent) return self

    const merged = { ...parent, ...self }
    delete merged.include
    merged.colors = {
      ...((parent.colors as Record<string, string>) ?? {}),
      ...(self.colors ?? {})
    }
    merged.tokenColors = [
      ...((parent.tokenColors as unknown[]) ?? []),
      ...(self.tokenColors ?? [])
    ]
    return merged
  }

  /** Copy a theme file the user picked into their themes folder. */
  install(sourcePath: string): { ok: boolean; id?: string; error?: string } {
    if (extname(sourcePath).toLowerCase() !== '.json') {
      return { ok: false, error: 'Pick a VS Code theme .json file.' }
    }
    try {
      // Parse before installing so a broken file is rejected up front.
      const parsed = parseThemeJson(readFileSync(sourcePath, 'utf8'))
      if (!parsed.colors && !parsed.include) {
        return { ok: false, error: 'That file has no "colors" section.' }
      }
      const target = join(this.userDir(), basename(sourcePath))
      copyFileSync(sourcePath, target)
      this.cache.clear()
      return { ok: true, id: `user:${basename(sourcePath, extname(sourcePath))}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read that file.' }
    }
  }

  /** Drop memoised themes so edited files are picked up without a restart. */
  refresh(): void {
    this.cache.clear()
  }
}

/** A theme label turned into something safe to use as a file name and an id. */
function safeName(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "theme"
  )
}
