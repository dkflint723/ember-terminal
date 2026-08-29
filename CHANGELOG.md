# Changelog

Notable changes to Ember. Versions follow [semver](https://semver.org); the
newest entry sits on top.

## 0.3.8 — 2026-08-29

An adversarial review of the update code found six real defects in it, all
fixed here. Five were in the machinery added over the previous four releases —
which is a fair account of how much of this system was written faster than it
was checked.

- **Install now works on the first click after a launch.** The updater only
  learns where its staged installer is once a download has run in that
  process, so a fresh launch reported "no update filepath" about a file that
  was sitting on disk, valid. It is now pointed at its own cache before
  installing. The previous release's "self-heal" made this worse by deleting
  the note in response — destroying the only record that the app was behind —
  and that has been removed.
- **The close prompt cannot veto an install.** Agreeing to discard unsaved work
  cleared a count that every window rewrites within milliseconds, so the close
  prompt could reappear and cancel a quit whose installer had already been
  spawned. An install now latches, and the prompt stands aside for it.
- **Quitting for an install no longer costs you your windows.** A flag set
  before an install that can fail without throwing stayed set for the rest of
  the run, and closed windows stopped being dropped from the saved session.
- **Every window learns about a waiting update**, not only the first one — the
  update notification opens whichever window is in front, and that one now has
  an Install now button in it.
- **A newer download supersedes an older staged one.** The button stayed live
  while a newer version downloaded, and pressing it installed the older file
  and cancelled the download in flight.
- **A vanished installer stops being offered.** The waiting-update note put an
  Install now button on screen without checking the staged installer was still
  there, so a cleared cache — or a note that outlived what it pointed at — gave
  a button whose only outcome was "No update filepath provided". That failure
  now tears up the note and says, in words, that the download is gone and
  checking again will fetch it.

## 0.3.7 — 2026-08-29

- **An update you already have stops asking to be installed.** The note that a
  version was downloaded and waiting was cleared only when the running version
  *equalled* the promised one. Land on a version past it — two updates in a
  row, or a newer installer taken by hand — and equality never comes, so Ember
  went on offering to install something it was already ahead of, permanently.
  It now clears when the running version has reached **or passed** the promise,
  so an install that skipped ahead settles itself on the next launch.

## 0.3.6 — 2026-08-29

- **The Install now button is actually there.** It appeared only when the
  status message matched certain words — and the message was reworded a release
  later, so the button silently vanished while the text still told you to press
  it. The updater now carries what a message *means* alongside what it says, and
  the button keys off that. Prose is for reading; state is for deciding.
- **The update notification does something when clicked.** It brings Ember
  forward and opens Settings on the update, one deliberate press from
  installing — deliberate because installing quits Ember, which is not
  something a stray click on a toast should do.
- **Installing asks about unsaved work first.** The installer is spawned before
  the app quits, so a close prompt answered “cancel” would have left an
  installer running against a still-open Ember. It asks up front instead.

## 0.3.5 — 2026-08-29

- **The pinned command sits still and stays readable.** A sticky header comes
  to rest at the top of the scrollport's padding box, and the block list had
  twelve pixels of it — so every pinned command floated in a twelve-pixel band
  of the previous block's output, scrolling past behind it. The list gives its
  top padding to the first card instead, which puts a pinned head flush against
  the top of the pane where nothing can pass above it, and deepens its shadow so
  the output plainly goes under the command rather than colliding with it.

## 0.3.4 — 2026-08-29

- **The update installs where you can see it.** electron-updater applies an
  update by running the installer silently as the app quits, so the only signs
  were a permission prompt and then a minute of nothing — and launching Ember
  during that minute found a half-replaced install and died with a raw
  JavaScript error. Nothing installs silently now. A downloaded update waits,
  says so in the app and on the desktop, and “Install now” runs the installer
  with its own progress on screen. Ember reopens itself when it finishes.

## 0.3.3 — 2026-08-29

The update that can be watched working — and that says so when it isn't.

- **Failures reach the screen.** The updater's progress, finish and failures
  went to the Settings dialog alone, which is shut almost always, and the
  background check runs eight seconds after launch when it certainly is. Any
  outcome that is not mere progress now also raises the notice banner, which is
  on screen whatever you are looking at.
- **The install is verified, not assumed.** The version an update announces as
  downloaded is written down before the quit that installs it. On the next
  launch it is compared with the version actually running: matching means it
  worked, and an older one means the installer aborted without a word — which
  Ember now says out loud instead of running the old build for ever with a
  finished download sitting on disk.
- **"Install now."** When an update is staged, Settings offers to apply it
  immediately rather than waiting for a quit that may be days away, or that has
  already come and gone without the installer taking.
- **The updater keeps a diary.** electron-updater's own account of itself —
  including every decision it makes at quit, when no window is left to tell —
  now lands in `ember.log` instead of a console a packaged build discards.
- **A check that asks the updater, not the version string.** "Up to date" now
  comes from the updater's own verdict rather than comparing two strings.
- New suite `verify-update.mjs`: stands a local feed in front of a genuinely
  packaged Ember and proves the whole download path, including that the
  installer is staged under the exact name the feed declared.

## 0.3.2 — 2026-08-29

- **Updates install again.** Every release so far was un-installable: the feed
  named `Ember-Setup-<version>.exe`, the build produced `Ember Setup
  <version>.exe`, and GitHub — which rewrites spaces — stored a third spelling.
  The feed downloaded, so the app announced an update, and the installer fetch
  then 404'd in silence for ever. The build now produces exactly the name the
  feed declares, and `npm run dist` refuses to finish if the two ever disagree
  again.
- **The updater says what it is doing.** It used to promise "downloading; it
  installs when Ember quits" the moment a version was found and then never
  speak again — a failed download looked exactly like a working one. Settings
  now shows real progress, the finish, or the failure, and a 404 is reported as
  a missing installer rather than a status code.

- **The font picker actually changes the font.** Picking a family reached the
  xterm canvas and the editor, but every HTML surface in the app — the command
  blocks, the composer, the status chips, the agent's code, the debug view:
  sixty-odd rules — is styled `font-family: var(--mono)`, and that variable was
  a constant in the stylesheet. In terminal mode, where what you read is HTML
  rather than canvas, a picked font therefore did nothing visible. The setting
  is now published to the stylesheet the way the font *size* always has been.

## 0.3.1 — 2026-08-29

- **Pickers, not spellings** — Font family is now a dropdown of the monospace
  faces this machine actually has, each option drawn in itself; the pick gets
  Consolas and monospace behind it as fallbacks. Claude model is the curated
  list with each model's note, plus an "Another model id" escape for anything
  newer than the build.
- **The status chips find their band** — in terminal mode the path and Claude
  chips sat bolted to the composer above; they now carry their own air and sit
  a touch nearer the floor, the way the IDE always held them.

## 0.3.0 — 2026-08-28

The release where the machine takes teaching: any language server, any debug
adapter, any shell — one settings row each — plus a real debugger, a second
window, and sessions that move house with their shells alive.

### The editor takes teaching

- **Teachable language servers** — anything that speaks LSP over stdio is one
  settings row away: rust-analyzer, gopls, clangd. The language id must be one
  the editor knows (most are built in); extra file extensions can be mapped
  alongside. Taught servers start the first time their language opens, ride
  the same transport and crash recovery as the bundled four, and a taught
  server for a bundled language wins.
- **Format on save** — off by default, on in Settings → Editor. Explicit saves
  only; auto-save never reflows a buffer mid-thought. `Alt+Shift+F` formats by
  hand either way.
- **The workspace's prettier, when it has one** — formatting walks up from the
  file to the nearest `node_modules/prettier` and runs that copy, config and
  all, on Ember's own runtime (no node on PATH needed). No prettier means the
  language's own formatter answers instead.
- Fixed in passing: settings saved programmatically now reach the saving
  window's own store, not just the other windows'.
- Found on a test drive: one long unbreakable output line could overflow the
  window's grid when the Claude panel opened, crushing the rail and the
  session list to slivers. The content column now yields instead, and the
  panel can never buy its width from the columns beside it.

### Step debugging, grown up

- **Crashes stop the debugger** — adapters' exception filters appear as
  checkboxes in the Debug view; with "Uncaught exceptions" on, a throw pauses
  where it happened instead of ending the run.
- **launch.json works** — a workspace's `.vscode/launch.json` (comments and
  trailing commas included) feeds the "F5 runs" picker, with
  `${workspaceFolder}`/`${file}` substitution; attach configs attach, and an
  "Attach to Node (port 9229)" entry is always on offer. Stopping an attached
  session detaches — it never kills the process you attached to.
