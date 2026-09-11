<p align="center">
  <img src="resources/icon.png" width="96" alt="Ember" />
</p>

<h1 align="center">Ember</h1>

<p align="center">
  A terminal for Windows where every command is a block you can keep —
  and the same window is an editor, with Claude already in it.
</p>

![The terminal](docs/terminal.png)

## The idea

A terminal loses things. Output scrolls away and takes the command that produced
it along; finding either again means squinting at a wall of text you cannot
select cleanly. Then the moment you want to change a file you leave for another
program, and the shell you were standing in is somewhere behind that window.

Ember keeps the work in one place.

**Every command is a block** — the command, its output, its exit code, when it
ran and how long it took, held together and still there tomorrow.

**The same window is an editor**, one keystroke away, with your shell still
running underneath it.

**Claude is already inside**, so "why did that fail" is a question you ask where
it failed rather than somewhere else.

It is a Windows app, built around PowerShell, and it does not pretend otherwise.

## What that feels like

**Commands you can come back to.** A block collapses, copies — the command, the
output, or the whole thing as Markdown to paste into an issue — and re-runs on a
press. It says which directory it ran in, but only when that changed, so a
session reads as a story rather than a stutter of repeated paths. Blocks survive
quitting: reopen Ember and last week's failure is still there with its exit code,
and `Ctrl+R` searches every command you have ever run.

**An editor a keystroke away.** `Ctrl+Shift+I` and the window is Monaco with real
language servers, a file tree, search, problems and git — while the terminal
becomes the panel underneath. Nothing restarts, no shell is lost, and pressing it
again puts you back.

![The IDE](docs/ide.png)

**Claude, where the work is.** Type a question instead of a command and it goes
to Claude rather than the shell — the composer reads which you meant and says so
before you press Enter. `Ctrl+↑` attaches the command that just failed, so the
question arrives carrying the error. Answers stream into a panel beside the
terminal that remembers each session, and a proposed edit arrives as a diff you
accept or reject rather than a block of text to copy by hand.

## Everything it does

- **Blocks** — collapse, copy, re-run, share as Markdown, jump between them with
  the overview ruler. Restored on launch and bounded in memory and on disk, so a
  window left open for a fortnight still starts quickly.
- **Shell integration** — PowerShell, Git Bash and WSL report where each command
  starts and stops, its exit code and its directory, through OSC 133. cmd has no
  integration script and runs as a plain terminal, which the pane says out loud
  rather than leaving you to wonder.
- **Inline suggestions** — grey text ahead of the caret, in the editor *and* on
  the command line, off until you ask for them. Answered by a model on your own
  machine (Ollama, llama.cpp, LM Studio), any OpenAI-compatible endpoint, or
  Claude. On the command line your own history answers first — instant, free, and
  usually right — and the model is asked only where history has nothing, in the
  dialect of that pane's shell. Take one with `Tab` in the editor, or `→` / `End`
  on the command line, where `Tab` belongs to shell completion. Local models are
  asked to fill in the middle rather than to chat, and the picker marks the ones
  that cannot: several recent "coder" models dropped the ability and kept the name.
- **The agent** — a panel of its own (`Ctrl+Shift+B`) with threads that stream and
  remember per session, a Stop that means it, and proposals that open as
  accept/reject diffs or runnable commands. Through your own API key or the Claude
  Code CLI you are already signed in to.
- **Edit with Claude** — select code in the editor, press `Ctrl+I`, say what you
  want changed, and it is rewritten in place as one undoable edit.
- **IDE mode** — TypeScript, Python, Bash, YAML and PowerShell language servers in
  the box, and any other LSP server teachable in settings (rust-analyzer, gopls…);
  go-to-definition, snippets, auto-save, format-on-save with the project's own
  prettier when it has one, split panes, search and replace.
- **Debugging** — breakpoints in the margin (`F9`, with conditions and logpoints),
  `F5` runs the active file or a `.vscode/launch.json` config, attach included;
  step, pause, restart; exception filters; variables, threads and the call stack,
  values on hover, and a console that evaluates in the paused frame. The program
  runs as a real block in the terminal, stdin and all. Node through bundled
  js-debug; any DAP adapter can be taught in settings.
- **Scripts and tests** — the commands your project already declares, listed from
  its `package.json` and one press from running (`Ctrl+Shift+R`). The lockfile
  decides whether that is npm, pnpm, yarn or bun. Test files are listed the same
  way, so you can run one without typing its path, and your own saved commands sit
  beside them — anything in double braces, `deploy {{env}}`, is asked for first.
- **Git** — status, staging, diffs, commits, branch and line counts in the status
  chips; blame for the line the caret is on, a log you can open a commit from, and
  a stash that takes untracked files with it. A GitHub panel checks out pull
  requests through `gh`.
- **Sessions** — the sidebar lists every open shell with its directory and branch,
  and marks the ones doing something while you are looking elsewhere. Each session
  carries its own project. The whole window comes back on launch, unsaved edits
  included.
