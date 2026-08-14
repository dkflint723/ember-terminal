import type { ResolvedTheme, TokenColor } from '@shared/theme'
import { monaco } from './monaco'

export const MONACO_THEME_ID = 'ember'

/**
 * Monaco's rule tokens come from its own tokenizers and use short names
 * (`comment`, `string`, `number`), while a VS Code theme carries full TextMate
 * scopes (`constant.numeric.hex`). This maps between them: each Monaco token is
 * paired with the scope prefixes that should colour it, and the theme's most
 * specific matching entry wins.
 *
 * Adopting the VS Code theme format for the terminal already carried `tokenColors`
 * along for free, so the editor is themed by the same file the chrome is.
 */
const TOKEN_SCOPES: [monacoToken: string, scopes: string[]][] = [
  ['comment', ['comment']],
  ['string', ['string']],
  ['string.escape', ['constant.character.escape', 'string']],
  ['number', ['constant.numeric', 'constant']],
  ['regexp', ['string.regexp', 'string']],
  ['keyword', ['keyword']],
  ['operator', ['keyword.operator', 'keyword']],
  ['delimiter', ['punctuation', 'keyword.operator']],
  ['type', ['entity.name.type', 'support.type', 'storage.type']],
  ['type.identifier', ['entity.name.type', 'support.type']],
  ['identifier', ['variable']],
  ['variable', ['variable']],
  ['variable.predefined', ['variable.language', 'variable']],
  ['function', ['entity.name.function', 'support.function']],
  ['tag', ['entity.name.tag']],
  ['attribute.name', ['entity.other.attribute-name']],
  ['attribute.value', ['string']],
  ['constant', ['constant.language', 'constant']],
  ['invalid', ['invalid']]
]

function scopeList(entry: TokenColor): string[] {
  if (Array.isArray(entry.scope)) return entry.scope
  if (typeof entry.scope === 'string') {
    return entry.scope.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return []
}

/** The theme entry whose scope best matches one of `wanted`, most specific first. */
function findEntry(tokenColors: TokenColor[], wanted: string[]): TokenColor | null {
  let best: { entry: TokenColor; score: number } | null = null

  for (const entry of tokenColors) {
    for (const scope of scopeList(entry)) {
      for (let i = 0; i < wanted.length; i++) {
        const target = wanted[i]
        if (scope !== target && !scope.startsWith(`${target}.`) && !target.startsWith(`${scope}.`)) {
          continue
        }
        // Earlier entries in `wanted` are preferred; longer scopes are more specific.
        const score = (wanted.length - i) * 100 + scope.length
        if (!best || score > best.score) best = { entry, score }
      }
    }
  }
  return best?.entry ?? null
}

const bare = (color: string | undefined): string | undefined =>
  color?.replace(/^#/, '').slice(0, 6)

/**
 * Define (or redefine) the editor theme from the app's active theme, then apply it.
 * Monaco keeps one global theme registry, so every editor instance follows.
 */
export function applyMonacoTheme(theme: ResolvedTheme): void {
  const rules: monaco.editor.ITokenThemeRule[] = []

  for (const [token, scopes] of TOKEN_SCOPES) {
    const entry = findEntry(theme.tokenColors, scopes)
    const foreground = bare(entry?.settings.foreground)
    if (!foreground) continue
    rules.push({
      token,
      foreground,
      ...(entry?.settings.fontStyle ? { fontStyle: entry.settings.fontStyle } : {})
    })
  }

  const v = theme.vars
  monaco.editor.defineTheme(MONACO_THEME_ID, {
    base: theme.type === 'light' ? 'vs' : 'vs-dark',
    // Inherit so any token this mapping does not cover still gets a sane colour
    // rather than falling back to the default foreground.
    inherit: true,
    rules,
    colors: {
      'editor.background': v.bg,
      'editor.foreground': v.fg,
      'editorLineNumber.foreground': v['fg-faint'],
      'editorLineNumber.activeForeground': v['fg-dim'],
      'editorCursor.foreground': v.accent,
      'editor.selectionBackground': v.selection,
      'editor.lineHighlightBackground': v['bg-elevated'],
      'editorWidget.background': v['bg-elevated'],
      'editorWidget.border': v['border-strong'],
      'editorSuggestWidget.background': v['bg-elevated'],
      'editorSuggestWidget.selectedBackground': v['bg-hover'],
      // Both halves, or the active one is not active. The pane asks for
      // highlightActiveIndentation, but with only the inactive colour mapped the
      // highlight fell back to Monaco's built-in grey — which in this palette is
      // near enough to the inactive guide that the feature was doing nothing.
      'editorIndentGuide.background1': v.border,
      'editorIndentGuide.activeBackground1': v['border-strong'],
      'editorGutter.background': v.bg,
      'scrollbarSlider.background': v['border-strong'],
      'editorError.foreground': v.fail,
      'editorWarning.foreground': v.accent
    }
  })
  monaco.editor.setTheme(MONACO_THEME_ID)
}