- **The program runs as a block** — when a PowerShell pane is standing, the
  debuggee runs in it via the protocol's own runInTerminal: real stdin, output
  in a block, and the debug environment cleaned out of the shell afterwards.
- **Pause and restart** — interrupt a runaway loop, or run the same thing
  again (`Ctrl+Shift+F5`); breakpoints re-arrive on every fresh session.
- **Breakpoints that behave** — they ride buffer edits, survive relaunches
  (conditions included), travel with a session moved to a new window, and can
  carry a condition or a log message from the Debug view; the margin dot says
  which kind it is.
- **A console and hover values** — evaluate expressions in the paused frame
  from the Debug view; hover a name in the editor while stopped and the
  adapter answers with its value. A status-bar chip says when a session is
  live, and multi-threaded stops offer a thread switcher.

### Step debugging

- **A debugger, spoken in DAP** — Ember grew a generic Debug Adapter Protocol
  client: any adapter that speaks DAP over stdio or a TCP port works, and
  adapters can be taught in settings the way custom shells are.
- **Node out of the box** — `npm run fetch:js-debug` bundles Microsoft's
  js-debug (the debugger inside VS Code) into Ember's resources; release
  builds include it. Multi-session brokering — js-debug's child-session
  handshake — is handled, so real programs stop where you asked.
