import { useEffect } from 'react'
import { useStore } from './state/store'
import { TitleBar } from './components/TitleBar'
import { SplitView } from './components/SplitView'
import { SettingsPanel } from './components/SettingsPanel'
import { HistorySearch } from './components/HistorySearch'
import { ActivityBar } from './components/ActivityBar'
import { Sidebar } from './components/Sidebar'
import { Palette } from './components/Palette'
import { disposeController } from './terminal/controller'
import { activateTheme, refreshThemeList } from './state/theming'
import { useGitStatusPolling } from './state/git'
import { useIdeBridge } from './state/ide'
import { restore, unsavedWorkIsPreserved, useSessionAutosave } from './state/session'
import { setRevealer } from './editor/navigate'
import { PanelBar } from './components/PanelBar'
import { StatusBar } from './components/StatusBar'
import { OutputPanel } from './components/OutputPanel'
import { ProblemsPanel } from './components/ProblemsPanel'
import { RegionDivider } from './components/RegionDivider'
import { DirectoryPicker } from './components/DirectoryPicker'
import { SessionList } from './components/SessionList'
import { existingController } from './terminal/controller'

export function App(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const panes = useStore((s) => s.panes)
  const activeTabId = useStore((s) => s.activeTabId)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const sessionsOpen = useStore((s) => s.sessionsOpen)
  const mode = useStore((s) => s.mode)
  const panelOpen = useStore((s) => s.panelOpen)
  const panelView = useStore((s) => s.panelView)
  const panelHeight = useStore((s) => s.panelHeight)
  const dirPicker = useStore((s) => s.dirPicker)
  const setDirPicker = useStore((s) => s.setDirPicker)
  const fontSize = useStore((s) => s.settings.fontSize)

  /*
   * The terminal font size, published where the stylesheet can reach it.
   *
   * xterm takes the setting through its own option, but the blocks are HTML — their
   * text sizes are written in CSS relative to this variable, and without someone
   * setting it the calc() rules quietly collapse to the inherited size.
   */
  useEffect(() => {
    document.documentElement.style.setProperty('--font-size', `${fontSize}px`)
  }, [fontSize])
  /*
   * The terminal the browser belongs to: the active pane when that is one, else the
   * tab's first. The same rule the status bar uses to decide whose directory it is
   * printing, so the path shown and the path browsed are always the same path.
   */
  const dirPickerPaneId = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return null
    const active = s.panes[tab.activePaneId]
    if (active?.kind === 'terminal') return active.id
    return Object.values(s.panes).find((p) => p.kind === 'terminal')?.id ?? null
  })
  const dirPickerCwd = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return null
    const active = s.panes[tab.activePaneId]
    if (active?.kind === 'terminal') return active.cwd
    const first = Object.values(s.panes).find((p) => p.kind === 'terminal')
    return first?.kind === 'terminal' ? first.cwd : null
  })

  const notice = useStore((s) => s.notice)
  const setNotice = useStore((s) => s.setNotice)

  // Kept current in main, which has to decide synchronously when the window is
  // closing and cannot wait on an answer from here.
  useEffect(() => {
    const report = (): void => {
      const s = useStore.getState()
      let count = 0
      for (const pane of Object.values(s.panes)) {
        if (pane.kind !== 'editor') continue
        for (const doc of pane.documents) if (doc.dirty) count += 1
      }
      // Only work that closing would actually lose. With session restore on and
      // writing successfully, it comes back — warning about it would be a prompt
      // for nothing several times a day.
      window.ember.reportUnsaved(unsavedWorkIsPreserved() ? 0 : count)
    }
    report()
    return useStore.subscribe(report)
  }, [])
  const setProfiles = useStore((s) => s.setProfiles)
  const applySettings = useStore((s) => s.applySettings)
  const newTab = useStore((s) => s.newTab)
  const restoreEnabled = useStore((s) => s.settings.restoreSession)

  // Mounted here rather than in the source-control view: the explorer colours its
  // rows from the same status, and that has to work while the view is closed.
  useGitStatusPolling()
  // Answers Claude Code's tool calls, and keeps the published workspace root current.
  useIdeBridge()
  const isHomeDirectory = (dir: string): boolean =>
    dir.replace(/[\\/]+$/, '').toLowerCase() ===
    window.ember.homeDir.replace(/[\\/]+$/, '').toLowerCase()

  // Reads the applied setting, so turning restore off stops the writing too.
  useSessionAutosave(restoreEnabled)

  // The workspace root defaults to the active terminal's directory, but does not
  // follow it afterwards — re-rooting under someone mid-browse would be hostile.
  // It lives here rather than in the explorer because source control needs a root
  // too, and would otherwise have none until the explorer had been opened once.
  const rootTab = tabs.find((t) => t.id === activeTabId)
  const rootPane = rootTab ? panes[rootTab.activePaneId] : undefined
  const terminalCwd = rootPane?.kind === 'terminal' ? rootPane.cwd : null
  /*
   * Never the home directory, though.
   *
   * A new terminal reports home until its shell says otherwise, so launching
   * without a folder adopted the user's entire profile as the workspace before they
   * had done anything: the explorer listed .ssh and AppData, quick open and search
   * indexed and grepped the lot — one search for "password" turned up real
   * credentials in unrelated files — and Replace All was armed across all of it.
   *
   * Declining also makes the "Open a folder to…" empty states reachable, which is
   * the one place the app tells a new user that opening a folder is a thing to do.
   * Someone who genuinely wants their home directory can still choose it.
   */
  useEffect(() => {
    const s = useStore.getState()
    if (!s.treeRoot && terminalCwd && !isHomeDirectory(terminalCwd)) s.setTreeRoot(terminalCwd)
  }, [terminalCwd])

  // Boot: discover shells, then open the first tab on the preferred one.
  useEffect(() => {
    void (async () => {
      const [profiles, settings] = await Promise.all([
        window.ember.listProfiles(),
        window.ember.getSettings()
      ])
      setProfiles(profiles)
      applySettings(settings)

      // Settings that existed but could not be read were replaced with defaults in
      // silence, which is indistinguishable from a first run right up until the
      // next write makes it permanent.
      const badSettings = await window.ember.settingsLoadError()
      if (badSettings) {
        useStore
          .getState()
          .setNotice(
            `Your settings could not be read and have been reset. The old file was kept as settings.json.bad. (${badSettings})`,
            'error'
          )
      }

      // Theme before the first pane, so no terminal is ever created with the
      // wrong palette and then repainted.
      await Promise.all([activateTheme(settings.themeId), refreshThemeList()])

      if (profiles.length === 0) return

      // Read before the first tab exists, so the workspace root can be seeded from
      // a file argument. A new terminal reports the home directory until its shell
      // says otherwise, and that placeholder would otherwise claim the root first.
      const [startup, folders] = await Promise.all([
        window.ember.startupFiles(),
        window.ember.startupFolders()
      ])

      // A folder argument — what Explorer's "Open in Ember" passes — is the
      // strongest statement of where the user is working, so it wins over a file's
      // directory, which in turn beats the shell's own default.
      const root =
        folders[0] ??
        (startup[0] ? startup[0].replace(/[\\/][^\\/]*$/, '') || null : null)

      // The last workspace goes back before anything is created, so restored tabs
      // are the tabs rather than joining an empty one that was made first.
      /*
       * A restore that throws must not take the window with it.
       *
       * The whole boot sequence runs inside one unguarded async block, so anything
       * thrown while walking a saved layout stopped it before the first tab was
       * ever created — leaving a window with no terminal, no editor and no way to
       * do anything. Main validates the file now, but a fresh window is the right
       * answer to any restore that still fails, rather than no window at all.
       */
      /*
       * A folder argument used to skip the restore entirely, which quietly destroyed
       * the session it skipped: the autosave subscription is already armed by then,
       * so opening a folder from Explorer's "Open in Ember" wrote a one-tab snapshot
       * over session.json a second later, taking every tab from the last workspace
       * and every unsaved buffer in it. The last session comes back either way now,
       * and the folder joins it — the same thing a second instance does with one.
       */
      let restored = false
      if (settings.restoreSession) {
        try {
          restored = await restore(await window.ember.sessionLoad())
        } catch (err) {
          console.error('Could not restore the last session; starting fresh.', err)
          restored = false
        }
      }
      // A folder argument overrides a restored root: launching on a folder is an
      // explicit statement about where the user is working now.
      if (root) useStore.getState().setTreeRoot(root)

      const preferred =
        profiles.find((p) => p.id === settings.defaultProfileId)?.id ?? profiles[0].id
      // The shell starts in that folder too: "open here" would be a strange promise
      // to keep in the sidebar and break in the terminal.
      if (!restored && useStore.getState().tabs.length === 0) {
        newTab(preferred, folders[0] ?? undefined)
      } else if (folders[0]) {
        // A folder asked for on top of a workspace that came back gets its own tab,
        // the same answer a second instance gives when it is handed one.
        newTab(preferred, folders[0])
      }

      // Files named on the command line open once the first tab exists, since an
      // editor pane is created beside an existing pane.
      await openPaths(startup)
    })()
  }, [newTab, setProfiles, applySettings])

  useEffect(() => window.ember.onOpenFiles((paths) => void openPaths(paths)), [])

  // Handed to the editor panes, which need it for Go to Definition but sit several
  // levels down a tree that has no other use for it.
  useEffect(() => setRevealer((p, line, column) => void revealAt(p, line, column)), [])

  /*
   * Let Go to Definition open a file that is not already open.
   *
   * Monaco navigates by asking for a model, and when the target lives in a file
   * with no editor there is no model to ask for — so definitions, references and
   * renames that pointed anywhere else did nothing at all. An opener is how Monaco
   * asks the host to produce one; without it registered, it simply gives up.
   */
  useEffect(() => {
    let disposed = false
    let opener: { dispose(): void } | null = null
    void import('./editor/monaco').then(({ monaco }) => {
      if (disposed) return
      opener = monaco.editor.registerEditorOpener({
        openCodeEditor: (_source, resource, selection) => {
          if (resource.scheme !== 'file') return false
          // Monaco passes either a range or a bare position, depending on whether
          // the target has an extent.
          const at = selection as { startLineNumber?: number; startColumn?: number; lineNumber?: number; column?: number } | undefined
          const line = at?.startLineNumber ?? at?.lineNumber ?? 1
          const column = (at?.startColumn ?? at?.column ?? 1) - 1
          void revealAt(resource.fsPath, line, column)
          // Handled, even though the work finishes asynchronously — returning false
          // makes Monaco fall back to doing nothing.
          return true
        }
      })
    })
    return () => {
      disposed = true
      opener?.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A second instance launched on a folder opens a tab there rather than stealing
  // the root from whatever the current window is already working on.
  useEffect(
    () =>
      window.ember.onOpenFolder((folder) => {
        const s = useStore.getState()
        if (!s.treeRoot) s.setTreeRoot(folder)
        s.newTab(s.profiles[0]?.id ?? '', folder)
      }),
    []
  )

  // Dispose controllers for panes that have gone away, so xterm instances and
  // their offscreen render terminals are not leaked.
  useEffect(() => {
    const live = new Set(Object.keys(panes))
    return () => {
      for (const id of live) if (!useStore.getState().panes[id]) disposeController(id)
    }
  }, [panes])

  const openPaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    // A file named on the command line says more about where the user is working
    // than the shell's start directory does, so it seeds the workspace root.
    const s0 = useStore.getState()
    if (!s0.treeRoot) {
      const dir = paths[0].replace(/[\\/][^\\/]*$/, '')
      if (dir && dir !== paths[0]) s0.setTreeRoot(dir)
    }
    const { languageForPath } = await import('./editor/monaco')
    for (const filePath of paths) {
      const res = await window.ember.readFile(filePath)
      if (!res.ok) {
        /*
         * Say why nothing opened.
         *
         * A binary file, or one over the size cap, was skipped in silence — no tab,
         * no message, nothing at all. Double-clicking a PNG in the explorer looked
         * exactly like the app having stopped responding to clicks.
         */
        useStore
          .getState()
          .setNotice(`${filePath.split(/[\\/]/).pop()}: ${res.error}`, 'error')
        continue
      }
      const s = useStore.getState()
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      if (!tab) return
      s.openFileInSplit(tab.id, {
        path: res.path,
        name: res.name,
        content: res.content,
        language: languageForPath(res.path),
        eol: res.eol
      })
    }
  }

  /**
   * Open a file and put the cursor on a specific match, for a search result.
   *
   * The reveal is a separate step from the open because the editor pane creates
   * Monaco's model itself — the position can only be set once that exists, which
   * is a render later.
   */
  /*
   * Paths clicked in block output arrive here as an event rather than as a prop
   * threaded through the split tree: the block knows a path, the app knows how
   * to show one, and nothing between them needs to know either. Clicking a path
   * is an explicit ask to edit, so a terminal-mode click brings the IDE.
   */
  useEffect(() => {
    const onOpenPath = (e: Event): void => {
      const { path, line, column } = (e as CustomEvent<{ path: string; line: number; column: number }>).detail
      const s = useStore.getState()
      if (s.mode !== 'ide') s.setMode('ide')
      void revealAt(path, line, Math.max(0, column - 1))
    }
    window.addEventListener('ember:open-path', onOpenPath)
    return () => window.removeEventListener('ember:open-path', onOpenPath)
  })

  const revealAt = async (filePath: string, line: number, column: number): Promise<void> => {
    await openPaths([filePath])
    const { modelUri, monaco } = await import('./editor/monaco')
    // A couple of frames is enough for the pane to mount and claim the model.
    window.setTimeout(() => {
      const model = monaco.editor.getModel(modelUri(filePath))
      if (!model) return
      for (const editor of monaco.editor.getEditors()) {
        if (editor.getModel() !== model) continue
        const position = { lineNumber: line, column: column + 1 }
        editor.setSelection({
          startLineNumber: line,
          startColumn: column + 1,
          endLineNumber: line,
          endColumn: column + 1
        })
        editor.revealPositionInCenter(position)
        editor.focus()
      }
    }, 220)
  }

  const openFile = async (): Promise<void> => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return
    // Start the picker in the active terminal's directory, which is nearly always
    // where the file the user wants lives.
    const pane = s.panes[tab.activePaneId]
    const from = pane?.kind === 'terminal' ? pane.cwd : undefined

    const res = await window.ember.openFileDialog(from)
    if (!res.ok) return
    await openPaths([res.path])
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      const tabId = s.activeTabId
      const tab = s.tabs.find((t) => t.id === tabId)

      /*
       * The pane a shell-shaped chord targets: the active one when that is a
       * terminal, else the first terminal in the window — asking about a shell,
       * or clearing one, needs a shell. Three chords land here, so the choice is
       * made in one place rather than drifting apart between them.
       */
      const askTarget = (): string | undefined => {
        if (!tab) return undefined
        const active = s.panes[tab.activePaneId]
        return active?.kind === 'terminal'
          ? active.id
          : Object.values(s.panes).find((p) => p.kind === 'terminal')?.id
      }

      if (e.ctrlKey && e.shiftKey) {
        const key = e.key.toLowerCase()
        if (key === 't') {
          e.preventDefault()
          newTab(s.profiles[0]?.id ?? '')
          return
        }
        if (key === 'w' && tab) {
          e.preventDefault()
          s.closePane(tab.id, tab.activePaneId)
          return
        }
        /*
         * Clear this pane's blocks, on the binding Warp uses on Windows.
         *
         * Blocks outlive the app now, so there has to be a way to say "not any
         * more" that does not mean deleting a database by hand. It falls back to a
         * shell the same way the ask chords do — pressed with an editor focused,
         * "clear" from a pane that has nothing to clear should still mean
         * something — so it asks the same helper rather than repeating it.
         */
        if (key === 'k' && tab) {
          e.preventDefault()
          const target = askTarget()
          if (target) s.clearBlocks(target)
          return
        }
        // Windows Terminal uses Alt+Shift+= / Alt+Shift+- ; these are the
        // equivalents that do not collide with shell shortcuts.
        if (key === 'd' && tab) {
          e.preventDefault()
          s.splitPane(tab.id, tab.activePaneId, 'row')
          return
        }
        if (key === 'e' && tab) {
          e.preventDefault()
          s.splitPane(tab.id, tab.activePaneId, 'column')
          return
        }
        /*
         * The switch the whole thing is built around: a terminal, or an IDE.
         *
         * Ctrl+Shift+I because it is the one free chord that names what it does,
         * and because this window has no application menu — nothing else is
         * claiming it.
         */
        if (key === 'i') {
          e.preventDefault()
          s.setMode()
          return
        }
        /*
         * Ctrl+Shift+B opened Claude's sidebar, and there is no sidebar any more —
         * the agent is a block in the list. The chord is kept rather than dropped
         * because it is what people already press to reach Claude, and repointed
         * at what reaching Claude means now: the composer, pinned to agent, on the
         * active shell.
         *
         * 'agent' rather than a toggle because the chord says what it wants. A
         * buffer that already reads as a question is the normal case here, and
         * flipping that reading would pin shell and send the sentence to the
         * shell — the opposite of what was pressed.
         */
        if (key === 'b') {
          e.preventDefault()
          const target = askTarget()
          if (target) s.requestAsk(target, 'agent')
          return
        }
      }

      /*
       * Ctrl+B toggles whatever the side slot holds: the session list in a
       * terminal, the file sidebar in an IDE. One chord for one slot, whichever
       * face the window is wearing.
       */
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        if (s.mode === 'terminal') s.toggleSessions()
        else s.toggleSidebar()
        return
      }

      // Ctrl+J is the panel, as it is in VS Code. Outside the Shift block because
      // it takes no Shift.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        if (s.mode !== 'ide') {
          s.setMode('ide')
          s.togglePanel(true)
        } else s.togglePanel()
        return
      }

      /*
       * Ctrl+K pins the composer's intent, flipping whichever reading is in
       * effect — the way to disagree with what the input autodetected, in either
       * direction. It is claimed globally so it means the same thing wherever
       * focus is: in an editor pane Monaco takes it as a chord prefix and
       * swallows the next keystroke, which reads as the app freezing, and the
       * shortcut is advertised in the composer footer, so it has to work from
       * anywhere rather than only from the composer itself.
       */
      /*
       * Find in this terminal's output.
       *
       * Ctrl+F is what everyone presses, and it did nothing here: the blocks are
       * the whole history of a shell and there was no way through them but
       * scrolling. Only for a terminal — an editor has Monaco's own find on the
       * same chord, and that one is better than anything this would do.
       */
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        const active = tab ? s.panes[tab.activePaneId] : undefined
        if (active?.kind === 'terminal') {
          e.preventDefault()
          s.setFind(s.findPaneId === active.id ? null : active.id)
          return
        }
      }

      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const target = askTarget()
        if (target) s.requestAsk(target, 'toggle')
        return
      }

      /*
       * Zoom, on the keys every application uses for it.
       *
       * The interface was fixed between 8 and 13 pixels with no way to change it,
       * which is unreadable on a dense display. Applied as a zoom factor so the
       * terminal scales with everything else — its cell metrics are not touched by
       * the editor's font settings.
       */
      if (e.ctrlKey && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
        e.preventDefault()
        const current = s.settings.uiZoom || 1
        const next =
          e.key === '0' ? 1 : Math.min(Math.max(current + (e.key === '-' ? -0.1 : 0.1), 0.6), 2.5)
        window.ember.setZoom(next)
        void window.ember.setSettings({ uiZoom: next }).then((r) => s.applySettings(r.settings))
        return
      }

      // Save All. Ctrl+S belongs to the focused editor, and VS Code's Ctrl+K S is
      // not available here because Ctrl+K asks Claude.
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void s.saveAllDocuments()
        return
      }

      // Ctrl+R is history search. Electron's default accelerator would reload the
      // window, so this must claim the key.
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        s.toggleHistory()
        return
      }

      // Ctrl+Shift+G selects a sidebar view, matching the editor convention:
      // pressing it twice collapses the sidebar again. Plain Ctrl+B is the slot
      // toggle above — it never reaches here.
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        s.showSidebarView('scm')
        return
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        s.showSidebarView('github')
        return
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        s.showSidebarView('problems')
        return
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        s.showSidebarView('search')
        return
      }

      // Ctrl+P goes to a file, Ctrl+Shift+P runs a command. Claimed globally, and
      // ahead of the editor, so they work wherever focus happens to be.
      if (e.ctrlKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        s.openPalette(e.shiftKey ? 'commands' : 'files')
        return
      }

      // Ctrl+O opens a file in an editor pane beside the current one.
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openFile()
        return
      }

      if (e.ctrlKey && e.key === ',') {
        e.preventDefault()
        s.toggleSettings()
        return
      }

      // Ctrl+Tab cycles tabs.
      if (e.ctrlKey && e.key === 'Tab' && s.tabs.length > 1) {
        e.preventDefault()
        const i = s.tabs.findIndex((t) => t.id === tabId)
        const next = s.tabs[(i + (e.shiftKey ? -1 : 1) + s.tabs.length) % s.tabs.length]
        s.setActiveTab(next.id)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newTab])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  // In IDE mode a closed panel hides the shells; in terminal mode they are the app,
  // and the panel toggle has nothing to say about them.
  const hideShells = mode === 'ide' && !panelOpen

  return (
    <div className="app">
      <TitleBar />
      <div
        className="workspace"
        data-mode={mode}
        style={{
          // Definite tracks. A percentage size on a grid item inside an `auto`
          // track resolves against a track that is itself sizing to the item, so
          // the panel came out the height of its own contents. A closed region
          // gets no track at all, or it would leave a gap where it used to be.
          //
          // Only the rows are set here now. The columns were inline for the sake of
          // the right-hand Claude sidebar's percentage width; with that region gone
          // every remaining column sizes itself, so the stylesheet can have them
          // back.
          // The trailing auto row is the status chips, which live inside the
          // content column now — the rail and the side slot run past them to the
          // window's bottom edge, the way the picked design draws it.
          gridTemplateRows:
            mode === 'ide' && panelOpen
              ? `1fr ${Math.round(panelHeight * 100)}% auto`
              : '1fr auto'
        }}
      >
        <ActivityBar />
        {/*
          One side slot, two occupants. Sessions fill it while the window is a
          terminal; the file sidebar fills it while the window is an IDE. Rendering
          both would stack them into the same grid area, and showing both at once
          would spend ~500px before any output appeared.
        */}
        {mode === 'terminal' && sessionsOpen && <SessionList />}
        {mode === 'ide' && sidebarOpen && (
          <Sidebar onOpen={(p) => void openPaths([p])} onOpenAt={(p, l, c) => void revealAt(p, l, c)} />
        )}
        {/*
          Both regions are always in the tree, and CSS grid decides where they sit.
          Moving them by rendering them somewhere else would unmount every terminal
          in the tab: xterm is attached to a DOM node, and the pty, the scrollback
          and the block history would go with it. Switching modes must not cost you
          a running shell, so the elements stay put and only their placement changes.
        */}
        {activeTab ? (
          <>
            {mode === 'ide' && (
              <div className="region region--editors">
                {activeTab.editors ? (
                  <SplitView
                    tabId={activeTab.id}
                    region="editors"
                    node={activeTab.editors}
                    path={[]}
                    activePaneId={activeTab.activePaneId}
                  />
                ) : (
                  <div className="empty">
                    <div>No files open</div>
                    <div style={{ fontSize: 11 }}>
                      <kbd>Ctrl</kbd> <kbd>P</kbd> to go to a file
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="region region--shells" data-collapsed={hideShells ? 'true' : 'false'}>
              {mode === 'ide' && <RegionDivider region="panel" />}
              {mode === 'ide' && <PanelBar />}
              <div className="region__body">
                <SplitView
                  tabId={activeTab.id}
                  region="shells"
                  node={activeTab.shells}
                  path={[]}
                  activePaneId={activeTab.activePaneId}
                />
                {/*
                  Inside the body rather than beside it, so "cover everything but
                  the bar" is spelled inset: 0 — the old placement repeated the
                  bar's height as a magic number and drifted every time the bar
                  changed. The terminal stays mounted underneath either way.
                */}
                {mode === 'ide' && panelView !== 'terminal' && (
                  <div className="panel__overlay">
                    {panelView === 'problems' && (
                      <ProblemsPanel onOpen={(p, l, c) => void revealAt(p, l, c)} />
                    )}
                    {panelView === 'output' && <OutputPanel />}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="region region--shells">
            <div className="empty">
              <div>No shells open</div>
              <div style={{ fontSize: 11 }}>
                <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>T</kbd> to open one
              </div>
            </div>
          </div>
        )}
        <SettingsPanel />
        <HistorySearch />
        <Palette onOpenFile={(p) => void openPaths([p])} />
        {dirPicker && dirPickerCwd && (
          <DirectoryPicker
            cwd={dirPickerCwd}
            /*
             * Sent as a command rather than set as state. The shell is the thing
             * that has a working directory — writing one into the pane would make
             * the label and the shell disagree the moment anything used it — and a
             * `cd` in the list is also the record that the move happened.
             */
            onChangeDirectory={(path) => {
              if (dirPickerPaneId) existingController(dirPickerPaneId)?.runCommand(`cd "${path}"`)
            }}
            onOpenFile={(p) => void openPaths([p])}
            onClose={() => setDirPicker(false)}
          />
        )}

        {/* Inside the grid, in the content column: the chips line up with the
            cards above them, and the rail and side slot own the full height. */}
        <StatusBar />
      </div>

      {/* Things that failed away from any panel of their own — a background save,
          the session file, writing settings — rather than being discarded. */}
      {notice && (
        <div className={`notice notice--${notice.tone}`} role="status">
          <span>{notice.text}</span>
          <button className="notice__close" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
