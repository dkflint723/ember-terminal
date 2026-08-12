import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  parseThemeJson,
  resolveTheme,
  type ResolvedTheme,
  type ThemeFile,
  type ThemeSummary
} from '../shared/theme.js'

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
