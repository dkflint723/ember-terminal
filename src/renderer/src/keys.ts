import type { useStore } from './state/store'

/**
 * Every chord the window answers, as data instead of a ladder of if-statements.
 *
 * The keydown handler in App used to compare `e.key` against literals, which
 * made the bindings true but unchangeable: there was nothing to point a
 * settings page at. Each entry here is one of those branches, verbatim — same
 * guard, same action — with a name a person can read and a default chord a
 * person can now change. The handler resolves the pressed chord against the
 * user's overrides and runs whatever it names.
 */

type AppState = ReturnType<typeof useStore.getState>

export interface CommandContext {
  s: AppState
  e: KeyboardEvent
  tab: AppState['tabs'][number] | undefined
  /** The terminal a shell-shaped chord should act on. See App's askTarget. */
  askTarget: () => string | undefined
  /** App's file-open dialog flow. */
  openFile: () => Promise<void>
}

export interface Command {
  id: string
  label: string
  chord: string
  /** Return false to decline the chord — no preventDefault, key falls through. */
  run(ctx: CommandContext): boolean | void
}

/**
 * A KeyboardEvent, spelled the way the registry spells chords.
 *
 * Shift is dropped for punctuation: '+' is how a hand types '=' on most
 * layouts, and a zoom-in bound to Ctrl+= must fire for both spellings. Letters
 * keep their Shift — Ctrl+Shift+F and Ctrl+F are different promises.
 */
export function chordOf(e: KeyboardEvent): string {
  let key = e.key
  if (key === ' ') key = 'Space'
  if (key === '+') key = '='
  const letterish = key.length === 1 && /[a-z0-9]/i.test(key)
  if (key.length === 1) key = key.toUpperCase()

  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey && (letterish || key.length > 1)) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

const zoomTo = (s: AppState, next: number): void => {
  const clamped = Math.min(Math.max(next, 0.6), 2.5)
  window.ember.setZoom(clamped)
  void window.ember.setSettings({ uiZoom: clamped }).then((r) => s.applySettings(r.settings))
}