- **The gestures you know** — click the glyph margin or press `F9` for a
  breakpoint (hollow until the adapter verifies it), `F5` to run the active
  file or continue, `F10`/`F11`/`Shift+F11` to step, `Shift+F5` to stop. The
  F-keys act only in IDE mode; in the terminal they still belong to the shell.
- **A Debug view on the rail** — controls, the call stack, variables that
  expand on demand, the breakpoint list, and the program's own output. The
  stopped line is painted in the editor and the file is brought to the front.

### A second window

- **New window** — `Ctrl+Shift+N` opens another Ember window with its own
  sessions, shells, and workspace. Each window closes on its own terms, warns
  about its own unsaved files, and gets its own notifications.
- **Move a session to a new window** — `Ctrl+Shift+U`, the command palette, or
  right-click a session card. The session travels whole: blocks, thread, name,
  editors with unsaved text — and the shell itself stays alive through the
  move, environment and all; nothing is respawned. Refused politely while a
  command is running. A window whose last session moves out follows it.
- **Every window comes back** — the session file now remembers all open
  windows, each with its own place on screen. Closing a window while others
  live is remembered as "don't bring this one back"; quitting brings back
  everything.
- **Settings travel** — a font, theme, or interface-size change saved in one
  window applies to the others without a relaunch.
- **Session cards have a right-click menu** — Move to new window, Rename,
  Close.
- Fixed in passing: saving any setting used to hand the stored API key back to
  the renderer in the response; the write path now redacts it the way the read
  path always has.

### Shells, met on their own terms

- **Custom shells start where you say** — a "Start in" line on each custom
  shell; new sessions open there. A split, a restored pane, or "open here"
  still wins, and a directory that has gone missing falls back to home instead
  of a dead pane.