- **SSH** — every `Host` in your `~/.ssh/config` appears as a shell to open, so a
  server is a session rather than a command to remember.
- **An administrator window** — `Ctrl+Alt+Shift+N` opens a second Ember running
  elevated, beside the ordinary one rather than instead of it, with a badge in its
  title bar for its whole life. It keeps its own settings, session and history,
  because a file written by an administrator is one the ordinary Ember may not be
  able to replace.
- **History** — every command searchable across sessions (`Ctrl+R`), with inline
  secrets scrubbed before anything is written down.
- **Themes** — any VS Code colour theme. Drop a `.json` into the themes folder and
  it appears in the picker. Ten ship in the box, including colour-blind-safe
  pairs, and every surface in the app derives its own colours from whichever you
  choose — including the light it is lit by.
- **Density** — how much room a block takes is a setting, not a verdict: Compact,
  Normal or Comfortable, applied as you pick it.

## Install

Grab `Ember-Setup-<version>.exe` from
[Releases](https://github.com/dkflint723/ember-terminal/releases) and run it.

> It is not code-signed, so SmartScreen will ask whether you mean it. Updates are
> **off by default** — turn them on in Settings, or press "Check now" whenever you
> like. A new version downloads in the background and waits; installing it runs
> the installer where you can watch it, and nothing is replaced underneath a
> running shell.

## Keyboard

| Chord | Does |
| --- | --- |
| `Ctrl+Shift+I` | Terminal ↔ IDE |
| `Ctrl+Shift+A` | Search everything — sessions, files and commands together |
| `Ctrl+P` / `Ctrl+Shift+P` | Go to file / commands |
| `Ctrl+Shift+T` | New session |
| `Ctrl+Shift+N` | New window |
| `Ctrl+Alt+Shift+N` | New window as administrator |
| `Ctrl+Shift+U` | Move session to new window |
| `Ctrl+Tab` | Next session |
| `Ctrl+B` | Side slot — sessions (terminal) or files (IDE) |
| `Ctrl+J` | Panel, bringing the IDE with it |
| `Ctrl+Shift+B` | Claude panel |
| `Ctrl+K` | Pin the composer to shell or agent |
| `Ctrl+Enter` | Send the composer's text to Claude |
| `Ctrl+↑` | Attach the last failed block to the question |
| `Ctrl+I` | Edit the selection with Claude (editor) |
| `Tab` / `→` `End` | Accept an inline suggestion — editor / command line |
| `Shift+Tab` | Leave the terminal for the composer |
| `F5` | Debug: start, or continue |
| `F9` | Debug: toggle breakpoint |
| `F10` / `F11` / `Shift+F11` | Debug: step over / in / out |
| `Shift+F5` | Debug: stop |
| `Ctrl+F` | Find in the terminal or editor |
| `Ctrl+R` | Search command history |
| `Ctrl+O` | Open a file |
| `Ctrl+Shift+F` `G` `H` `M` `R` | Search, source control, GitHub, problems, scripts — each brings the IDE |
| `Ctrl+Alt+S` | Save all |
| `Alt+Shift+F` | Format document |
| `Ctrl+=` `-` `0` | Zoom |
| `Ctrl+,` | Settings |

Every chord is rebindable in Settings. The hints the app shows you retire
themselves once you have pressed the key they were teaching, so the legends thin
out as you learn them.

## Building it

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run dist
```

`dev` runs with hot reload; `dist` produces the NSIS installer in `release/`.

### Verifying it

There is almost no unit-test suite. Instead there are sixty-odd Playwright
scripts under `scripts/verify-*.mjs`, nearly all of which launch the real app
with a throwaway profile and drive it like a hand — typing into the composer,
pressing chords, reading what is on screen. (The contrast suite is the exception:
it is arithmetic over the theme files and needs no window.)

```bash
npm run verify:all
```

That runs the type checker, the unit tests and a build, then hands the suites to
`scripts/gate.mjs`, which runs them one at a time at below-normal priority — the
machine stays usable while it grinds — and reports every failure at the end rather
than stopping at the first. A suite fails when any check fails, when the page
throws, or when the main process logs a fault while it runs. Every
`verify-*.mjs` has to be listed in the gate or set aside with a written reason; a
suite that is neither fails the gate before anything runs. Together they cover the
terminal and its blocks, session restore, the editor, language servers, the
debugger, git and GitHub, Claude, inline suggestions, search, the administrator
window, per-session workspaces, themes and contrast, keyboard chords,
accessibility, crash recovery, flow control, the updater, and the packaged build.

To run part of it after a change:

```bash
npm run verify:gate -- --only output,live
```

The rule the project holds itself to is that **no check is believed until it has
been watched to fail**. A check written against a bug that is already fixed proves
nothing, so each one is first run against the broken code and the failure it
produced is recorded in the commit that fixes it. Several checks written this way
turned out to pass whether the bug was present or not; those are the ones worth
finding.

## License

[MIT](LICENSE)
