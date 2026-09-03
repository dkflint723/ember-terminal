import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { existingController } from '../terminal/controller'

/**
 * The scripts a project already declares, one press from running.
 *
 * Every editor competing with this one has this view — VS Code calls them tasks,
 * JetBrains puts them in the gutter — and every terminal competing with it has the
 * neighbouring idea, Warp's saved workflows. Ember had neither, so the way to run
 * a project's own build was to remember its name and type it.
 *
 * It belongs here more than in either of them, because this app already turns a
 * command into a block: a script runs where every other command ran, with its exit
 * code, its timing and its output kept the same way. There is nothing to invent for
 * the running part, which is why this is a list and not a system.
 */
interface Script {
  name: string
  command: string
}

/**
 * Which package manager the project actually uses, read from the lockfile it
 * committed rather than assumed. Running `npm run build` in a pnpm workspace is a
 * good way to install a second, disagreeing node_modules.
 */
const LOCKFILES: { file: string; run: (name: string) => string }[] = [
  { file: 'pnpm-lock.yaml', run: (n) => `pnpm run ${n}` },
  { file: 'yarn.lock', run: (n) => `yarn ${n}` },
  { file: 'bun.lockb', run: (n) => `bun run ${n}` },
  { file: 'package-lock.json', run: (n) => `npm run ${n}` }
]

export function ScriptRunner(): React.JSX.Element {
  const treeRoot = useStore((s) => s.treeRoot)
  const [scripts, setScripts] = useState<Script[]>([])
  const [runner, setRunner] = useState<(name: string) => string>(() => (n: string) => `npm run ${n}`)
  const [state, setState] = useState<'loading' | 'none' | 'ready'>('loading')

  useEffect(() => {
    let cancelled = false
    if (!treeRoot) {
      setState('none')
      setScripts([])
      return
    }

    void (async () => {
      setState('loading')
      const read = await window.ember.readFile(`${treeRoot}/package.json`).catch(() => null)
      if (cancelled) return
      const raw = read?.ok ? read.content : null

      let parsed: { scripts?: Record<string, string> } | null = null
      try {
        parsed = raw ? (JSON.parse(raw) as { scripts?: Record<string, string> }) : null
      } catch {
        // A package.json mid-edit is not an error worth a banner; the view simply
        // has nothing to show until it parses again.
        parsed = null
      }

      const found = Object.entries(parsed?.scripts ?? {}).map(([name, command]) => ({
        name,
        command: String(command)
      }))

      // The lockfile decides how they are invoked.
      let run = (n: string): string => `npm run ${n}`
      for (const candidate of LOCKFILES) {
        const hit = await window.ember.readFile(`${treeRoot}/${candidate.file}`).catch(() => null)
        if (cancelled) return
        if (hit?.ok) {
          run = candidate.run
          break
        }
      }

      if (cancelled) return
      setRunner(() => run)
      setScripts(found)
      setState(found.length > 0 ? 'ready' : 'none')
    })()

    return () => {
      cancelled = true
    }
  }, [treeRoot])

  /*
   * A press runs it in the session's terminal, the same way a typed command runs:
   * as a block, in whatever directory that pane is standing in. Nothing is spawned
   * behind the user's back — the command appears in their scrollback, which is also
   * where they will look for it when it fails.
   */
  const run = (name: string): void => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return
    const active = s.panes[tab.activePaneId]
    const pane =
      active?.kind === 'terminal' ? active : Object.values(s.panes).find((p) => p.kind === 'terminal')
    if (pane?.kind !== 'terminal') return
    existingController(pane.id)?.runCommand(runner(name))
  }

  if (state === 'loading') return <div className="sidebar__empty">Reading package.json…</div>

  if (state === 'none') {
    return (
      <div className="sidebar__empty">
        {treeRoot
          ? 'No scripts in this project’s package.json.'
          : 'Open a folder to see the scripts it declares.'}
      </div>
    )
  }

  return (
    <div className="scripts">
      {scripts.map((script) => (
        <button
          key={script.name}
          className="scripts__item"
          type="button"
          title={`Run: ${runner(script.name)}`}
          onClick={() => run(script.name)}
        >
          <span className="scripts__play" aria-hidden="true">
            ▸
          </span>
          <span className="scripts__name">{script.name}</span>
          {/* What it actually runs, because "build" is not a description. */}
          <span className="scripts__cmd">{script.command}</span>
        </button>
      ))}
    </div>
  )
}