- **Completion speaks the pane's dialect** — bash-dialect shells complete
  directories with `/` and get bash builtins; cmd gets `\` and its verbs; a
  bash-accented `/d/…` directory is read as the drive it is, and a Linux-only
  cwd keeps path answers quiet instead of reading the wrong disk. Custom
  shells added mid-session now complete as their dialect immediately.
- **First run, said once** — a welcome card in the first empty pane: blocks,
  the IDE flip, where Claude lives. Dismissed by its button or by running
  anything, and never seen again.

### The settings find their shape

- **Settings, grouped** — the one long scroll becomes six sections
  (Appearance, Terminal, Editor, Claude, Keyboard, System) with a rail that
  jumps and follows the scroll. Everything is still on one page; nothing hides
  behind a tab.
- **Shortcut filter** — the keybinding list takes a filter box, by name or by
  chord.
- **Updates on their own line** — the update check moves out from under
  "On launch" into its own labelled field.

### Smaller courtesies

- **Keyboard focus you can see** — a visible focus ring on every control the
  keyboard can reach, drawn only for the keyboard; pointer clicks stay clean.
- **Hints where the eye is** — an empty pane's "run a command" hints sit just
  above the composer, where typing starts, instead of at the ceiling.
- **Session cards say what they're doing** — a breathing dot while a command
  runs anywhere in the tab; a red one when the last command in a background
  tab failed.
- **Copy that answers** — the block-head copy buttons say "✓ copied" for a
  moment, and are labelled `copy cmd` / `copy out` instead of `cmd` / `out`.
- **Each question is a rung** — your turns in the Claude panel sit in a
  shallow well, so long threads read as exchanges rather than one column of
  text.
- **The panel seam lights up** — the agent panel's resize edge shows itself
  under the pointer.

## 0.2.0 — 2026-08-28

The daily-driver release: the agent grows up, and the terminal grows the things
you notice only when they are missing.

### Claude gets a room

- **The Claude panel** — a conversation surface on the right, toggled at will
  (`Ctrl+Shift+B` or the ✦ in the title bar), resizable, one thread per
  session, restored with it. One-shot asks still land in the flow; the panel is
  where follow-ups remember.
- **Streaming and stopping** — answers arrive as they are written, with a Stop
  button that means it.
- **Proposals you can act on** — a file the model proposes opens as an
  accept/reject diff and lands on disk only when you say so; a command it
  proposes carries Run and Copy buttons.
- **Context that follows you** — the thread rides along with each request,
  with the shell's directory, the buffer under the caret in IDE mode (unsaved
  edits included), and any blocks you attach.
- **Prose worth reading** — answers render as markdown: headings, lists, bold,
  inline code, and links that open in your browser.
- **The CLI streams too** — signed into Claude Code without a key, answers
  still arrive as they are written, and Stop still means it.
- **Thread search** — a sieve in the panel header; non-matching turns step
  back, with a count of what matched.

### The terminal earns the rest of the day

- **Clickable output** — file paths (`src/x.ts:42:7`) open the IDE at the line;
  URLs open the browser. Resolved against the block's own directory,
  existence-checked so false positives stay quiet.
- **Custom shells** — teach Ember any shell in Settings (a WSL distro, a Dev
  PowerShell, nushell) with a dialect for full block integration.
- **Git from the panel** — push, pull, and a branch picker that creates from
  whatever you type, beside the ahead/behind counts that were always there.
- **Sessions** — rename on double-click, reorder by drag, both restored.
- **Find sees folded blocks**, unfolding what matches and folding it back.
- **Keyboard remapping** — every window chord editable in Settings; press the
  new keys into the capture button; conflicts named; defaults one click back.

### Sturdier under the hood

- **Flow control** — a flooding command now waits for the renderer the way it
  would for a physical terminal, instead of drowning the window.
- **Language servers come back** — a crashed server is respawned with its
  handshake replayed and its documents re-opened; if it keeps dying,
  TypeScript's bundled worker stands back up.
- **Memory has ceilings** — closed editors park at most twenty models; command
  history caps at twenty thousand rows; a command's living output is bounded.
- **History recalls whole logs** — the searchable copy of an output grew from
  8 KB to 100 KB.
- **Crashes reach a person** — faults land in `ember.log` and, packaged, say so
  once in a dialog.
- **Dark themes float again** — dark elevation is surface contrast and a lit
  rim, derived per theme.
- **The taskbar shows the ember** — the app introduces itself to Windows before
  its first window, under an identity dev builds cannot poison, wearing the new
  campfire mark chosen from ten candidates.

## 0.1.0 — 2026-08-28

The first cut. Everything below is new, because everything is.

### The terminal

- Commands run as **blocks**: each command and its output is a card that can be
  collapsed, copied, re-run, and found again after a restart. Session restore
  brings back the window, the tabs, the splits, and the blocks themselves.
- ConPTY-backed shells with OSC 133 shell integration for PowerShell — exit
  codes, durations, and working directories are read from the shell, not
  guessed. cmd, Git Bash, and WSL run as plain terminals.
- Tab completion, history suggestions, and searchable cross-session command
  history (Ctrl+R), with inline secrets kept out of it.
- A directory browser on the path chip, terminal find (Ctrl+F), and desktop
  notifications for commands that finish while the window is in the background.

### The agent

- Claude answers inside the terminal as its own kind of block. Questions route
  to the API or the Claude Code CLI, with per-request model, effort, and
  mode control from the composer's chip.

### The IDE

- One keystroke (Ctrl+Shift+I) turns the window into an editor: Monaco with
  language servers (TypeScript, Python, YAML, PowerShell and more), a file
  tree, workspace search and replace, problems, an outline, and go-to
  definition. The terminal becomes the panel; nothing restarts.
- Git status, staging, diffs, and commits, with branch, ahead/behind, and
  line counts in the status chips. A GitHub panel lists and checks out pull
  requests through the `gh` CLI.

### The window

- The Direction D look: cards on a gradient, a session sidebar, chip status
  row, and a global search that reaches sessions, files, and commands from
  one box. Themes are VS Code color themes dropped into a folder; ten ship
  in the box, dark and light, including two colour-safe pairs.

### The machinery

- Windows installer (NSIS) with a signed-by-checksum blockmap, session-safe
  auto-update (off by default, checked from Settings on demand), crash
  reporting to `ember.log`, and 36 Playwright verification suites that drive
  the real app.
