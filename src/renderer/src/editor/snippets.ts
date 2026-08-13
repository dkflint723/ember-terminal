import { monaco } from './monaco'

/**
 * Snippets, offered in the completion list alongside whatever the language server
 * suggests.
 *
 * Registered as an ordinary completion provider rather than through any mechanism
 * of its own, so snippets and server completions are one list the user filters with
 * the same keystrokes — which is the whole reason to have them in the editor rather
 * than in a menu.
 *
 * One provider per language, registered the first time a document in that language
 * is opened. Registering for every language up front would mean asking main for
 * snippets nobody is going to use, and Monaco knows about a hundred languages.
 */
const registered = new Map<string, monaco.IDisposable>()

export async function ensureSnippets(languageId: string): Promise<void> {
  if (!languageId || registered.has(languageId)) return
  // Claimed before the await, so two documents opening at once cannot both get
  // past the check and register a duplicate provider.
  registered.set(languageId, { dispose: () => {} })

  const snippets = await window.ember.snippetsFor(languageId)
  if (snippets.length === 0) return

  const provider = monaco.languages.registerCompletionItemProvider(languageId, {
    provideCompletionItems: (model, position) => {
      // The word being typed, so the list replaces it rather than appending to it.
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn
      }

      return {
        suggestions: snippets.map((snippet) => ({
          label: snippet.prefix,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: snippet.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          // The name is what identifies a snippet to the person who wrote it; the
          // prefix is only how it is typed.
          detail: snippet.label,
          documentation: snippet.description ?? undefined,
          range
        }))
      }
    }
  })

  registered.set(languageId, provider)
}

/** Drop the providers so edited snippet files are picked up without a restart. */
export function forgetSnippets(): void {
  for (const provider of registered.values()) provider.dispose()
  registered.clear()
}
