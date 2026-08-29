# Changelog

Notable changes to Ember. Versions follow [semver](https://semver.org); the
newest entry sits on top.

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