export const COMMANDS: Command[] = [
  {
    id: 'session.new',
    label: 'New session',
    chord: 'Ctrl+Shift+T',
    run: ({ s }) => s.newTab(s.profiles[0]?.id ?? '')
  },
  {
    id: 'pane.close',
    label: 'Close pane',
    chord: 'Ctrl+Shift+W',
    run: ({ s, tab }) => {
      if (!tab) return false
      s.closePane(tab.id, tab.activePaneId)
    }
  },
  {
    // Blocks outlive the app now, so there has to be a way to say "not any
    // more" that does not mean deleting a database by hand.
    id: 'terminal.clear',
    label: 'Clear the terminal',
    chord: 'Ctrl+Shift+K',
    run: ({ s, tab, askTarget }) => {
      if (!tab) return false
      const target = askTarget()
      if (target) s.clearBlocks(target)
    }
  },
  {
    id: 'pane.splitRight',
    label: 'Split right',
    chord: 'Ctrl+Shift+D',
    run: ({ s, tab }) => {
      if (!tab) return false
      s.splitPane(tab.id, tab.activePaneId, 'row')
    }
  },
  {
    id: 'pane.splitDown',
    label: 'Split down',
    chord: 'Ctrl+Shift+E',
    run: ({ s, tab }) => {
      if (!tab) return false
      s.splitPane(tab.id, tab.activePaneId, 'column')
    }
  },
  {
    // The switch the whole thing is built around: a terminal, or an IDE.
    id: 'mode.toggle',
    label: 'Terminal ↔ IDE',
    chord: 'Ctrl+Shift+I',
    run: ({ s }) => s.setMode()
  },
  {
    /*
     * Ctrl+Shift+B opened Claude's sidebar, and there is no sidebar any more —
     * the agent is a block in the list. The chord is kept because it is what
     * people already press to reach Claude, repointed at what reaching Claude
     * means now: the composer, pinned to agent, on the active shell.
     */
    id: 'agent.ask',
    label: 'Ask the agent',
    chord: 'Ctrl+Shift+B',
    run: ({ s, askTarget }) => {
      const target = askTarget()
      if (target) s.requestAsk(target, 'agent')
    }
  },
  {
    // One chord for one slot, whichever face the window is wearing.
    id: 'slot.toggle',
    label: 'Sessions / file sidebar',
    chord: 'Ctrl+B',
    run: ({ s }) => (s.mode === 'terminal' ? s.toggleSessions() : s.toggleSidebar())
  },
  {
    id: 'panel.toggle',
    label: 'Panel',
    chord: 'Ctrl+J',
    run: ({ s }) => {
      if (s.mode !== 'ide') {
        s.setMode('ide')
        s.togglePanel(true)
      } else s.togglePanel()
    }
  },
  {
    /*
     * Only for a terminal — an editor has Monaco's own find on the same chord,
     * and that one is better than anything this would do. Declining hands the
     * keystroke on.
     */
    id: 'terminal.find',
    label: 'Find in output',
    chord: 'Ctrl+F',
    run: ({ s, tab }) => {
      const active = tab ? s.panes[tab.activePaneId] : undefined
      if (active?.kind !== 'terminal') return false
      s.setFind(s.findPaneId === active.id ? null : active.id)
    }
  },
  {
    /*
     * Claimed globally so it means the same thing wherever focus is: in an
     * editor pane Monaco takes Ctrl+K as a chord prefix and swallows the next
     * keystroke, which reads as the app freezing.
     */
    id: 'composer.pin',
    label: 'Pin shell / agent',
    chord: 'Ctrl+K',
    run: ({ s, askTarget }) => {
      const target = askTarget()
      if (target) s.requestAsk(target, 'toggle')
    }
  },
  {
    id: 'zoom.in',
    label: 'Zoom in',
    chord: 'Ctrl+=',
    run: ({ s }) => zoomTo(s, (s.settings.uiZoom || 1) + 0.1)
  },
  {
    id: 'zoom.out',
    label: 'Zoom out',
    chord: 'Ctrl+-',
    run: ({ s }) => zoomTo(s, (s.settings.uiZoom || 1) - 0.1)
  },
  {
    id: 'zoom.reset',
    label: 'Zoom to 100%',
    chord: 'Ctrl+0',
    run: ({ s }) => zoomTo(s, 1)
  },
  {
    // Ctrl+S belongs to the focused editor, and VS Code's Ctrl+K S is not
    // available here because Ctrl+K asks Claude.
    id: 'editor.saveAll',
    label: 'Save all',
    chord: 'Ctrl+Alt+S',
    run: ({ s }) => void s.saveAllDocuments()
  },
  {
    // Electron's default accelerator would reload the window; this claims it.
    id: 'history.search',
    label: 'Search command history',
    chord: 'Ctrl+R',
    run: ({ s }) => s.toggleHistory()
  },
  {
    id: 'view.scm',
    label: 'Source control',
    chord: 'Ctrl+Shift+G',
    run: ({ s }) => s.showSidebarView('scm')
  },
  {
    id: 'view.github',
    label: 'GitHub',
    chord: 'Ctrl+Shift+H',
    run: ({ s }) => s.showSidebarView('github')
  },
  {
    id: 'view.problems',
    label: 'Problems',
    chord: 'Ctrl+Shift+M',
    run: ({ s }) => s.showSidebarView('problems')
  },
  {
    id: 'view.search',
    label: 'Search in files',
    chord: 'Ctrl+Shift+F',
    run: ({ s }) => s.showSidebarView('search')
  },
  {
    id: 'palette.files',
    label: 'Go to file',
    chord: 'Ctrl+P',
    run: ({ s }) => s.openPalette('files')
  },
  {
    id: 'palette.commands',
    label: 'Command palette',
    chord: 'Ctrl+Shift+P',
    run: ({ s }) => s.openPalette('commands')
  },
  {
    id: 'file.open',
    label: 'Open file…',
    chord: 'Ctrl+O',
    run: ({ openFile }) => void openFile()
  },
  {
    id: 'settings.open',
    label: 'Settings',
    chord: 'Ctrl+,',
    run: ({ s }) => s.toggleSettings()
  },
  {
    id: 'session.next',
    label: 'Next session',
    chord: 'Ctrl+Tab',
    run: ({ s, tab }) => {
      if (s.tabs.length < 2) return false
      const i = s.tabs.findIndex((t) => t.id === tab?.id)
      s.setActiveTab(s.tabs[(i + 1) % s.tabs.length].id)
    }
  },
  {
    id: 'session.previous',
    label: 'Previous session',
    chord: 'Ctrl+Shift+Tab',
    run: ({ s, tab }) => {
      if (s.tabs.length < 2) return false
      const i = s.tabs.findIndex((t) => t.id === tab?.id)
      s.setActiveTab(s.tabs[(i - 1 + s.tabs.length) % s.tabs.length].id)
    }
  }
]

export interface ResolvedBindings {
  /** Pressed chord → the command it runs, overrides applied. */
  byChord: Map<string, Command>
  /** Command id → the chord it currently answers to. */
  byId: Map<string, string>
  /** Chords claimed by more than one command, for the settings page to show. */
  conflicts: { chord: string; labels: string[] }[]
}

export function resolveBindings(overrides: Record<string, string>): ResolvedBindings {
  const byChord = new Map<string, Command>()
  const byId = new Map<string, string>()
  const claims = new Map<string, string[]>()

  for (const command of COMMANDS) {
    const chord = overrides[command.id] ?? command.chord
    byId.set(command.id, chord)
    claims.set(chord, [...(claims.get(chord) ?? []), command.label])
    // First claim wins, so a conflict disables the later command rather than
    // making one keystroke do two things.
    if (!byChord.has(chord)) byChord.set(chord, command)
  }

  const conflicts = [...claims.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([chord, labels]) => ({ chord, labels }))
  return { byChord, byId, conflicts }
}
