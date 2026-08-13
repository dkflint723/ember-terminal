import { spawn, type ChildProcess } from 'node:child_process'
import type { SearchHit, SearchQuery, SearchResult } from '../shared/types.js'

/**
 * Search across the workspace, using the same tool VS Code uses.
 *
 * ripgrep rather than a walk of our own: it already respects .gitignore, skips
 * binaries, handles encodings, and is fast enough that the results feel immediate
 * on a large tree. Writing a worse version of that in Node would be a lot of code
 * to end up slower and wrong about which files to skip.
 *
 * Only one search runs at a time. Typing in a search box produces a query per
 * keystroke, and the answer to a query nobody is waiting for is to stop computing
 * it — so a new search kills the one before it.
 */
export class SearchService {
  private current: ChildProcess | null = null

  /** Enough to be useful; past this, refine the query rather than scroll. */
  private static readonly MAX_HITS = 2000

  private rgPath(): string | null {
    try {
      // Resolved lazily: a packaged build that somehow lacks the binary should
      // report that clearly rather than failing at import time.
      return (require('@vscode/ripgrep') as { rgPath: string }).rgPath
    } catch {
      return null
    }
  }

  cancel(): void {
    if (!this.current) return
    try {
      this.current.kill()
    } catch {
      // Already gone.
    }
    this.current = null
  }

  /**
   * Every file in the workspace, for quick open.
   *
   * `rg --files` rather than a recursive readdir: it is the same walk ripgrep does
   * for a search, so it honours the same ignore rules — a quick-open list that
   * offered node_modules while search skipped it would be its own kind of wrong.
   */
  async files(root: string): Promise<string[]> {
    const rg = this.rgPath()
    if (!rg) return []

    return new Promise<string[]>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(rg, ['--files', '--no-require-git', '--', root], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore']
        })
      } catch {
        resolve([])
        return
      }

      let out = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
        // A workspace can have hundreds of thousands of files; past this the list
        // is not the tool for the job and the fuzzy filter would crawl.
        if (out.length > 8 * 1024 * 1024) child.kill()
      })
      child.on('error', () => resolve([]))
      child.on('close', () => resolve(out.split('\n').map((l) => l.trim()).filter(Boolean)))
    })
  }

  async run(query: SearchQuery): Promise<SearchResult> {
    this.cancel()

    const text = query.text
    if (!text.trim()) return { ok: true, hits: [], truncated: false }

    const rg = this.rgPath()
    if (!rg) return { ok: false, error: 'The bundled ripgrep binary is missing.' }

    const args = [
      '--json',
      // Without this, ripgrep only applies .gitignore inside a git repository, so
      // searching a plain folder would walk straight into node_modules.
      '--no-require-git',
      '--max-count',
      '200',
      // Skip anything enormous: a minified bundle is a wall of matches nobody wants.
      '--max-filesize',
      '2M',
      query.caseSensitive ? '--case-sensitive' : '--ignore-case'
    ]
    if (query.wholeWord) args.push('--word-regexp')
    if (!query.regex) args.push('--fixed-strings')
    if (query.include) args.push('--glob', query.include)
    args.push('--', text, query.root)

    return new Promise<SearchResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(rg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : 'Could not run search.' })
        return
      }
      this.current = child

      const hits: SearchHit[] = []
      let truncated = false
      let stderr = ''
      let buffer = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        // ripgrep emits one JSON object per line, and a line can be split across
        // reads, so the tail is carried forward rather than parsed as-is.
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          let event: RgEvent
          try {
            event = JSON.parse(line) as RgEvent
          } catch {
            continue
          }
          if (event.type !== 'match') continue

          const data = event.data
          for (const submatch of data.submatches ?? []) {
            if (hits.length >= SearchService.MAX_HITS) {
              truncated = true
              this.cancel()
              return
            }
            hits.push({
              path: data.path?.text ?? '',
              line: data.line_number ?? 0,
              // ripgrep reports byte offsets into the line; the renderer needs
              // character offsets to highlight, and they only differ outside ASCII.
              column: charOffset(data.lines?.text ?? '', submatch.start),
              length: charOffset(data.lines?.text ?? '', submatch.end) -
                charOffset(data.lines?.text ?? '', submatch.start),
              preview: (data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 400)
            })
          }
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })

      child.on('error', (err) => {
        this.current = null
        resolve({ ok: false, error: err.message })
      })

      child.on('close', () => {
        this.current = null
        // Exit code 1 means "no matches", which is an answer rather than a failure.
        if (stderr.trim() && hits.length === 0) {
          resolve({ ok: false, error: stderr.trim().split('\n')[0] })
          return
        }
        resolve({ ok: true, hits, truncated })
      })
    })
  }
}

/** Byte offset to character offset, for a line that may not be ASCII. */
function charOffset(line: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0
  return Buffer.from(line, 'utf8').subarray(0, byteOffset).toString('utf8').length
}

interface RgEvent {
  type: string
  data: {
    path?: { text: string }
    lines?: { text: string }
    line_number?: number
    submatches?: { start: number; end: number }[]
  }
}
