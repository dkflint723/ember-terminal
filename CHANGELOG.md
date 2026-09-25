# Changelog

Notable changes to Ember. Versions follow [semver](https://semver.org); the
newest entry sits on top.

## Unreleased

### Settings that check what they are given, and can be undone

- **Cancel undoes every preview.** Theme, interface size and block density all
  apply as they change, so they can be judged by looking — and Cancel put back the
  theme alone, leaving a window zoomed to 150% and "cancelled" at 150%. All three
  go back to what is saved.
- **Edits are not thrown away by accident.** Escape and a click outside the dialog
  discarded every unsaved change at once, and a click a few pixels wide of the
  dialog is the easiest mistake in the app to make. With something changed, both
  ask — "Discard 3 changes?" — and Escape again means keep editing. Cancel is a
  decision and still does not ask.
- **Buttons that act before Save say so, or ask.** *Test* saves the suggestion
  settings it tests, and is now called *Save and test*. *Remove saved key* acts at
  once and cannot be undone, and now takes a second press.
- **Main checks every value it is given.** It used to spread settings.json over the
  defaults and trust whatever it held, so a hand edit that left the list of shells
  as a string reached the shell spawner as a string, and a font size of 400 reached
  the terminal. Each field is now read for what it should be — numbers brought
  into the range the dialog offers, choices held to the ones there are, list
  entries that are missing a program or have their arguments as one string left
  out — at startup, on every save, and from any caller rather than only the
  dialog. What was changed is said: at startup once, and after a save that had to
  adjust something. Two fields the dialog used to write back into settings.json
  and never read, `hasApiKey` and `hasGhostKey`, are no longer kept.
- **Search finds any setting**, by what the field says — its label, its choices,
  its explanation — rather than only among the shortcuts.
- **Import, export and reset.** An export is the preferences only: never a key, and
  nothing that describes this machine rather than a taste — its window, its recent
  and trusted folders, what it has learned. An import is checked the same way, but
  strictly: a file with a string where a list belongs is refused whole, with the
  reasons, rather than taken in the parts that happen to fit. What it holds lands
  in the dialog to be looked at, and nothing is kept until Save. *Reset all…* asks
  first and does the same. *Show settings.json* opens its folder, with a note that
  the file is read at startup.
- **Rows that start programs say so.** Under custom shells and language servers:
  Ember runs this program with your permissions whenever a session or a matching
  file opens.
- **How it is checked.** A new unit table, *settings check*, holds 42 cases: the
  defaults pass untouched; ranges clamp and say so without refusing; nine kinds of
  wrong value are left out and refused on import; list entries are kept or left
  out one by one; and an export carries no key, no trusted folder and no window,
  and reads back through the import check without a word. *settings* now asks
  before discarding on Escape and on a click outside, checks that Cancel puts back
  zoom and density, sends main a font size of 400 and a list of shells as a
  string, searches, and — with the native file dialogs answered from main —
  exports without the key, refuses a broken import and takes a good one into the
  draft without saving it. Green on the Windows runner beside *rebind*, *keys*,
  *a11y*, *profiles* and *admin*, which also drive the dialog.
- **What was and was not watched failing.** Against the dialog as it was, on the
  Windows runner, *settings* never got past its first new check: Escape discarded
  the edited draft at once, so there was no dialog left to ask a question in, and
  the run ended there — three times, at three different steps, as the check was
  made to survive one more of them. That is the defect, seen; but the checks after
  it (Cancel and the previews, main's clamping, search, import and export) were
  seen passing on the fix and not seen failing on the old dialog. The validation
  underneath them was: its unit table fails when a range or the list check is
  broken on purpose.
- **Not done here:** a settings UI for debug adapters, which can still only be
  added by editing the file; the file itself carries no schema version, though an
  export does.

### Contrast themes, dialogs that keep focus, and Settings that says what each box is

- **A Windows contrast theme erased every selection.** It repaints the colours an
  app names and removes box-shadows, so the chosen row in the palette, history and
  completion lists — a hover fill and an inset bar — looked like every other row,
  the session being looked at looked like the rest, and a failed session's square
  and the ruler's failure marks, all fills, were gone. The focus ring was a
  translucent accent that the forcing turned into the colour of every border. Under
  a contrast theme the chosen thing is now drawn the way Windows draws a selection,
  Highlight behind HighlightText; a current tab or a pressed toggle has a Highlight
  edge; the focus ring is solid Highlight; and the marks are drawn in CanvasText.
- **ANSI colours are held to 4.5:1**, like the app's own text. Only black was ever
  lifted, so a program's warning in bright yellow was 3.2:1 on the light fallback
  and Solar Dusk's red 2.3:1 on its own background. Each colour is moved toward the
  theme's foreground only as far as it takes, against the terminal's background and
  the grounds a block's output sits on, so most of them do not move at all. Black
  keeps its gentler floor: it is meant to be the darkest thing on a dark screen.
- **The palette and history search are dialogs.** Every picker — commands, files,
  the directory picker, scripts, branches — is a modal dialog around a combobox
  whose `aria-activedescendant` names the row the arrows are on, so a screen reader
  hears the row rather than nothing. Tab stays inside: the palette's rows were
  buttons in the tab order, so a few presses walked out of an overlay still drawn
  over everything. History search's filters are real stops, and Tab cycles through
  them. Its forget buttons, the pointer's copy of Shift+Delete, are out of the tab
  order, and the footer now says Shift+Delete forgets.
- **Escape closes a dialog from wherever focus is in it.** Only the search box
  listened for it, which was harmless while Tab could not reach anything else —
  and stopped being harmless the moment the filters became stops. The first run
  of the new checks found it: Tab to a filter, and history search could not be
  closed from the keyboard at all.
- **Closing either gives focus back.** It only set state, so focus fell to the body
  and the next keystroke went nowhere. Whatever had focus when the dialog opened
  gets it again — unless the pick put it somewhere on purpose, like an editor for a
  file just opened, or unless that was an idle terminal, whose input is invisible.
- **Every control in Settings has a name.** Labels were sibling elements with no
  `htmlFor` anywhere in the dialog. One that names one control is paired with it;
  one that heads a group — a checkbox row, a list of saved commands — labels a
  `role="group"`, and each row's inputs are named for their place ("Custom shell 2:
  arguments") rather than left to a placeholder. A shortcut button says its
  command, its chord and that pressing it changes it.
- **How it is checked.** *theme contrast* measures all fifteen ANSI text colours in
  all ten themes; before the lift, 58 of those failed. *keyboard and a11y* checks
  the palette's roles, that the active option follows the arrows, that Tab stays
  inside, and that Escape hands focus back to the composer; the same for history
  search, with its filters reachable; that every visible control in Settings has a
  name and every group a label; and, with forced colours emulated, that the chosen
  palette row is still told apart and a failure on the ruler is still drawn.
  *settings* reads group headings as well as labels. Run on the Windows runner
  against the pickers, Settings and stylesheet as they were, twelve of those
  failed — among them every role, both focus returns, ten unnamed controls in
  Settings, the shortcut buttons' names and the ruler's mark. One passed there that
  should not have: the chosen row under forced colours was compared as a computed
  string, and the old opaque Canvas and the other rows' transparent-over-Canvas are
  two strings for one colour. It compares what is on screen now.

### A screen reader hears where Enter goes, and what came of it

- **The composer had no name.** Its placeholder is empty while it is reading the
  line as a command, so a screen reader landed on "edit text, blank". It is called
  *Command or question* now, and it is described by a sentence the screen never
  shows — "Enter runs in PowerShell 7 (autodetected)", or "Enter asks Claude" — so
  the choice between running a line and sending it away is heard on focus, not
  only seen in the small word beside the input. The two inputs a running program
  gets are named for what they are, the masked one included.
- **Nothing announced a finished command.** A block is drawn and that is all, so
  someone who cannot see it had no way to know it had arrived, or that it had
  failed. Each terminal pane has a polite status region that says
  "npm test failed, exit 1", or "git status finished, exit 0", or what Claude
  answered. A block is announced the first time the pane sees it finished, rather
  than when running turns into done: a command quick enough to start and finish
  in one chunk of output reaches the pane already finished. What a pane holds when
  it first appears — restored blocks, or a session switched back to — is not
  announced, and nor are blocks an Undo after Clear puts back, because none of it
  is news.
- **The Claude panel's thread is a log**, named, and busy while an answer streams,
  so the answer is read once, whole, rather than as a run of fragments.
- **Screen reader mode.** A setting, under Appearance, that turns on xterm's
  screen-reader tree — its rows are otherwise pixels in a canvas — and tells
  Monaco a screen reader is running, which inside Electron it otherwise guesses is
  not. It takes in terminals and editors that are already open. Off by default,
  because the tree is rebuilt as output arrives; the name, the description and
  the announcements above do not depend on it. Editors are named for the file
  they show, whichever mode.
- **How it is checked.** *keyboard and a11y* reads the composer's name and follows
  its `aria-describedby` for both readings of a line; runs `cmd /c exit 3` and
  waits for the pane to say "exit 3" and the command, then a command that
  succeeds; opens the Claude panel and reads the thread's role, name and busy
  state; and turns screen reader mode on and off under an open terminal, waiting
  for xterm's tree to appear and to go. Run on the Windows runner against 0.4.0
  before any of this was written, eight of them failed — the name, both
  descriptions, all three announcement checks, the log, and the tree. The three that passed there say what should be *absent* (no tree by
  default, none after turning it off, no busy thread at rest), and could not
  have failed on code that has no tree and no log at all.
- **Not done here, and still owed from the audit's R18:** Windows contrast themes,
  dialog semantics for the palette and pickers, labels paired in Settings, and
  ghost suggestions, which stay silent to a screen reader while Right and End
  accept them. How NVDA treats xterm's tree inside Electron 43 has not been tried
  by hand.

## 0.4.0 — 2026-09-25

The largest release so far, and the first built, installed and tested on a machine
that is not the maintainer's. Eighty-one entries follow; this is what they add up
to.

**Safer by default.** Opening a repository no longer runs it — a folder's scripts,
debugger and formatter wait until you trust it, and trust follows the folder under any
of its names. Shell integration can no longer be forged by a program's output.
Pasting into a terminal asks before anything runs. Credentials are kept out of history
and out of what is sent to a model. Commands typed on your behalf only ever go to a
prompt.

**Your work is harder to lose.** A save never writes over a newer file on disk, and
open editors follow changes made outside. Files that are not UTF-8 open and save as
what they are. Closing asks before it ends a running command, the question no longer
freezes Ember while it waits, and it steps aside if the command finishes. A crash puts
the workspace back.

**The terminal does what it shows.** An Enter no longer resizes the terminal, which
was behind lost and doubled output lines, one command appearing as two blocks, and Git
Bash dropping the first letters of a command. Half a line typed into a running
program is no longer lost when the program ends first, and the first Tab in a new pane
completes. Ember exits when its window closes, instead of occasionally running on or
crashing on the way out. bash and WSL report the exit codes, timings and directories
they had been claiming to.

**The editor and git.** Rename works — it never had. TypeScript diagnostics appear in a
folder whose name has a space. Commits wait for their hooks and can be stopped; a
half-finished merge or rebase can be finished from the panel; blame follows the line
on screen; stashing takes untracked files; discarding one file no longer deletes others
with similar names. Short Windows path names are written out in full, so the explorer,
git and the terminal agree about which folder you are in.

**Things that behave differently.**
- A terminal stops following its output only when you scroll, click or type in it —
  or ask the find bar or the ruler to take you somewhere. Scrolls made by the page on
  its own no longer count.
- A line typed into a running program and not yet sent moves to the composer when the
  program ends, and waits there for Enter.
- PowerShell prompts are drawn from the top of a cleared console.
- A command can wait a fraction of a second after the pane is resized before it is sent.
- Folders and files opened by an 8.3 short name are shown by their full name.

**Known limitations.**
- Resizing the window while a command runs can still disturb that command's block.
- The update feed is not signed, as in every previous release.
- A found line can drift out of view when the command after it finishes; the view no
  longer jumps to the end, but it does not yet hold the match exactly.

### Every suite's close is bounded, and says what held it open

- **Sixty-six suites still closed with no time limit.** Six suites used the bounded
  close; every other gated suite ended with a bare `app.close()`, some once per
  relaunch. Any of them that left a command running, or hit a close that stalled, sat
  until the gate killed it at twenty minutes and printed nothing, not even the checks it
  had already failed.
- **Every close in the gate is bounded now.** Each launch watches what is running from
  its first window, and each close goes through `closeApp`: twenty seconds, then a
  failure that names the command the window was asking about, or what was still alive
  under it, with the process tree killed. A close that ends with a non-zero exit code
  fails too. A suite that launches more than once says which launch would not close.
- **Each suite keeps its own reporting.** `verify-editor` closes before it gives its
  verdict and includes the close in it. In `verify-lsp` a language skipped for having no
  server still fails if its window would not close. `verify-bash`'s own bound now kills
  the whole tree, not only Electron. `verify-keeps-work`'s deliberate quit-and-Cancel is
  unchanged; only its last close is bounded.
- **Not proven:** `verify-vsix`, `verify-github` and `verify-claude-login` are changed the
  same way, but the hosted runner skips all three. `verify-packaged` and `verify-update`
  still close with no time limit.
- **How it is checked:** with `ping -t` left running at the close on purpose,
  `verify-find`, `verify-editor`, `verify-bash` and `verify-lsp` each fail in about half
  a minute naming the command, where master's `verify-find` sits for the full twenty
  minutes. The full gate on the branch had no timeouts and 69 of 70 passing; the one
  failure was `verify-git`'s fixed-pause push check, which the source-control entry below
  replaces.

### Source control's suite waits for git rather than for the clock

- **Four checks in `verify-git` read the result of a git operation after a fixed pause**:
  staging, push, pull and switching branches. On a hosted runner each outlasted its
  pause at least once. The worst was the push: the remote did not have `main` yet, so
  the push check failed, and the clone further down that needs `main` threw and took
  the suite with it before any results were printed.
- **Each now waits, for up to twenty seconds, for git or the panel to show the thing is
  done**: the file in the index, the commit in the remote and the upstream in the panel,
  the pull's commit checked out with the index released, the branch switched. A step
  that never finishes still fails, and the staged-section check says how long it waited.
- **A rewrite of a 33 MB file just after committing it retries** for up to ten seconds.
  It failed once with `UNKNOWN` from `open`, most likely a scanner holding the new file.
- **How it is checked:** on the runner, where `verify-git` passed 5 runs of 5 with all
  four waits in place. Nothing here changes the app.

### A line typed into a running program is kept when the program ends

- **Half a line typed while a command ran was lost if the command finished first.**
  What you type into a running program is held until Enter, in an input that exists only
  while something runs, and the program ending took the input away with the line in it.
  Typing the next command into the tail of a long one lost its first characters that
  way: `Write-Output "BBB-0"` begun a moment before the first command ended reached the
  shell as `B-0"`, and the stray quote left PowerShell waiting on a string that never
  closed. `verify-live`'s typed-ahead rounds hit this on a hosted runner, and every
  round after it failed with it.
- **Now the unsent line moves to the composer** when the program ends, with the caret at
  its end, and waits there for Enter. It is not sent: it was typed for a program that
  has gone, and the shell is a different reader. A secret being typed is never moved.
- **The typed-ahead rounds now count only a second command that arrived exactly as
  typed.** They used to ask only whether the marker was in it, so `e-Output "BBB-0"`
  counted as output crossing between blocks when nothing had crossed. A mangled command
  is now a missed round, reported with what was typed and what arrived, and whatever
  half-line reached the shell is interrupted so it cannot fail the rounds after it.
- **Not proven:** that this is the only way those rounds lost characters. A trace of 60
  rounds on the runner caught no failure. In every one the keys went into the running
  program's input, and the first command ended 223–803 ms after the second one's Enter,
  against 155–247 ms of typing. The first command ending during that typing is the
  failure, one typing-length from the closest round seen.
- **How it is checked:** `verify-live` types half a line into a `Start-Sleep -Seconds 3`
  and leaves it unsent while the sleep ends, then reads the composer. The previous build
  leaves it empty in 16 runs of 16; this change leaves the line there in 12 of 12.

### The first Tab in a new pane completes

- **The first completion asked of a pane could come back empty.** The PowerShell that
  answers completions was started on the first Tab, and PowerShell's completion engine
  loads its command tables the first time it is asked anything. That first answer could
  take longer than the second and a half a completion is given, so the Tab that was
  pressed first got nothing, and the same Tab a moment later worked. On a hosted runner
  `verify-completion` failed 2 runs in 6 for exactly this.
- **Now the completer starts with the pane**, and asks itself for `Get-ChildIt` before
  it says it is ready, so the engine's first load is spent before anyone is waiting on
  it. It gets ten seconds to become ready rather than four.
- **How it is checked:** `verify-completion` now asks for an ordinary command name first,
  which is the case that was failing. Ten runs on the runner with this change, ten
  passes; six on the previous build, two failures.

### A window's close question no longer freezes Ember, and withdraws itself

- **The question stopped the main process until somebody answered it.** It was a
  synchronous dialog, so while it was up no shell output reached any window: a command
  that finished a moment after the question appeared could never be seen to finish, and
  its block said "running…" behind a dialog asking whether to end it. Every other
  window's terminals stopped with it. Pressing a script whose command fails at once —
  `pnpm run build` without pnpm — and closing straight after was enough.
- **Now Ember keeps working while it asks.** When the command ends and nothing would be
  lost, the question withdraws itself and the window closes. Cancel still means Cancel;
  a command that does not end, or unsaved work, keeps the question up.
- **How it is checked:** the new `verify-close` suite runs against the real dialog. With
  a four-second sleep running the window must be asked, then close once the sleep ends;
  with `ping -t` running it must still be asking eight seconds later. The first half
  fails 3 of 3 on the previous build and passes 9 of 9 with this change.

### Ember exits when it is closed, even with a shell that has not

- **The window closed and Ember kept running.** At quit the main process waited in
  Node's shutdown for node-pty's per-shell watcher, and the shell it watched was still
  alive: on Windows node-pty ends a console's programs later and asynchronously, and at
  quit there is no later. On the runner, 8 closes in 91 left Ember running three and a
  half minutes afterwards.
- **Or it crashed on the way out.** A shell ending a moment too late had its exit
  delivered after JavaScript had stopped, and node-pty threw from inside that delivery
  (0xE06D7363, with a crash dump left in the profile) — 12 closes in 91.
- **Quitting now ends every shell and waits to hear each one end**, for up to three
  seconds, before the process goes. With shells open, the process lingers about a second
  after its window has gone.
- **Not proven:** that a hung instance also held the single-instance lock and would have
  stopped Ember reopening. It follows from the code; it was not tested.
- **How it is checked:** `verify-plain` keeps a shell that has let go of its console open
  at close, and the bounded close fails if Ember is still running twenty seconds later or
  exits with anything but 0. On the previous build it fails 20 of 20, and integration
  crashes 3 of 20; with this change both pass 40 of 40.

### Suites finish their commands, and a close cannot hang the gate

- **Four suites timed out at twenty minutes on most nightlies, printing nothing.**
  `verify-dirpicker` and `verify-live` left a command running — a program holding the
  terminal, and a full-screen one that a DOM-based wait could not see — and sat at the
  close question every time. `verify-integration`'s timeouts were the older garbled-line
  bug fixed by "An Enter no longer resizes the terminal", sitting behind a close with no
  time limit.
- **Each now ends its own work before closing, and the close is bounded.** A shared
  `closeApp` in `harness.mjs` waits up to twenty seconds for Ember to exit, fails on a
  non-zero exit code, and otherwise kills the process tree and fails with a reason: the
  command the window was asking about, or the processes still alive. Integration, plain,
  live, dirpicker, scripts and the new close suite use it; the rest of the suites still
  close with no time limit, and moving them over is outstanding.
- **How it is checked:** with the commands left running on purpose, `live` and
  `dirpicker` now fail in under a minute naming the command, rather than sitting silent
  for twenty. The full gate passes seventy of seventy in 38 minutes, against fourteen
  failures and 74 minutes before.

### A file Claude Code names by its short name is the one already open

- **The editor matched a file's path as text.** A file on the command line is opened by
  its long name, so a Claude Code session asking about it by its short one was told
  "Document not open in the editor." about the file on screen: `saveDocument` never
  reached its save-conflict check, and `checkDocumentDirty` said the same.
- **And `openFile` opened a second copy** of a file that was already open, with its own
  buffer that could be saved over the first. Any other way of reaching a file by its
  short name took the same route.
- **Short names are written out on the way in.** Every tool call's file arguments, and
  every file read, now name the file by its long name, by the rule the command line
  already follows. Junctions and substituted drives keep the spelling the person chose.
- **Not covered:** a file reached through a junction is still a second spelling, on
  purpose; `getDiagnostics` still matches a URI as text; and whether a CLI started in
  a short-named directory finds the window has not been checked.
- **How it is checked:** `verify-ide` asks by the file's 8.3 name on purpose: the open
  file must be found, no second copy may open, and a read must come back long. All
  three fail against the previous build on the runner and pass with this change. On a
  volume that keeps no short names the suite says so rather than passing.

### Suites name their scratch folder the way the app does

- **Eleven suites failed at once on the full gate after the long-name change**, which had
  been checked only on the three suites it was about. Where TEMP is an 8.3 short path,
  as on the hosted runner, `os.tmpdir()` gave each suite `RUNNER~1` and the suites
  compared that as text with the long name the app now shows. Eight were those text
  comparisons; the rest were real — workspace trust, and the entry below.
- **One shared helper instead of eleven patches.** `workDir()` in `profile.mjs` makes each
  fixture folder where it always was and names it as the filesystem does; `shortName()`
  sits beside it for checks that want a second spelling on purpose. `verify-explorer`
  and `verify-git` keep their deliberate short-path and junction cases.
- **How it is checked:** on the runner the eleven fail on master and pass with only the
  long-name change reverted, which pins the cause, and with this and the trust fix the
  whole gate goes from fourteen failures to two — the two being the close hang, which
  is separate. The practice this broke is now written down: an app change gets the
  whole gate on its branch before it lands, not only the suites it was written for.

### A trusted folder stays trusted under its other names

- **Trust was kept by spelling, not by folder.** A folder's trust was written down in
  whichever spelling it arrived in and checked against whichever spelling it had
  later, and Windows gives one directory names that share no text: an 8.3 short name,
  a junction, a substituted drive. Once short names on the command line started being
  written out, a folder trusted as `C:\Users\LONGNA~1\proj` opened as
  `C:\Users\LongName\proj` and was restricted again — scripts refused, the debugger
  refused, the workspace's Prettier not run. One reached through a junction was
  restricted whichever side had been trusted, and always had been.
- **Both sides are now the folder's real name.** Main records each trusted folder the
  way the filesystem finally names it — short names written out, junctions followed —
  for a grant, a whole list, and a short-named entry in an older settings file; a
  revocation withdraws both spellings. The window asks main for the real name of the
  folder it is asking about, and a folder is trusted by either name. What is shown on
  screen keeps the spelling the person chose.
- **How it is checked:** `verify-scripts` makes a junction to its project and checks
  trust given through it, used through it, and withdrawn through it. On the build
  before this every one is refused as restricted, and `verify-typing` fails on the same
  notice on the runner; with it both pass, three runs in a row. The short-name case is
  only exercised where TEMP is a short path, as on the runner.

### verify-typing reaches its button the way a reader would

- **The check scrolled a button into view in code, and the pane took it back.** Since a
  terminal stops following its output only for a real gesture, a scroll made in code
  no longer holds the view, so the pane returned to the end between mouse-down and
  mouse-up and "Run again" was missed — four runs in a row on the runner. The check
  now scrolls with the mouse wheel, as `verify-output` already does, and asserts what
  it always did.

### Finding a line keeps the view there while a command runs

- **Only-the-reader broke the find bar.** A terminal now stops following its output only
  for a gesture, because the browser scrolls in code too. But the find bar jumping to
  a match, and the overview ruler jumping to a block, are the reader asking to move —
  and both move the view by scrolling in code. So a line found in an earlier block
  while a command was running was lost the moment that command finished, when the
  view was pinned straight back to the end.
- **Those two now say so before they move.** Each sends an `ember:reader-moved` event
  to the pane, which takes it exactly as it takes a wheel. The browser's own clamps
  send nothing and still change nothing, so the fix the earlier rule was for stands.
- **Not settled by this:** the match itself can drift a long way above the view as the
  finished command's block is laid out again. The view stays in the right block and
  off the end; exactly where the match sits afterwards is a separate effect, measured
  and not yet fixed.
- **How it is checked:** `verify-shell` finds a line in a 150-line block while a slower
  command runs, lets that command finish, and requires the view to still be inside
  the first block and not at the end. On the build before this it was pinned to the
  end (`fromEnd: 0`) and failed; with this it passes.

### A release is installed over the last one before it is drafted

- **Nothing tested what most people will actually do with a release.** The release job
  installed each build onto a clean machine, but anyone updating already has the last
  version — settings, a history database, a saved session — and the installer goes on
  top. An upgrade that failed to replace the app, or a build that could not read what
  the previous one wrote, would have been drafted exactly as confidently as one that
  worked.
- **The release job now installs over the latest published release.** It downloads that
  release's installer (never a draft), installs it, and drives it — a setting changed
  and a marked command run — so it writes all three. This build then goes into the same
  folder, and must report its own version from the executable, then read back the old
  setting, find the old command in history, and restore the old session with it in it.
- **How it is checked:** a dry run on the hosted runner installed v0.3.26 from its
  release page, drove it, installed this build over it, and passed every one of those
  checks before the usual packaged suites ran. One of them cannot bite yet: the version
  check compares against `package.json`, which still says 0.3.26 like the release it
  replaces, so it only distinguishes old from new once the version is bumped.

### The bash suite waits for its commands and cannot hang on close

- **It read each command's block after a fixed three seconds**, so a slow runner read a
  block still "running…" and reported a fault in the shell; and closing the window could
  wait for ever on the "still running" question such a block raised, which surfaced as a
  twenty-minute gate timeout rather than as a reason. Commands are now waited for, up to
  twenty seconds each, and the close is bounded and says what it was waiting on.
- **WSL with no distribution installed is a skip that names itself**, which is what a
  hosted runner has. `gate.mjs --hosted` sets `EMBER_HOSTED` so that skip is allowed
  there under `EMBER_STRICT`, the same way the suites that need VS Code or a login are.
- **How it is checked:** with the app change above it passes 48 of 48 on the runner;
  without it the same suite fails 24 of 48 on the faults it exists to catch.

### An Enter no longer resizes the terminal

- **The cause behind three faults that looked unrelated.** The live strip's height is a
  share of the room the blocks above leave, so it changed from one command to the next,
  and pressing Enter opened a block that squeezed it — resizing the pty under a shell
  that was already running the line. Conpty answers a resize by repainting only its new
  screen, inside the open capture: rows not yet sent were never sent (a six-thousand-line
  command once began at line five), and rows sent at the old height replayed wrong, so a
  block lost lines or showed some twice. Bash lost characters too — a resize reaching
  readline mid-read makes it redraw its prompt and drop what arrives meanwhile, so `pwd`
  went in as `wd` and `type` as `ype`, leaving blocks stuck at "running…" and closes
  waiting on them for ever. And PSReadLine 2.4.5 threw when the console shrank under a
  waiting prompt, which is what turned one Enter into two blocks.
- **The strip is sized for the next command while the prompt is still up**, so the Enter
  finds the pty already right and resizes nothing. What that cannot foresee — a pane
  resized while idle — is covered by a short, bounded hold on the line: until the strip
  is laid out and conpty has answered any resize, and after a resize under a waiting
  prompt until the shell redraws or 400ms pass. Keys typed during the hold are queued
  behind the line, never dropped or reordered.
- **Each PowerShell prompt is drawn from the top of a cleared console**, so no change of
  height can leave PSReadLine's remembered row off the screen. The first prompt is left
  alone, so whatever a profile printed on the way in is still there.
- **Withdrawn: "a repeat is one screenful".** An earlier entry said the duplicated runs
  matched the pane's height and changed the replay on that basis. They were 1, 2, 3 and
  7 lines; no single replay height can undo a capture with a resize inside it. Replaying
  at the captured shape stays, since it is right once the resize is outside the capture.
- **Not handled:** a resize *while* a command runs — the window dragged mid-build — still
  lands inside that command's capture.
- **How it is checked:** on hosted runners, 48 looped runs each against the build before
  this: `verify-output` lost or repeated lines in 4 and `verify-bash` failed in 24. With
  it, 0 and 0. One full smoke run in four afterwards failed Git Bash's start-up once, not
  seen again in two reruns or 98 runs of that suite, and not yet explained.

### Only the reader can stop a terminal following its output

- **A window made smaller could stop its terminal following for good.** Following the
  end is a latch, cleared by a scroll event that leaves the view off the bottom. When
  content reflows shorter the browser clamps `scrollTop` and fires a scroll event of
  its own, and during a resize that lands mid-reflow — so the latch cleared on the
  browser's action, nothing set it again, and new output went on landing below the
  fold. Measured before anything was changed: the pane sat on the maximum it had at
  the old height, 114px short, and a further 70px of new output did not move it.
- **Leaving the end now counts only right after a gesture** — a wheel, a touch, a
  pointer or a key on the pane. Arriving at the end always re-arms it, however that
  happened, so it cannot become a second latch to get stuck in. This supersedes the
  narrower guard added earlier against the pane's own pinning, which it covers.
- **A change of meaning, decided rather than slipped in.** "The reader scrolled away"
  used to include any scroll, code-driven ones too; now it means the reader did
  something. The output suite's check for it had been assigning `scrollTop` and now
  uses the mouse wheel over the pane.
- **How it is checked:** `verify-session`'s "the restored view is weighted to the
  bottom" failed on the hosted runner every night and, since this machine's display
  changed, here too — 113.89px on the build just before this one. It passes with
  this change, and `verify-output`'s reader-scrolled-up check passes driven by a real
  wheel.

### The runner tests the window people actually open

- **The runner was testing the administrator's window.** A hosted Windows runner runs
  every step as an administrator with UAC off. Ember rightly treats an elevated launch
  as its admin window, which keeps its data one directory down and never starts the
  Claude Code bridge — so the bridge suites failed every night waiting for a lockfile
  Ember was right not to write, the admin suite failed on a reset socket because it
  needs an ordinary window to start from, and every other suite was testing the path
  most people never take.
- **The suites now start under an ordinary user's token.** `.github/unelevated.ps1`
  asks Windows for the "normal user" level that `runas /trustlevel:0x20000` uses,
  lowers the integrity to medium as a filtered UAC token has, starts the command with
  it and hands back its output and exit code — which plain `runas` does neither of.
  Nothing in the app knows it is under test: its own elevation check simply answers
  no, for the reason it would on a desk.
- **A step stops it quietly going back.** Before any suite runs, `elevation.mjs` has to
  fail to list `System32\config` under that token, and has to be able to write
  everywhere the suites write. If either stops being true the job fails there, rather
  than the gate drifting back to the administrator's window unnoticed.
- **What it does not fix.** In a full run the failures went from 22 to 14. It surfaced
  a hang that was already there: Electron sometimes never exits on close, which is why
  `integration`, `live` and `dirpicker` hit the gate's twenty-minute limit on most
  nights, elevated or not.
- **How it is checked:** on the runner, `ide`, `keeps-work`, `conflict` and `admin` fail
  on the elevated path and pass under the new token; `verify.mjs` and the per-push
  suites still pass; in a full run ten suites went from failing to passing.

### One Enter is one block, and a command no longer resizes the terminal twice

- **A prompt came back before the line had started.** The idle terminal strip was three
  columns wider than a running one, so every command resized the pty as it began and
  again as it ended. After the Claude panel had taken width, that shrink put the
  terminal on the prompt's exact width, and PSReadLine 2.4.5 threw while drawing it:
  it printed its bug report, put up a fresh prompt without marking the line as
  started, and then ran the line. The prompt closed the block opened on Enter as a
  success with no output and wrote it to history; the late start opened a second.
  One Enter, two blocks, two history rows.
- **A block that reaches its prompt without starting is a line the shell has not
  run.** It is closed but kept out of history and the saved session, takes no capture
  — the head of the queue belongs to a later block — and is handed back if the same
  line starts next. Only under Ember's own integration, which marks every line it
  accepts; a user's own OSC 133 setup may never send a start at all.
- **The collapsed strip keeps the running strip's side margins**, so the width holds
  across a command and the pty is no longer resized on the way in or out.
- **Not settled by this, and the commit said otherwise.** It claimed that with the
  resize gone no conpty repaint lands inside a capture. verify-output's long command
  still lost its first two lines once in five runs on the runner with this change in
  place, so the resize was not the whole of that fault.
- **How it is checked:** verify-secrets asks for one row and one block for the first
  command after the panel answers; verify-shell reads the width idle, running and
  idle again — the last only once the command has finished, rather than after a fixed
  three and a half seconds that could read a strip still running — and makes the
  prompt-before-start sequence on purpose. On the runner the old app failed all three
  five times in five and the new one passed every run. Here, shell, secrets, output,
  blocks, history and boom all pass with it.

### The installer that ships is the one that was tested

- **Every packaged check ran against the folder the installer is made from.** A release
  was `npm run dist` on the maintainer's machine, and nothing had ever run what the
  installer actually puts on a disk — which is how builds once shipped whose installed
  app found no themes and no shell integration while the unpacked one was perfect.
- **A release job now builds it on a clean machine and installs it.** For a version
  tag, after a green run of the whole gate on that commit: the pinned debug adapter,
  the NSIS build, the feed checked against the files, a silent install into a
  throwaway folder, `verify-packaged` and `verify-update` against the installed
  `Ember.exe`, an uninstall that has to remove it — and only then a *draft* release
  made from exactly those files. Publishing it stays a person's decision, after
  installing it over the previous version.
- **The feed is checked against the bytes, not only the names.** Each file's sha512 and
  size in `latest.yml` are compared with what is on disk, and the blockmap is
  required. A mismatched hash gets the installer rejected inside the installed app,
  after it has already announced an update — the same silent failure the name check
  was written for, one step later. The check now prints the full upload list,
  including the feed and the blockmap, which the release takes as given.
- **A manual run is a dry run.** It does everything but make the release, and keeps
  the installer it tested as an artifact. Only a `v` tag can draft one.
- **`verify-update` had been passing one of its lines for the wrong reason on an
  elevated machine.** It plants a promised update in the settings before launch; an
  elevated app reads its own profile, which does not carry that setting over, so
  "a version already passed stops being offered" got the `null` it expected because
  nothing had been planted. It seeds both places now, and both lines pass on the
  runner with the promise really there.
- **How it is checked:** the feed check was run against a correct release folder and
  three broken ones — wrong hash, wrong size, no blockmap — and fails each for its
  own reason. The whole job has run as a dry run on a hosted runner: installer
  built, feed passed, installed build passed both packaged suites, uninstall
  removed it. It has not yet drafted a release, because the gate a tag requires is
  not green on the runner yet — `verify-session` and the suites for the IDE bridge,
  which an elevated window deliberately never starts, still fail there.

### The runner's screenshots reach the evidence artifact

- **`.shots` starts with a dot**, and `upload-artifact` has skipped hidden files by
  default since v4.4. Every screenshot a suite took on the runner was dropped, and
  the artifact that exists to explain failures on a machine nobody can look at held
  main-process logs and no pictures.
- **Both upload steps now set `include-hidden-files: true`.**
- **How it is checked:** a nightly artifact held two logs and nothing else; a dispatch
  with the setting held all four of verify-git's screenshots.

### A missing change mark is reported as missing, not as a timeout

- **The click was waiting for a mark that was never drawn.** On the hosted runner the
  editor found no committed text for its file — the short-name defect fixed above —
  so it drew no change marks. verify-gutters then clicked the first mark, waited
  thirty seconds for it, and threw; the three failures it had already recorded, each
  saying plainly that there were no marks, were never printed. The nightly showed a
  bare `locator.click: Timeout` for a fault the suite had correctly described.
- **It clicks only a mark that is there**, so a missing one arrives as "marks exist for
  an unsaved edit — []" rather than as a timeout.
- **And it opens its file through a junction**, which gives the folder a second name
  on every machine. Before this only a machine whose temp directory has a short name
  could see the defect at all.
- **How it is checked:** on the runner the new suite against the old app fails on the
  missing marks and passes with the fix, twice.

### A repository opened through a junction or subst drive keeps its git colours

- **The explorer looked its rows up under git's name for the folder.** Git reports a
  repository's root the way the disk finally names it, so a folder reached through a
  junction or a `subst` drive comes back from `--show-toplevel` under the name
  behind it. The explorer builds its rows from the folder it was given, looked each
  one up under git's spelling, and found none: every row undecorated, while the
  source-control panel beside it listed the changes.
- **The root now comes back in the caller's spelling when that names the same
  folder.** It is walked up from the folder asked about by as many levels as git says
  that folder sits below the top, and trusted only if `realpath` agrees it is the
  same directory; otherwise git's answer stands. When the two spellings already
  match, nothing changes. This covers what the previous entry deliberately does not:
  short names are written out at the command line, but a junction or a `subst`
  drive is a place the person chose and is left as they named it.
- **How it is checked:** verify-git now opens its repository through a junction,
  which gives the folder a second name on every machine rather than only on one
  whose temp directory has a short name. Against the previous build it fails here —
  "explorer marks the untracked file — []", the line the hosted runner had failed on
  every night — and it passes with this change.

### Forgetting a command takes every copy of it off the history list

- **The database lost every copy and the list lost one.** Forgetting a command in
  Ctrl+R history deletes every row with the same text, by design. The list then
  removed only the row that was clicked, so a command run twice left the database
  entirely and stayed on screen once — naming a command that was no longer on disk.
  The list now drops every row with that text, which is what main deletes.
- **Found on the runner because it had recorded one line twice.** One typed `echo`
  became two history rows and two blocks — one with output, one 77 ms later with
  none — on the first command after the Claude panel had answered a question. Why
  one Enter records twice is not established and not fixed here; it is a separate
  fault, and it is being chased separately.
- **How it is checked:** verify-secrets now runs the command twice on purpose, checks
  both copies are listed, forgets one, and requires the list and the database both
  empty of it. On the hosted runner it fails against the old list ("2 rows left") and
  passes twice with the change. The case no longer depends on a machine happening to
  double a line.

### A folder opened by its short name is opened by its long one

- **The workspace and the shell named one folder two ways.** A folder or file on the
  command line was kept exactly as spelled, while the shell and git report the long
  form. So the explorer lost its git marks — this is the nightly's "explorer marks the
  untracked file — []" — and the git poll took the shell to be outside its own
  workspace and asked about it a second time on every tick.
- **Short names are written out, and nothing else is changed.** `longPath` expands 8.3
  components in command-line paths using the filesystem's own answer, but keeps the
  original if anything other than a short name would change — so a junction, a
  `subst` drive or a mapped share stays where the person pointed, rather than being
  swapped for the folder behind it. A path with no `~` in it is returned untouched.
- **The suite's own line could never have passed on the runner.** It looked for the
  short temp path inside the shell's long-form answer. It now compares with the
  folder's long name, case-insensitively, and waits for the answer rather than
  reading after a fixed two and a half seconds.
- **How it is checked:** verify-explorer gains "and the workspace names it as the shell
  does". On the hosted runner it fails against the previous build (workspace
  `RUNNER~1`, shell `runneradmin`) and passes with this change. verify-git's untracked
  mark went from red to green across the same pair — one run each, which is a
  sighting, not a rate.

### Gutter marks appear for a file opened by its short Windows name

- **The file was measured against its repository in two different spellings.** Git
  writes a repository's root the way the filesystem finally names it, long form. The
  file's place inside it was worked out by comparing that root with the path the
  editor held, so a file opened as `C:\Users\RUNNER~1\...` came out as somewhere above
  the repository and was treated as outside it: no gutter marks on any line, however
  much it was edited. A Windows profile with a long user name looks like that
  whenever something hands over its short form — a TEMP variable, a tool on the
  command line.
- **Git is asked where the file is instead.** `--show-prefix` gives the folder's
  place in the repository in git's own terms, so the two spellings never meet.
- **Two checks had been passing for the wrong reason.** On a short TEMP path the lines
  expecting *no* marks — a committed Windows-1252 file, a byte-order mark — passed
  because a gutter that could not read the committed text drew nothing at all.
- **Not covered: a file whose own name, rather than its folder, is spelled short.** It
  is still not found.
- **How it is checked:** verify-encoding's "while an edit to it is" failed every night
  on the hosted runner, whose TEMP is an 8.3 path, and in an instrumented run that
  read the committed text both ways — empty by the short spelling, present by the
  long. It passes with this change. It has never failed here, where TEMP has no
  short names.

### The nightly names what a hosted runner cannot run, instead of failing on it

- **Three suites skip on a hosted runner every night, and under `EMBER_STRICT` a
  skip is a failure.** That rule is right on the maintainer's machine, where a skip
  means a check nobody ran. On a runner these three want things it will never have —
  VS Code for the theme import, a signed-in `gh` for the GitHub panel, Claude Code
  for the login — so the nightly was red on them five nights of five, and red that
  never changes teaches people to stop reading it.
- **`gate.mjs --hosted` leaves them out and says so**, by name and with the reason,
  every time it runs. The list lives in the gate beside the existing one for suites
  that run in another step, the plan check fails if it names something that is not a
  gated suite, and `--list` shows each of them with where it runs. They are not
  retired: anywhere those things exist, they run and have to pass.
- **How it is checked:** `--list` gives seventy-two suites, `--list --hosted` gives
  sixty-nine and names the three. The nightly uses `--hosted` from tomorrow.

### Seven more checks stop reading a directory the app had moved

- **The nightly ran the whole gate on a runner for five nights, and nineteen suites
  failed every one of them** on an unchanged commit — deterministic, not flaky. Seven
  shared the cause already found for the crash and session checks: a hosted Windows
  runner is elevated throughout, an elevated Ember keeps its user data in
  `admin-window` inside the profile, and these suites read `session.json`,
  `settings.json` or `history.db` from the directory they had named on the command
  line. Title bar, rebinding, ghost text, lines, chat wire, secrets and blocks.
- **Two directions, two helpers.** Reading back what the app wrote now asks the app
  where it keeps it (`userDataOf`). Seeding a file before launch cannot ask, since
  there is nothing yet to ask, and the admin profile is seeded from the ordinary one
  for a short list of settings, themes and snippets only — so a seeded history
  database was invisible to an elevated app and a seeded AI mode never arrived. Those
  now write to both places the app might read (`seedDirs`), which keeps the
  elevation rule in the app rather than copying it into the harness.
- **How it is checked:** all seven pass here, where the app is not elevated, and six
  pass on the runner, where every one of them failed five nights running. The
  seventh, secrets, goes from four failures there to one — a history row that should
  leave the list and does not — which is a different question and is being asked
  separately.
- **What this does not fix, said so it is not mistaken for fixed.** On an elevated
  runner every suite exercises the administrator window, not the one most people
  run. For these seven that is honest coverage of a supported configuration. For the
  IDE bridge it is not: an elevated window deliberately never starts it, so the
  three suites that drive it cannot pass there on correct behaviour.

### The parser stops reaching into the splitter's state

- **Finishing a block used to clear the flag that says a capture is open.** Those
  are two different parts of the stream. The splitter runs synchronously inside
  `write()`, as the bytes arrive; a block finishes when xterm's parser reaches the
  end marker, which under a flood is thousands of lines later. So by the time a
  block finished, the splitter had often opened the *next* command's capture — and
  clearing the flag from there discarded those bytes and left it false, so that
  capture's own `133;D` fell through the test that does the queueing and nothing
  was ever queued for it.
- **Counted, on the runs where a block came back empty:** one capture destroyed
  this way, of 35 bytes; fourteen captures opened against thirteen queued; fifteen
  end markers on the wire against thirteen the splitter acted on. A capture being
  destroyed from the wrong side of the stream is wrong on its own terms, and that
  much is measured rather than argued.
- **What is not established is that this is the whole of the empty-block fault.**
  The block seen losing its output belonged to a command that had printed sixty-five
  kilobytes, and the capture destroyed was thirty-five bytes. If the two are
  connected it is by the queue being left one short and later blocks claiming the
  wrong entry, and that has not been shown.
- **How it is checked — and the part that could not be done.** The repository's
  practice is to watch the check fail on the old build, and that has not been
  possible here. The fault needs the parser to fall far behind the splitter, which
  on this machine meant memory commit sitting near its ceiling: it fired four times
  in four runs at 39–40 GB committed, and not at all once that dropped to 35 GB, on
  an unchanged build. A pagefile change has since taken the ceiling from 41 GB to
  123 GB, so the condition no longer occurs here to test against. Forcing the
  interleaving deliberately — flooding the parser and type-ahead submitting the next
  command before it can catch up — does not reproduce it either: three attempts,
  both blocks intact each time. What is verified is that the three suites covering
  block capture across a restart, a shell's lifetime and long output all still pass.

### A capture is replayed at the shape it was captured at

- **Conpty repaints a screen, so the bytes a block is cut from hold more lines
  than the command printed, and always have.** During a long scroll it re-sends
  rows it has already sent: measured here, 6015 lines of bytes for a command that
  printed 6000, the extra run starting again from line 2986. That is not a fault
  and it is not rare. What removes it is the replay into the offscreen terminal,
  where the repaint's own cursor moves land the re-sent rows back on top of the
  originals. A block is right because that replay is right.
- **The replay was being done at the pane's height now, not the height the bytes
  were addressed to.** Its own comment already said this has to match — "the same
  shape as the screen these bytes were written for" — and then took the live
  terminal's rows at the moment of rendering. Renders are queued one at a time, so
  a block can wait behind others while the pane changes height underneath it. The
  capture now carries the shape it was taken at, and is replayed at that.
- **What points at it:** the two duplications caught here re-sent exactly six
  lines each, against a pane six rows tall. One screenful, which is what a repaint
  is. A failure now reports how many lines were re-sent, so the next occurrence
  either confirms that or says plainly that this is something else.
- **How it is checked, and what that is worth.** The check has run thirteen times
  against this change without a duplication, and the twenty-three runs before it
  produced two. That is support and it is not proof: the fault appears in bursts,
  and there were eight consecutive clean runs on the old code in the middle of
  this. The change is made because the code's own stated rule was being broken,
  not because a run count says so — and the fault is not being marked closed.
- **A second fault is in the way and is not this one.** A block sometimes comes
  back completely empty — "no output", zero lines — at much the same rate with
  this change as without it. It is the more serious of the two and it is still
  open.

### A pane follows output that grows without arriving

- **This is a real gap, and it is still not the 114px.** It is the fourth thing
  offered as the cause of that number and the fourth to be wrong: the runner
  reported the same 2505/3067/448 afterwards as before. The gap below is worth
  closing on its own account and is described as what it is, not as a fix for
  something it did not fix.
- **A pane watches two things and needed a third.** Its container changing size is
  a `ResizeObserver`; blocks arriving is a `MutationObserver` on `childList`. What
  neither sees is a block that is *already there* changing height: that is a style
  on some element below, and the container's own box never moves. The live
  terminal does exactly that on every resize — it re-fits its rows to the height it
  now has — and it finishes *after* the resize that prompted it. So the pane pinned
  itself to the end of a content height that was still on its way, and was never
  asked again.
- **What the 114px actually is, now established.** The pane is not following at
  all. `scrollTop` sits on 2505 — the maximum it had at the *old* height — and the
  container has shrunk from 562px to 448px underneath it, which is the 114 exactly.
  Told apart by asking rather than reasoning: new output was produced after the
  resize, it reached the pane, and the view did not move, going from 114px to
  183px behind. New output arrives through React state whether or not any observer
  works, and it pins only if the pane still believes it is following. It does not.
- **Which leaves a decision rather than a patch.** The belief is cleared by any
  scroll event arriving while the view is off the end, and a scroll event is not
  only something a reader causes: when content reflows shorter the browser clamps
  `scrollTop` and fires one itself. Gating that on a recent wheel or pointer is the
  obvious fix and it changes a real behaviour — the existing check simulates a
  reader by assigning `scrollTop` directly, with no gesture at all, so the app and
  its check disagree about what "the reader scrolled" means. That is worth settling
  deliberately rather than in passing, so `verify-session` stays out of the
  per-push set, failing honestly, with the geometry and the follow-test in its
  message.
- **The children are observed for their size now,** and newly-arrived ones are
  added to that as they mount, so a block that grows after it is already on screen
  moves the view the same as one that has just appeared.
- **How it is checked:** the session suite asks the claim on both sides of the
  resize — a restore that never pinned and a resize that unpinned are separate
  failures — and reports every pane's scroll geometry when it fails, which is what
  ended the guessing and is left in place for the next time.

### A terminal stops telling itself to stop following its output

- **Resize a window while a pane is following live output and it could quietly
  stop following, permanently.** Following the end is a latch: set while the view
  is within 24px of the bottom, cleared when it is not, from the scroll handler.
  The pane also pins itself to the end by assigning `scrollTop`, and that fires a
  scroll event which the same handler answers from whatever the layout happens to
  be at that instant. When the pin lands while the layout is still settling — a
  window just resized, blocks still mounting after a restore — the answer at that
  moment is "not at the end", so the latch clears on the back of the pane's own
  action. Nothing sets it again. New output then lands below the fold until
  somebody scrolls to the bottom by hand.
- **The pane records where it pinned itself** and no longer reads a scroll to that
  exact position as the reader having moved. Everything else about the latch is
  unchanged, which matters in both directions: output still lands under someone
  watching it live, and still does not yank someone reading back through a build
  log.
- **This was found while chasing something else, and did not turn out to be it.**
  It was the third explanation offered for a pane that parked 114px above the end
  on a hosted runner, and the runner reported the same 114px afterwards. The
  mechanism above is real and worth closing on its own account — a component
  should not be able to clear its own latch by acting on it — but the 114px had a
  different cause, and it is the entry below.
- **How it is checked:** the session suite asks the claim on both sides of the
  resize, so a restore that never pinned and a resize that unpinned it are
  different failures. The other half of the latch was said here to have no check;
  it has had one all along — *a reader who scrolled up is left where they were* —
  and the duplicate added beside it has been taken out again.

### A directory browser is asked what it holds after it has been filled

- **Waiting for the box is not waiting for what is in it.** The check clicks the
  path in the status bar, waits for the browser to open, and reads its entries on
  the very next line. The way back up the tree is the one entry the picker can
  render without going to disk, so a list that has not been filled in yet is not
  empty — it holds exactly that, and nothing else. On a hosted runner it did:
  `["..Parent directory"]`, reported as a browser that lists nothing, of a browser
  that was about to list everything.
- **The entries are waited for now,** bounded, and both assertions are the ones
  that were there before.
- **The fifth check in this release found reading at a fixed moment** instead of
  waiting for the thing it was reading. Four of the five were genuinely about the
  clock; the fifth, the session check's resize, turned out not to be, and is still
  open. The shape is worth knowing on sight: an action, a sleep, a measurement.

### A broken line sequence says what was around the break

- **"6007 lines, first 1, last 6000, breaks at 16" left the rest to be guessed.**
  Two things were ambiguous in it. `breaks at 16` is the *value* at the break and
  reads like the *position* of it. And 6007 with both ends intact means seven
  entries too many — a repeat, not the loss this check exists to catch, which
  would come up short rather than over.
- **The neighbourhood of the break goes in the message now,** so a repeat reads as
  one: `around it: 12,13,14,15,9,10,11,12,13`. Nothing about what passes or fails
  has changed.
- **Because it only happens somewhere nobody can log into.** It has passed twice
  and failed once on the same runner, so the failure has to be readable the one
  time it appears.

### The restored view is waited for rather than read on a timer

- **The session check shrank the window by 140px and read the scroll position
  800ms later,** requiring the restored view to be within 24px of the end of its
  output. On a hosted runner it came back 114px above the end. 114 being most of
  the 140 just taken away, this looked like a fourth check about the clock — a
  pane measured partway through reacting to a resize.
- **It was not.** Given fifteen seconds to settle instead of 800ms, it reports
  114px still: the same number, not a number on its way anywhere. The pane does
  not re-pin itself to the end on that machine at all, and no amount of waiting
  changes it. The guess is written down here because the check was changed on the
  strength of it, and because the change turned out to be worth making for a
  different reason — a bounded wait is what proved the timing had nothing to do
  with it.
- **Nor is it the renderer.** A hosted runner has no GPU, so WebGL falls back to
  the DOM renderer, which was the obvious next suspect. Run here under
  `--disable-gpu`, the suite passes. Two guesses, both cheap to make and both
  wrong, which is the argument for the third move being a measurement rather than
  a third guess: the claim is now asked on both sides of the resize, so the
  failure says whether the restore never pinned the view or the resize unpinned
  it.
- **The assertion is the one it always was:** the restored view ends up at the
  bottom. A pane that never gets there still fails, now after fifteen seconds
  rather than under one, and now it fails for a reason that has been established
  instead of assumed.
- **What is actually wrong is still open,** and it is in the app rather than the
  check. Following the end is a latch: it is set while the view is within 24px of
  the bottom and cleared when it is not, and once cleared, a resize will not bring
  the view back. A restore is exactly the moment the layout moves underneath
  itself — fonts arrive, blocks mount, the window settles into its saved bounds —
  so a pane can come out of one having quietly stopped following. `verify-session`
  stays out of the per-push set until that is understood, with this as its reason.

### Two checks were reading a session file the app had deliberately moved

- **The crash check reported lost work on a machine that had lost none.** A
  process already running elevated moves its user data into an `admin-window`
  profile inside the one it was handed — on purpose, so that an administrator's
  Ember and an ordinary one never fight over a single session file, settings file
  and history database. Everything on a hosted Windows runner runs elevated. The
  app wrote `<profile>/admin-window/session.json`; the suite read
  `<profile>/session.json`, found nothing, and called it work that had gone.
- **The session check reads it the same way** and is one of the four suites held
  out of the per-push set for failing there. It is fixed the same way. Whether
  that was its only problem is a question for the runner.
- **Both ask the app now,** through a helper beside the fault audit. The app owns
  the decision, so a path a suite works out for itself is a second implementation
  of it — free to be wrong in exactly this way.
- **How it was found took three commits, each of them load-bearing.** The check
  used to say `-1 tab(s)`, meaning "not written yet", "half-written as I read it"
  and "not valid JSON" indiscriminately. Given a wait instead of a nine-second
  sleep it said "not written yet" — true, and still no cause. Given the same
  question *before* the crash as well as after, it failed on the one before, which
  ruled out crash handling altogether. Then it listed what the profile held:
  `admin-window`, and nothing else. The log that confirmed it was in the evidence
  artifact the previous commit had just made work.
- **Nothing in the app was wrong.** The fault audit has read both locations since
  it was written, so the crash the suite provokes on purpose was reported
  correctly throughout. Only the suites reading files back out were looking in one
  place.

### A check about stashing stops being a check about the clock

- **It clicked stash and read the answer three seconds later.** That is a budget,
  not an assertion, and on a hosted runner it ran out in the middle of the
  operation. The shape of the failure says so: the third assertion, that the
  untracked file went with the stash, *passed* — so the stash had started and had
  already taken `untracked.txt` — while `notes.ts` had not yet been put back and
  the panel had not yet reloaded. `[]` on the stash and "still holds the stashed
  edit" were reported of a stash that was working correctly when it was asked.
- **The entry appearing is what says the command returned,** so that is waited for
  first, and the working tree is then read with a bounded wait of its own rather
  than assumed to have settled. Popping had the identical fixed sleep and now has
  the identical treatment.
- **Nothing was weakened.** The assertions are the ones the check existed for —
  one entry on the stash, the tree back at the commit, the untracked file taken
  and brought back, the stash empty at the end — and a failure that is real still
  fails, within thirty seconds instead of three.
- **The third of these in this release, and the first the runner found itself.**
  The other two were caught by a loaded laptop, by accident. This one was caught
  by the gate running somewhere that is not this machine, which is the entire
  argument for doing that — arriving four commits after the argument was made.

### A single suite can be asked for on the runner

- **Four suites pass here and fail there,** which is the whole reason the runner
  exists — and the only way to watch one of them fail on it was to put it back
  into the job that guards every push, where a known failure trains people to
  ignore red. So the ones being diagnosed were the ones that could not be run.
- **A dispatch can now name what it wants:** `gh workflow run ci.yml -f only=boom`
  runs exactly that on Windows and nothing else. The broad suite is skipped when
  particular ones were asked for, being most of the wall clock and none of the
  answer, and the nightly's whole-gate job stays out of the way unless the
  dispatch named nothing — so asking about one suite costs one suite.
- **The list goes through the environment rather than into the command line,**
  because a dispatch input is a string somebody typed.

### The crash check says which half of the restore failed

- **It went red on the runner saying `not written yet`, and that was as far as it
  got.** The check asserts that the workspace main writes after putting itself
  back together still holds both sessions. Before the crash it slept 2.6 seconds
  for the autosave and went on without looking — so when the session file was
  missing afterwards, "main failed to write the workspace back" and "the workspace
  was never on disk to begin with" came out as the same red line. Those are
  different faults with different fixes, and one of them is not about crashes at
  all.
- **The same question is now asked on both sides of the crash,** waited for rather
  than slept through. A failure after it means main did not write the workspace
  back. A failure before it means the workspace was never being saved, which is a
  different bug in a different place.
- **And a failure says what the profile actually holds,** since a check reporting
  a file missing ought to say what was there instead of it.
- **How it is checked:** the suite passes here, where the file is on disk before
  the crash as well as after — so the new assertion is one the working case
  already satisfies, which is what stops it being a second way to fail. The case
  it was written for is the runner, where the file is on neither side, and that
  answer has to come from there.

### A failure on the runner leaves its logs behind

- **It was claimed for three runs and was not happening.** The smoke job says the
  screenshots and each profile's `ember.log` are uploaded when a run goes red,
  since nobody can look at the machine it happened on. It was collecting neither.
  The glob looked for `ember-profile-*/ember.log` under the runner's temp
  directory; profiles are made in `os.tmpdir()`, which on a Windows runner is
  somewhere else entirely, and a profile is deleted on its way out of the suite
  regardless — so there was nothing to match even in the right place.
  `if-no-files-found: ignore` meant the step went green having uploaded nothing.
- **It went unnoticed until there was a failure worth reading.** The crash check
  went red on the runner saying `not written yet`, which is a real answer and not
  enough of one, and the evidence that would have explained it had been thrown
  away by the suite that produced it.
- **The log is copied out before the profile is removed,** when `EMBER_KEEP_LOGS`
  names a directory, under the name of the profile it came from. The copy is made
  in the fault audit rather than in cleanup, because the audit is the one point
  every profile goes through — the throwaway ones, and the two suites that keep
  their own user data so they can read `session.json` and `history.db` across a
  relaunch. Unset, which is every run on a laptop, nothing about this changes.
- **How it is checked:** a profile holding an `ember.log` and an elevated window's
  own is audited and then deleted, and both files are still there afterwards,
  named for the profile they came from. A green suite leaves nothing behind, which
  is right rather than a gap — main writes that file when it has something to
  report, and the runs worth reading are the ones that do.

### A language server this machine does not have is a skip, not a failure

- **`multi-language lsp` spent its run on a runner asserting against a server
  that was never going to exist.** PowerShell Editor Services is not something
  Ember ships — it is used if the machine already has a copy, which is why
  `powershell` is the one language marked optional. The skip that was written for
  it recognised absence in one shape only: no traffic whatsoever. The other shape
  is a single line, main saying `no server available for powershell`, which is the
  app being perfectly clear about it — and that read as a server which had started
  and then answered nothing. Anywhere the VS Code PowerShell extension is not
  installed, which is every hosted runner, that is the case every time.
- **Absence is now read off what the app says,** in either shape, and the
  languages that were skipped are named once more in the summary rather than only
  in the middle of the traffic. A skip nobody can see is barely better than a pass
  that means nothing.
- **Deliberately not fatal under `EMBER_STRICT`,** which is the opposite of how
  this repository treats a skipped suite, so it is worth saying why. A skipped
  suite means a check nobody ran. This means a server Ember does not ship and does
  not claim to — the README was corrected earlier in this release for implying
  otherwise — so a machine without it is a supported machine, and the honest
  report is that one language went unexercised. `optional` is set on that one
  language and no other, so a server that does ship going missing still fails.
- **How it is checked:** the suite is run here, where PowerShell Editor Services
  *is* installed, and `powershell` still has to start and answer for real —
  `messages=31`, not a skip. That is the half that matters, because a fix of this
  shape earns its green by making a check stop running, and this one is watched
  not to. It goes back into the per-push set, which is six suites now.

### The gate runs on a machine that is not this one

- **Six suites on every push, and all of them nightly.** Ten were meant to run
  and this said so before any of them had been watched to: what the smoke job
  runs is settings, the pty and its blocks, a shell that dies, history, the flow
  valve under a flood, and the language servers. The nightly runs the whole gate.
  Both under `EMBER_STRICT`, so a suite that skips itself for want of a shell
  counts as a failure rather than as silence. The four that are held back are
  named in the workflow with what each of them said, because a subset that hides
  its exclusions is the same trick as a check that cannot fail.
- **`npm ci` does not install Electron's binary.** Not on the runner and not here
  either — it reports success and leaves `node_modules/electron` holding its
  JavaScript, its licence and an empty `path.txt`, without the two hundred
  megabytes the package exists to deliver. Running the install directly is what
  the postinstall would have done, and it returns at once when the binary is
  already there.
- **Which was worth finding out rather than guessing at.** Playwright reports all
  of it as `Process failed to launch!`, having kept the child's stderr to itself,
  so a missing binary, an app that dies on its first line and a GPU that cannot be
  used are one message. The first thing I would have reached for was
  `--disable-gpu`; it would have fixed nothing.
- **And the audit's open question is answered:** Electron suites do run on a
  hosted Windows runner, GPU-less session and all.

### Checks that run somewhere other than this machine

- **The gate runs on the one computer it can freeze**, which is why it does not
  get run between commits. Two regressions have now been found late because of
  that: *source control* was red on master for six commits, and *multi-language
  lsp* passed for its whole existence while proving only the easy half of its
  subject. Neither was hard to see. Nobody was looking.
- **A fast job on Linux**, in a few minutes and for nothing: typecheck, the unit
  tables, theme contrast, and the check that every suite on disk is in the gate's
  plan. `EMBER_STRICT` is deliberately not set there — several unit tables skip
  the shells they cannot find, and on Linux that is all of them, so strict would
  turn "no PowerShell here" into a failure that means nothing.
- **And one Windows suite, to find out whether that is possible at all.** A hosted
  runner has no GPU, so WebGL falls back to the DOM renderer, and how ConPTY
  behaves there is not something to assume. *verify.mjs* goes first because it
  covers the most ground — a real shell through a real pty, and a real editor. The
  rest follow once this has been watched to work rather than hoped to.
- **What a failure leaves behind:** the screenshots, and each profile's
  `ember.log` copied out before the profile is deleted, since nobody can look at
  the machine it happened on.

### TypeScript diagnostics work in a folder whose name has a space in it

- **They did not, and nothing said so.** Three parties spell a Windows path three
  ways and match documents by string equality. Lowercasing settled `%3A` against
  `%3a` and nothing else — a space is `%20` to one party and a space to the other,
  an accent is `%C3%A9` or `é`, and changing case resolves neither. Run from a
  folder called `Ember Tést`, Ember sent
  `…/ember tést typescript-x/sample.ts` and the server answered about
  `…/ember%20t%c3%a9st%20typescript-x/sample.ts`, so every reply was about a
  document nothing was filed under.
- **A deliberate type error produced no squiggle at all**, and rename reached
  neither of its two mentions. Not degraded — absent, and silently. `OneDrive -
  Company`, `My Documents`, or a folder with somebody's name in it all do this,
  which is to say most of them.
- **URIs are decoded before they are compared.** Decoded rather than encoded,
  because that is the form the client already produces for its own lookups — the
  same reason the canonical form is lowercase. A malformed escape is left alone
  rather than rewritten.
- **The suite had a check for this and had never been in a position to fail it.**
  It ran from `ember-typescript-XXXX`, where the only disagreement possible is the
  drive letter's case, which the old canonicaliser already handled. It runs from
  `Ember Tést <language>-XXXX` now, and all five languages pass from there. pyright
  and yaml-language-server passed either way, because they canonicalise
  internally; tsserver and PowerShell Editor Services do not, which is what made
  this visible.
- **Not fixed here:** a URI nested in a field not named `*Uri` — the one in
  `command.arguments` on a code lens — still passes through in whatever spelling
  it arrived in. Rewriting every string that looks like a URI would reach into
  hover text, where a `file://` link is content rather than an address.

### Blame answers about the line you are looking at, not the one on disk

- **The line number came from the editor and the answer came from the file on
  disk.** Those are the same thing only until something is typed. Insert a line at
  the top of a file and every annotation below it is off by one: git is asked
  about the caret's line number in a file that no longer has the caret's line
  there. Measured on a two-commit file with one unsaved line inserted above, git
  was asked for line 2 and answered *second commit*, where the line the caret sat
  on belongs to the first.
- **It did not go blank, which would at least have read as an absence.** It named
  a real commit and a real author, neither of which had touched the line being
  pointed at. `--contents -` hands git the buffer to count lines in.
- **Sent only when the document is dirty.** A saved file is already the same on
  both sides, and this runs as the caret moves — so the common case keeps the
  cheap path and nothing crosses the process boundary that did not need to.
- **How it is checked.** *git history* inserts an unsaved line above a line whose
  commit is known, and asserts the annotation still names that commit and
  specifically not the one that touched that line number on disk — then that the
  unsaved line itself is attributed to nobody, which is the assertion that would
  not survive reporting nothing at all whenever a file is dirty.

### Stashing takes the untracked files with it again

- **A fix from earlier in this release broke it.** Literal pathspecs were set on
  the wrapper every git call passes through, to stop discarding one file deleting
  the ones whose names its glob reached. That part is right and stays — but
  `stash push --include-untracked` collects untracked files through pathspec
  machinery of git's own, and under literal pathspecs it collected none. The
  stash reported success and left every new file in the working tree, so anyone
  stashing to get a clean tree got neither a clean tree nor the files put away.
- **It goes on the calls that take paths now** — stage, unstage, discard's restore
  and clean, the two `ls-files` probes and blame — which is where the
  recommendation said to put it. The argument for the wrapper was that nothing
  here ever wants the glob; that is true of the arguments Ember builds and false
  of the ones git builds for itself.
- **Found by a suite that had been red on master for six commits**, and only
  looked at because something unrelated sent me back to it.

### A half-finished merge or rebase can be finished from the panel

- **In a linked worktree, it could not even be seen.** `.git` is a directory in an
  ordinary clone and a file everywhere else — a worktree and a submodule both put
  a `gitdir:` pointer there and keep their state under the main repository. The
  panel looked for `MERGE_HEAD` inside `<root>/.git`, which in a worktree is a
  path inside a file and can never exist. So a merge that stopped on a conflict
  was invisible; and once the conflicts were resolved the change lists came back
  empty, so it said *No changes* and disabled Commit — the one button that would
  have finished it. The pointer is followed now, which costs no extra git call on
  a poll that runs every three seconds.
- **Continue, Skip and Abort.** None of this was reachable from the panel: a
  rebase that stopped on a conflict could only be finished from the terminal.
  Abort asks first, being the only one of the three that cannot be undone by
  doing it again.
- **And the advice was wrong for a rebase.** *Commit to finish it* is true of a
  merge, a cherry-pick and a revert. During a rebase, committing makes an extra
  commit and leaves the rebase exactly where it was — so that one says *continue
  it to carry on* instead.
- **How it is checked.** *source control* builds a real linked worktree, forces a
  merge that stops on a conflict in it, and asserts the panel notices at all —
  then presses Abort and confirms against git's own
  `rev-parse --git-path MERGE_HEAD` that the merge is over, so the buttons are
  shown to reach git rather than merely to disappear.

### A diff that could not be read says so, instead of showing a file as brand new

- **An empty left-hand side is an answer, and it was also every failure.** The
  side of a diff that comes from git is read with `git show`, and an empty string
  is genuinely right for a file staged but never committed — it has no `HEAD`
  version. But the same empty string came back from every other outcome: a call
  that ran out of time, output past the buffer cap, git missing from PATH. The
  editor draws an empty left-hand side as the whole file having just been added,
  so a file that had barely changed could present as entirely new, with nothing
  anywhere saying the read had failed.
- **A diff that fails is a nuisance; one that quietly says the opposite of the
  truth is worse than none.** git has three ways of saying the object is not in
  that tree — *does not exist*, *exists on disk, but not in 'HEAD'*, *is in the
  index, but not at stage 2* — and only those still mean empty. Everything else
  now reaches the panel as the error it is.
- **How it is checked.** Both directions, because either alone can be satisfied
  by breaking the other: a read forced to fail has to come back as a failure with
  something to say, and a file staged but never committed still has to diff as an
  addition. The failure is forced with a buffer too small for the file, the same
  arrangement the pty's flow valve uses to make a modest flood engage a valve
  sized for megabytes, in its own app instance so a cap that small cannot disturb
  the rest of the suite.
- **Still swallowed, and worth saying:** `branches`, `log` and `stashList` return
  an empty list when their call fails, so a history that could not be read looks
  like a history with nothing in it. That is a smaller lie than a diff of a file
  that did not change, and it wants somewhere in the panel to put the reason
  before it is worth fixing.

### A commit waits for its hooks, and you can stop it waiting

- **One twenty-second deadline covered every git call**, including the ones that
  legitimately take longer. A commit runs the repository's hooks, so a
  lint-staged or test hook taking twenty-five seconds could not commit at all —
  git was killed partway through, and whatever the hook had started went on
  running without it. A push or a pull waiting on Git Credential Manager to
  finish a sign-in in a browser met the same end, as did checking out a large
  tree. `commit`, `push`, `pull` and `checkout` now take as long as they take;
  everything else keeps the deadline, because a status that hangs should not hang
  the panel.
- **Which makes a way out necessary rather than nice.** Without a deadline, a push
  waiting on a prompt that never comes waits for ever. A Stop button appears while
  any of those four is running and kills the whole process tree — not git alone:
  the hook and the credential helper are its children, and killing the parent by
  itself leaves them running and holding the index, which is the state this exists
  to get out of.
- **A stopped call says which kind of stopped it was.** Node reports a killed
  child as `Command failed: git commit -m …`, with nothing in it about a deadline,
  which reads as though git refused. A call that ran out of time now says so in
  those words, and one the user stopped says *Stopped.*
- **And says when git left its lock behind.** Interrupting git partway through
  writing can leave `.git/index.lock`, after which git refuses to touch the index.
  The panel reports it rather than removing it: git's own advice is to remove it
  only if nothing else is running, and the terminal in the next pane shares this
  repository.
- **How it is checked.** *source control* installs a `pre-commit` hook that sleeps
  twenty-five seconds. Once: commit, wait for Stop, press it — the commit has to
  end well inside the hook's sleep and nothing may be committed. Again: commit and
  let it run — the commit has to land, and to have taken more than twenty seconds
  doing it, so it cannot pass by the hook having been skipped.

### Reading the working tree gives up its claim on the index

- **`git status` takes the index lock**, to write back what it learned while
  stat-ing the working tree. It is an optimisation for whoever calls next, and git
  marks it optional for exactly this reason. The panel polls every three seconds
  and the terminal in the next pane shares that index, so an add typed there can
  meet a lock nobody asked for and fail outright with
  `fatal: Unable to create .git/index.lock: File exists.` Nothing retries it; the
  file is simply not staged.
- **Measured against git directly:** a repository of fifteen hundred files, the
  panel's calls running against an add loop — **35 of 317 adds refused**, none once
  `GIT_OPTIONAL_LOCKS=0` was set. In the shape `GitService.status()` actually
  makes them, twelve to twenty-two per run.
- **Not reproduced through the running app, and said so rather than implied.**
  Driven end to end — 327 polls against 360 adds, more pressure than the standalone
  run that refused twenty-two — nothing was refused, on a build with nothing
  suppressing the lock. So this is a defensive change: the mechanism is real and
  the flag removes it, but the collision was never observed through Ember itself.
  The suite check that came with it passes on the old build too, which makes it a
  guard against some later change taking the lock in earnest rather than evidence
  for this one.
- **Set on every call rather than only the reads**, because it suppresses the lock
  where taking it is optional and nowhere else. `add`, `commit`, `stash push`,
  `stash pop` and `restore --staged` take it because they need it, and go on taking
  it — checked one at a time under the flag rather than assumed.

### A git command that fails says what went wrong

- **The panel showed the first line of git's error, which is never the one that
  explains anything.** A rejected push opens with the remote's address, so what
  appeared was a path — while the seven lines under it said
  `! [rejected] main -> main (fetch first)`, `error: failed to push some refs`,
  and a hint naming `git pull` as the way out. A pull blocked by local changes was
  the same shape: the branch it fetched from, and no mention of the files in the
  way. Every word git wrote comes back now, in git's own order, capped so a merge
  naming a hundred conflicted paths cannot take the panel with it.
- **The explanation is picked out from the address.** git prefixes the lines that
  matter — `error:`, `fatal:`, `hint:`, `remote:`, and the ` ! [rejected]` form —
  so those are carried at full weight and the rest is dimmed. The box scrolls
  rather than pushing the file list off the panel.
- **Reordering was the other option, and it is worse.** Putting the explanation
  first reads better in isolation, but git's lines refer to one another and anyone
  who has seen the message before is looking for the shape they recognise.
- **How it is checked.** *source control* pushes a commit from the second clone so
  the remote moves on, commits locally, and presses Push: the error has to say
  *rejected*, carry the line that explains why, run to more than one line, and
  have the explanation among the lifted lines rather than the address.

### Discarding one file no longer deletes the ones whose names look like it

- **git reads a path as a pattern, and `[id]` is a character class.** Next.js and
  SvelteKit name route folders exactly that, so discarding the untracked
  `app/[id]/page.tsx` ran `clean -f -- app/[id]/page.tsx` — which also matched
  `app/i/page.tsx` and `app/d/page.tsx`, and deleted them. Permanently: `clean`
  does not use the recycle bin the file explorer uses, and an untracked file has
  nothing committed to come back from. The confirmation named one file and meant
  three.
- **The same widening threw away edits in tracked files.** `restore --worktree`
  takes a pathspec too, so discarding changes in the route file discarded them in
  every file the glob reached.
- **A path is a path now, on every call.** `GIT_LITERAL_PATHSPECS=1` is set on the
  wrapper every git call goes through, rather than on the ones that take paths
  today: every path handed to git here comes from git's own porcelain output or
  from the file tree, so it is literal by construction, and there is no glob or
  pathspec magic anywhere in the file to lose. A call added later that forgot the
  environment would be this bug again.
- **How it is checked.** *source control* creates `app/[id]/page.tsx` beside
  `app/i/page.tsx` and `app/d/page.tsx`, discards the first through the panel, and
  asserts on disk and against `git status` that the other two are still there —
  then does it again for a tracked `app/[id]/layout.tsx`, asserting the edit in
  `app/i/layout.tsx` survived. Run against the previous build, the file that was
  clicked disappears and so do both of its neighbours.

### A check about clearing the screen stops being a check about the clock

- **It failed once, on a loaded machine, and passed unchanged.** The check that a
  running command survives a clear ran `Start-Sleep -Seconds 8`, waited for its
  block to appear, cleared, and asserted about a second and a half later. That is
  a budget, not an assertion: a stall of a few seconds let the sleep finish first,
  and "0 running blocks" read as the clear having removed the command when nothing
  had removed anything. A red line that means "the machine was busy" is worse than
  no line — it teaches people to rerun rather than to read.
- **The command runs until it is interrupted,** so there is nothing to outrun, and
  the counts are taken on both sides of the keystroke, so what is compared is what
  the clear changed. It is then stopped through the live terminal, with a bounded
  wait that sends the interrupt again if the first was not heard — a wait with no
  end is how a suite that should have failed once sat for twenty minutes instead.
- **Nothing was weakened.** The two assertions the check existed for are still
  made — the block survives, the keyboard stays with the program — and the reason
  they matter is still the one the comment gives: a clear under a live `ssh` once
  put its password prompt back in the ordinary composer, typed in the clear.

### A shell there is no script for says so at once

- **zsh and fish spent six seconds pretending.** A pane waits that long for a
  shell to announce itself before deciding it has no integration — a grace period
  for a heavy profile taking its time to reach a prompt. A shell Ember has no
  script for was never going to announce anything, so a zsh pane showed a composer
  and the blocks layout for six seconds and then took them away again, which reads
  as something breaking rather than something being decided.
- **The only thing that named the reason was a toast, and it had gone.** It fired
  on every spawn, so a restart said it again, and it was off the screen before the
  shell was up. The reason rides back on the spawn now; the pane settles the moment
  it arrives, and the notice under the terminal says *Ember has no shell
  integration for zsh yet* rather than the generic line.
- **And nothing is typed into a shell that cannot read it.** A zsh profile whose
  owner had hopefully picked the bash dialect had the bash script typed into it —
  ignored by the script's own guard on a good day, a screen of syntax errors on a
  worse one.
- **How it is checked.** *plain terminal* teaches Ember a shell called `zsh.exe`
  that is a renamed `cmd.exe` — what is under test is what Ember says about an
  executable called zsh, not zsh itself, which is not on the machine that runs the
  gate. With the dialect deliberately wrong it asserts the pane settles as plain
  well inside the grace period rather than after it, that the notice names the
  shell, and that no composer was offered.
- **Not covered.** A WSL distro whose login shell is not bash still takes the full
  grace period before settling, because the guest's shell is only known from
  inside the guest. It ends honest; it does not end quickly. There is no such
  distro here to test against, so nothing claims otherwise.

### bash and WSL report what they have been claiming to report

- **WSL integration had never worked.** Not once. The nonce that signs Ember's own
  markers lives in the Windows environment, and nothing in the Windows environment
  crosses into a distro unless `WSLENV` names it — so every signed marker a WSL
  pane ever sent was discarded on arrival for carrying no nonce. The directory, the
  command line and the exit code went with them. What made it look like it worked
  is that a pane reaches "integrated" on a bare OSC 133 too, which the script also
  emits and which carries no signature to check.
- **WSL is started through `-e` rather than `--`.** `wsl.exe -- <command>` runs the
  command through the distro's login shell, so the string is parsed twice: a
  variable reference in it arrives mangled, or — worse, because it reads as having
  worked — silently emptied. `-e` execs the argv it is given and nothing else.
- **It picks the user's shell rather than assuming one.** A distro whose login
  shell is zsh or fish gets that shell, as a login shell, exactly as a bare
  `wsl.exe` would have given them — losing integration, which they never had,
  rather than losing their shell.
- **And it checks the rc file before using it,** because `bash --rcfile` on a file
  it cannot read starts silently, successfully, and with none of the user's
  aliases, prompt or completions in it.
- **Every block was named after a prompt hook, for anyone who has one.**
  `PROMPT_COMMAND` has been an array since bash 5.1, and Fedora ships one. Ember
  chained onto it as a string, which welded its hook onto the first element and
  left the rest behind it — and it armed the capture at the *front*, so the user's
  own prompt hooks ran armed and the DEBUG trap took the first of them for the
  command. The command actually typed was never captured at all, and the
  pre-output clear fired once per hook rather than once per command. A bare Git
  Bash has no `PROMPT_COMMAND`, which is why this survived; starship, direnv,
  atuin and oh-my-bash all put one there. Ember's hooks go around the user's now,
  array-aware, disarmed for the whole length of the prompt.
- **A command mentioning `__ember_prompt_command` produced no block.** The trap
  matched that name anywhere in the line, not just at the start of it — needed
  back when the hook ran armed, and nothing but harmful now that the prompt runs
  disarmed.
- **The first prompt closed a block that had never opened.** The signed `D` asked
  whether this was the first prompt after the flag saying so had already been
  cleared, so the shared marker was correctly withheld and Ember's own was sent
  anyway.
- **A shell whose only file is `.bashrc` got none of its own setup.** The generated
  rc replays what a login shell reads, and bash stops at the first of those that
  exists — so `.bashrc`, which that chain never reads, was never reached.
- **The integration script shipped with the wrong line endings, and bash cannot
  read it.** A carriage return is syntax to bash rather than whitespace, so a
  CRLF `integration.bash` does not look untidy — it fails to parse at line 19, and
  every shell that sources it comes up with no integration whatsoever. Git was
  storing the file correctly with LF; `core.autocrlf` was rewriting it on
  checkout, and nothing in the repository said it should not. So a clone on a
  Windows machine with the ordinary settings built an app whose bash integration
  had never worked, for Git Bash and WSL alike, while the committed script was
  perfectly fine. There is a `.gitattributes` now.
- **How it is checked.** *bash on both sides* drives Git Bash and a WSL distro
  through the same assertions, and reads `data-authenticated` rather than
  `data-integration`: readiness is reached by unsigned markers too, so without that
  distinction a pane whose every signed marker is being thrown away passes. It
  asserts the block is named after what was typed and after nothing else, that the
  output and a failing exit code come back, that the hooks are installed, and that
  a directory this side of the machine can open is reported.

### A check that never ran no longer reports that it did

- **The Git Bash half of the integration suite could not fail.** It sat inside two
  nested conditions that registered nothing between them: a machine without Git
  Bash printed a line and went green, and so did a machine where the new-session
  menu simply did not offer the entry. The suite reported coverage it had never
  run, and `EMBER_STRICT` — which the gate sets, and which exists precisely so a
  run that skipped half of itself cannot call itself green — never saw it, because
  nothing had been recorded to see.
- **A skip is recorded now, and fatal where it matters.** Not installed is a reason
  to skip, not a reason to pass. The only place it stays quiet is a laptop that
  genuinely lacks the shell.
- **And a profile that was detected has to be offered.** The inner condition is an
  assertion rather than a silent gate, so the case where the shell exists but the
  menu does not list it is a failure rather than a shrug.

### A plain pane whose shell died has a way back

- **There was nothing to click.** A pane with no shell integration has no composer,
  and the composer is where the restart chip lives — so when the shell exited, the
  pane said `exited 0` and that was the end of it. The only way on was to close the
  session. The notice offers Restart now, on the same hook the composer's chip
  uses, because it is the same action. The two never appear together: a plain pane
  is a raw pane, and the composer is only drawn when a pane is not raw.
- **Restarting inside the grace period could write the new shell off.** A pane waits
  six seconds for a shell to announce itself before deciding it has no integration.
  That watchdog was replaced on restart without being cancelled, so the abandoned
  one kept counting from the first spawn — and a shell that died and was restarted
  within those six seconds could be marked plain by a timer belonging to the shell
  before it.
- **Plain terminal mode had no gated check at all.** It had one, in a suite the gate
  does not run, and that check read the notice's text into a variable and then left
  it out of the pass expression — so the notice could have said anything. *plain
  terminal* is a suite of its own now, in the gate: it asserts the pane says why the
  blocks are missing and names the shell, that there is no composer, that the
  terminal has the whole pane, that no block is stranded, and that nothing offers to
  restart a shell that is still running.
- **How the restart is proved.** Not by reading the screen — the WebGL renderer
  draws the rows rather than building them, so there is often no text in the DOM to
  read. The suite tells the restarted shell to exit, and watches it do so. Only a
  running shell can.

### Closing no longer ends what was running without asking

- **A session, a pane or a window took its shells with it silently.** Every way of
  closing ended in the same kill, and none of them said what was about to die. A
  build, a dev server, an overnight test run — all of it went on a keystroke meant
  for the window, with nothing on screen afterwards to say what had been running.
  Unsaved files had been asked about for a long time; work that was still going had
  not.
- **The question names the commands.** "2 commands are still running" is not enough
  to answer with: one of them might be a `ping` you forgot and one might be the
  thing you have been waiting an hour for. Up to three are named, and the rest
  counted.
- **One question, however many reasons there are to ask it.** Closing something
  that holds both unsaved files and running commands asks once, saying both,
  rather than raising two prompts in a row — a second dialog behind the first
  reads as a glitch and gets answered the way the first one was.
- **Installing an update was the door with nothing behind it.** Install now latches
  a flag that tells every window's close handler not to prompt — deliberately,
  because the installer is already on its way and a cancelled quit would leave it
  running against a live app. Its own dialog counted unsaved files only, and only
  the ones no session snapshot is keeping — which, with restore on, is usually
  none of them. So in practice the button in Settings took every shell in every
  window without a word, and the run that proved it asked nothing at all with a
  file sitting unsaved on screen. It asks about both now, and about running work
  even when nothing is unsaved.
- **A window that closed stopped being counted.** The running commands each window
  reports were kept by window id and never removed, so a window closed holding a
  `ping -t` would have gone on being cited by every prompt that came afterwards.
- **It does not ask when there is nothing to ask about.** The names come from blocks
  still marked running, so an idle pane closes the way it always has. A prompt on
  every close is the version of this that people learn to click through.
- **How it is checked.** *keeping work* now runs `ping -t`, presses Delete on the
  focused session card — the path that reached the close without going near the X
  button anyone would think to guard — and asserts the question names the command,
  that Cancel keeps the session, and that Cancel keeps the process alive. It then
  asks the update path the same question, stops the command, and closes again to
  assert nothing is asked the second time. The second window is given something
  running as well as an unsaved file, so the single dialog has to carry both.

### Output with nowhere to go now has somewhere

- **Anything printed outside a command was invisible.** Output becomes a block by
  being cut between the markers a command prints around itself, and the live
  terminal is zero pixels tall while nothing is running. So a background job
  finishing, a server started with `-NoNewWindow`, or a profile that prints after
  the prompt wrote into a terminal nobody could see. Nothing was lost — there was
  simply nowhere it appeared. When something arrives with no command to belong to,
  the live view is revealed with a line saying why, and a Dismiss that puts the
  pane back as it was.
- **It is shown rather than filed.** The first attempt at this made a block for it,
  which does not work: blocks can only be appended, and every helper in the suites
  reads the last one as the command that just ran — a quiet block after each
  command had four checks reading an empty string where they expected output. The
  bytes are already in the live terminal. What was needed was to stop hiding it.
- **The difficult half was not noticing, it was not crying wolf.** Three things
  arrive in exactly the same stretch of the stream and are none of them this, and
  each one was found by watching what the app actually did rather than by reasoning
  about it:
  - The prompt, which comes as a single write holding the last command's end
    marker, the prompt-start marker, the prompt itself and the prompt-end marker.
    Asked after the terminal had parsed all of that, the pane was idle and the
    chunk plainly had text in it, so every ordinary prompt read as output from
    nowhere. The reading is per stretch of bytes now, with its own place in the
    stream, rather than per chunk.
  - The echo of the command you just typed, which lands in the same place a
    background write does. What separates them is that one of them is an answer to
    something Ember sent.
  - The repaint conpty writes whenever the pty is resized, which replays the
    prompt. The check for one was looking for an erase-display; conpty hides the
    cursor, goes home and erases line by line instead, so every resize was reading
    as text from nowhere.
- **How it is checked.** *live terminal* starts a child that shares the console and
  writes to it three seconds after its parent has finished, and asserts the pane
  stays quiet until it speaks, shows it when it does, and goes quiet again on
  Dismiss — with the ordinary command before it asserted quiet too, because a
  notice that appeared after every command would be worse than the silence it
  replaced.

### Saying only what is true

- **Settings described the opposite of what restore does.** It said "Command output
  is not restored — a finished command from last week would only look live", while
  blocks and their output have come back across launches for weeks, under a line
  saying which session they are from. It now says what is kept: the last 120 blocks
  a pane ran, output and exit codes with them, and that what you cleared stays
  cleared.
- **The README put a language server in the box that is not in it.** TypeScript,
  Python, Bash and YAML really do ship. PowerShell is found inside the VS Code
  PowerShell extension if you have it, and goes without a server if you do not.
- **`Ctrl+R` does not search every command you have ever run.** It searches the last
  twenty thousand; older ones fall off the end. That is what the README says now.
- **The update promise was true and hid its cost.** Nothing is installed without
  being asked for, and nothing is replaced under a running shell — but pressing
  Install now closes Ember, and anything running in a pane ends with it. Saying the
  first half without the second is how a true sentence still misleads.
- **A section for what Ember does not do,** because a limitation found after
  installing costs more than one read beforehand: which shells get blocks and which
  do not, the caps on history and on a block's output, rename across files, the
  PowerShell server, no screen-reader mode for terminal output, the 4 MB ceiling on
  unsaved work, Windows only and unsigned. Every line of it is a fact from the code.
- **The window says which version it is.** Nothing in it did, so the first question
  anyone asks about a bug had no answer short of reading the installer's filename.
- **The thirteen releases with no entries say so once, correctly.** The note that
  was already here said 0.3.9 through 0.3.22, and 0.3.9 has an entry of its own. It
  is 0.3.10 through 0.3.22, and they are deliberately not written up after the fact:
  an entry reconstructed from its own commits months later is a guess wearing the
  same clothes as the rest of this file.
- **`engines`** records what the tests actually need — Node 22.18, where running a
  `.ts` file without a flag became ordinary rather than experimental.
- **The screenshots were stale twice over, and are retaken.** The title bar's pill
  showed `Ctrl+Shift+O` for a chord that had already moved to `Ctrl+Shift+A` when
  the picture was taken, and the Claude chip still advertised the mode and effort
  controls that came out earlier in this release. Both pictures are now taken by
  `npm run shots`, which opens a clean profile on this repository and runs the same
  four commands they have always shown — because the reason they went stale is that
  retaking them was something somebody had to remember to do.

### The debugger that ships is the one that was tested

- **Every build fetched whatever Microsoft had published that day.** The Node
  debugger is not on npm — it is a release tarball — so a script pulls it in at
  build time, and that script asked for the *latest* release. Two builds a week
  apart could therefore hold two different debuggers with nothing recording that
  they did, which means no build here could be reproduced and "it worked on the
  last one" said nothing about this one. It is pinned to `v1.117.0` now, which is
  the version that has been in the tree all along.
- **And nothing checked what came back.** Whatever those bytes were — a bad
  download, a moved tag, somebody else's build — they were unpacked into the app
  and shipped. The tarball is hashed before anything is written now, and a hash
  that does not match the pin is refused: nothing is extracted, the copy already
  here is left alone, and the message says both hashes, because "it did not match"
  without them is not something anyone can act on.
- **Moving the pin is a deliberate act.** `--update` fetches the newest release and
  prints the three lines the pin would have to become. It changes nothing itself:
  a debugger version is not a thing to change as a side effect of running a build.
- **Two dependencies that were never wired up are gone.** `@xterm/addon-clipboard`
  and `@xterm/addon-search` were installed at the first commit and never imported.
  Both were development dependencies, so neither was ever shipped — what they cost
  was an install and a false impression, and the clipboard one in particular reads
  like OSC 52 support that does not exist. The terminal registers handlers for OSC
  133 and 633 and nothing else; a remote program still cannot set the local
  clipboard, and that was true before this too.

### Binding a shortcut stops costing you the rest of Settings

- **Escape while picking a chord closed Settings and threw the draft away.** The
  dialog answers Escape in the capture phase, which is before the chord button sees
  the key at all, and closing discards every edit in the dialog. So backing out of a
  capture — the one thing Escape is for there — took your theme, your font, your
  shells and anything else you had changed with it. The note underneath said "Esc
  changes nothing". It cancels the capture now and leaves the dialog alone, which is
  what the note meant.
- **Tab, Enter, Space and the arrows could be bound, and binding one took it away
  everywhere.** Capture refused bare modifiers and accepted everything else. Because
  the app answers its own chords with preventDefault, binding Tab did not add a
  shortcut so much as remove Tab: a keyboard user who pressed Enter on a chord and
  then Tab to move on left Settings with Tab bound to Terminal↔IDE, and after Save
  there was no Tab anywhere in the window. A binding needs Ctrl or Alt now, or a
  function key; Shift alone does not count, because Shift+Tab is still Tab. A key
  that cannot be taken says so on its own row and the capture stays open, so the
  answer is another press rather than a dead end.
- **How it is checked.** *key rebinding* now presses Tab, then Enter, then an arrow
  into an open capture and requires the chord to be unchanged and the refusal shown;
  then presses Escape and requires Settings still open with the chord as it was.

### The keys the app names are the keys it answers to

- **Hints taught chords that did something else.** Every legend, tooltip and palette
  hint carried a key typed out by hand, so a chord that moved in the keymap left its
  mentions behind and a rebinding in Settings was never reflected anywhere. An empty
  pane offered `Ctrl B` for **files** — in a terminal pane that key shows the session
  list, and has since it was moved. They are read from the binding now, so they say
  what the key does today and follow it when you change it.
- **Two rows named a key for something they do not do.** *Ask Claude* in the palette
  advertised `Ctrl+Shift+B`, which opens the Claude panel — and closes it again when
  it is already open — where the row itself points the composer at Claude. *View:
  Explorer* advertised `Ctrl+B`, which is the side slot: the session list in the
  terminal, and in the IDE an open or close of whichever view was last shown.
  Neither selects the Explorer. Nothing in the app performs either row's action from
  a key, so neither row claims one now. The rail said `Explorer (Ctrl+B)` for the
  same reason and no longer does.
- **The editor ignored rebinding, quietly.** Monaco answers a key it has bound
  before the app-wide handler sees it, so *Ask Claude* and *Format Document* stayed
  on `Ctrl+K` and `Alt+Shift+F` however they were rebound — the one place a change
  in Settings did nothing and said nothing. Both read their binding now, and are
  registered again when it moves.
- **"Every chord is rebindable in Settings" was not true.** Five of the twenty-nine
  in that table belong to a control rather than to a command — `Ctrl+Enter`, `Ctrl+↑`,
  `Ctrl+I`, `Tab` and `Shift+Tab` — and are answered where they are pressed, so the
  Shortcuts page cannot reach them. The sentence says which.
- **The screenshots are still wrong, and this does not fix them.** `docs/ide.png`
  shows the title bar's Search everything pill reading `Ctrl+Shift+O`, a chord that
  was moved to `Ctrl+Shift+A` before that picture was taken. Retaking them means
  driving the app into the right state and capturing it, which is its own piece of
  work.
- **How it is checked.** *shortcuts from the editor* reads the legends, rebinds the
  mode switch to `Ctrl+Shift+Y` through the settings path the Shortcuts page uses,
  and reads them again: the new chord has to be there and the old one gone. On the
  build before this they still said `Ctrl Shift I`.

### The caret stops going somewhere you cannot see it

- **Escape handed the keyboard to a terminal that was not on screen.** While a pane
  sits idle its live terminal is zero pixels tall and fully transparent, and xterm
  reads input through a textarea that is still focusable and has had its focus ring
  removed. Escape in the composer called focus on it. So the press a PowerShell user
  makes to clear a line — a PSReadLine reflex — moved the caret into a control
  nobody could see, where what you typed went to the shell invisibly and Enter ran
  it. Idle, Escape now does what the habit expects: it clears the line, and a second
  press steps out of the composer. While a command is running the strip is on screen
  and Escape still goes there, which is the way back to a program that is waiting
  for something.
- **And Tab could get there too.** That textarea sits just before the composer in
  the page, so Shift+Tab out of the composer landed in it rather than reaching the
  blocks — a keyboard user had no way back to their output. The terminal is out of
  the tab order whenever there is nothing to look at, and back in the moment a
  command starts or a full-screen program takes the pane.
- **How it is checked.** *keyboard and a11y* types a line, presses Escape, and asks
  where the caret went; then presses Shift+Tab three times and asserts it never
  lands in the hidden terminal and does reach a block. On the build before this,
  Escape landed on `.xterm-helper-textarea` and so did all three tabs.

### Clear tidies the screen instead of deleting your history

- **Ctrl+L deleted the pane's blocks from the database.** In bash and in PowerShell
  that key means tidy this up; people press it without deciding anything, and here
  it took every finished command in the pane out of the history for good, with
  nothing to undo it. It takes them off the screen now and says so — "Cleared 4
  blocks", with an Undo beside it that puts every one back. Nothing is deleted:
  they are still in the database, still findable in history search.
- **And what was cleared stays cleared.** A pane's blocks come back from the
  database rather than from the session file, so hiding them only on screen would
  have undone itself at the next launch. The pane writes down which blocks were
  cleared, by id, and does not put those back.
- **By id rather than by a cutoff, which is not the same thing.** A conversation is
  written with the time it happened, which can be earlier than blocks already on
  screen — so "hide everything older than this" hid a block that arrived after the
  clear. The list of ids is pruned on every restore to what the database still
  holds, so it cannot outgrow the 120 blocks a pane keeps.
- **Erasing is its own command, and asks.** *Terminal: Erase This Pane's History…*
  in the palette says how many blocks it is about to remove and that it cannot be
  undone. That is the thing Ctrl+L used to do by accident.
- **How it is checked.** *blocks across restarts* now clears a pane, reads the
  notice, takes up the Undo and counts every block back, then clears again and
  relaunches twice — because the first version of this shipped a mark that was
  honoured on restore but not carried onto the pane it rebuilt, so the save after
  it dropped the mark and everything came back one launch later. The suite already
  relaunched three times, which is why it was caught.

### A sentence about a command stops being a command

- **"npm install is slow" installed two packages.** The composer reads what you
  type and decides whether it is a command or a question, and a line starting with
  a command name was a command however it went on — unless it ended in a question
  mark, was at least four words, and had a determiner in it. Almost nothing people
  actually type clears all three. So `npm install is slow` installed packages named
  `is` and `slow`; `pip install breaks my venv` pulled two more off PyPI, which is
  somebody else's typosquat waiting to happen; and `exit code 1 from npm test` was
  the worst of them, because PowerShell's `exit` takes an expression — it evaluated
  the rest of the sentence and closed the shell. `rm the old logs` deleted files
  named the, old and logs. A line that runs to three or more words with a function
  word in it and nothing a command line has — no flag, no path, no glob, no
  variable, no extension — now goes to Claude, question mark or not.
- **And the same rule the other way.** `build --release`, `deploy staging` and
  `setup /quiet` are a project's own scripts, and all three went to the model
  because they open with words people also ask in English. What follows settles it
  now: a flag or a switch means the shell, and so does a bare second word.
- **The vocabulary was missing the words that carry those sentences.** No
  prepositions and no negated auxiliaries, so "webpack build fails after upgrading
  to node 22" and "make clean didn't actually clean anything" had nothing in them
  that said prose. The shell keywords that are also English — if, while, until,
  for, do, then — are deliberately still absent: a bash loop is a command line
  whatever it reads like.
- **A quoted string is an argument, whatever it says.** `rg "is not a function" src`
  is five words of plain English in argument position, and the rule above would
  have sent a ripgrep invocation to the model.
- **How it is checked.** *intent*, a new table of 124 lines somebody could
  plausibly type, each with the destination it should have. 107 are settled. The
  other 17 are written down as gaps and asserted to still be wrong, so that fixing
  one fails the table and says to move it: prose that carries a flag or a path,
  prose with no function word in it at all, and bare-word command lines long enough
  to trip the length rule. Two of those gaps — "kill port 3000" and "restart nginx"
  — are in the audit's own list, and its own prescription does not reach them
  either. On the build before this, 25 of the settled lines went the wrong way.

### Rename works, and has never worked before

- **F2 did nothing at all in TypeScript and JavaScript.** A rename comes back from
  the server as a map of edits keyed by the file they belong to, and
  typescript-language-server spells that key the way it re-encoded it —
  `file:///c%3A/users/…` where every document here is known as `file:///c:/users/…`.
  Ember canonicalises the URIs in a message as it passes, but only where the URI is
  a *value* under a key ending in "uri"; a URI that is itself a key went through
  untouched. So the edits arrived filed under a name nothing was filed under, the
  editor said "No text model" to itself, and the key you pressed did nothing —
  no error, no edit, no sign that anything had been asked. Monaco's own TypeScript
  rename is stood down the moment a language server starts, so there was nothing
  left to cover for it. Keys that are file URIs are canonicalised now, the same way
  values always were. A diagnostic report's `relatedDocuments` is keyed the
  same way, and is covered by the same rule.
- **A symbol mentioned in a file you do not have open still cannot be renamed.**
  The server answers with the edits for every file in the project that mentions it,
  and the editor turns each into a buffer before applying any of them. A file with
  no buffer throws partway through that loop, and the rename is abandoned whole —
  including the edits to the file you were looking at. So what is fixed here is
  renaming what is in front of you: a local symbol, or one whose every mention is
  open. Renaming an exported symbol across a project needs the editor to load the
  files it is about to change, which is a larger piece of work and is not this one.
  It fails the way it always did, which is silently: the message goes to the
  console.
- **How it is checked.** *multi-language lsp* renames a symbol used twice in an open
  TypeScript file, by pressing F2 the way a person would, and asserts the new name
  reached both mentions and the old one is gone. On the build before this it reached
  neither: the wire shows the request going out as `file:///c:/users/…` and the
  answer coming back keyed `file:///c%3A/users/…`, which is the whole of the bug in
  two lines.

### The Claude chip stops offering to run commands on its own

- **Three modes were offered and one of them was true.** The menu beside the prompt
  read Manual — "every command waits for you to press Run" — then Auto, "runs on
  arrival, unless it looks hard to undo", then Bypass, "runs everything, including
  what it warned about". The code that did any of that was deleted when Claude moved
  into its own panel, along with the flag it leaned on, and the menu stayed. So for
  several releases Ember asked how much rope to hand a model and then did the same
  thing whichever was chosen: Manual read as a safeguard that was not doing
  anything, and Bypass read as a danger that was not real. Safe by accident is not
  safe, and the sharper end of it is the day somebody restores the setting with no
  signal left to lean on. The section is gone. Nothing runs without a press, and
  nothing offers to.
- **The effort picker reached no request either.** It went in the same deletion and
  stayed on screen the same way — greying itself out for the one model that refuses
  a setting it was no longer sending. It is gone, and so is the flag on each model
  that recorded whether it takes one.
- **A mode stored by an older build is dropped rather than carried.** Settings are
  merged over the defaults and the merge keeps whatever the file holds, so `bypass`
  would have sat in it and been written back on every save, naming a behaviour this
  app does not have. It is deleted on the way in.
- **The chip reads `✦ Opus 5`,** to the eye and to a screen reader, rather than
  naming a mode that no longer decides anything.
- **How it is checked.** *chat wire* opens the chip and asserts an absence: no Mode
  section, no effort picker, nothing in the menu offering to run commands on its
  own, and a `bypass` stored by an older build gone from the settings file after the
  next save. On the build before this, the menu listed `Manual`, `Auto` and `Bypass`
  beside the five effort levels, the chip read `✦ Opus 5· max· bypass`, and the
  stored keys were still in `settings.json` after a save.

### A session's terminal is its own, and stays with it

- **A second session showed you the first one's screen.** A session with a single
  pane was drawn in a place React fills by position rather than by name, so
  switching sessions kept the pane already mounted and handed it the next session's
  shell. The element xterm draws into is built once and never moves — `open()`
  returns having done nothing when it is called again — so every session visited
  added its terminal to the first one's box, under the screen that was already
  there. What you saw was a shell with nothing to do with the pane it was in, while
  the keys went to the one underneath it. Measured on the build before this: three
  terminals in one pane after ordinary use, four after a session switch. A pane is
  keyed by the pane now, and a terminal is carried into whatever box its pane is
  given.
- **And splitting a pane left the one you split from blank.** Both halves get a new
  box, and a terminal that was already open did not follow. Blocks kept arriving,
  because they are cut from the bytes rather than read off the screen, so the pane
  looked fine until something needed the screen: a full-screen program — vim, htop,
  anything that takes the alternate screen — was handed the whole pane and drew
  into nothing. Measured: a 676-pixel box with no terminal in it, taking every
  keystroke.
- **What you had half-typed followed you into the other session.** One composer
  served them all, so `git push --force` typed in one repository and left there was
  sitting in the next session's line, one Enter from running in that one instead.
  Each pane's composer is its own now, and what it holds is kept for that pane:
  switching away and back finds the line where you left it. Kept in memory only —
  a line being typed is exactly where a password appears, and the session file is
  written to disk.
- **The terminal changed renderer halfway through a session.** The GPU renderer was
  dropped and loaded again on every attach, which cost nothing while a pane
  attached once and never again. Panes are things that unmount now, and coming back
  to one asked that question a second time in front of a box with a size in it,
  where the answer is different — so the terminal moved onto the GPU mid-session,
  and left a graphics context behind on every visit. It is chosen once, when the
  terminal is opened, and kept.
- **A theme check that could not fail.** The suite proved the palette had reached
  the terminal by reading the background of the first `.xterm-screen` in the window,
  or — behind a `??` — of `document.body`. Both readings were wrong. The screen
  element carries a background only while the DOM renderer is drawing; the GPU one
  paints it into a canvas and leaves the element transparent, so the reading really
  asked which renderer was running. And this window had no `.xterm-screen` in it at
  all, for the reason above, so every reading came from the body — whose background
  is the same token the check compares it to. A check that reads `--bg` and compares
  it to `--bg` passes in an empty window. It now reads what xterm itself is holding,
  and fails when there is no terminal there to ask.
- **A password prompt could go unmasked, and the password into the composer with
  it.** A no-echo prompt is found by reading the tail of what the shell has
  printed, and `beginOutput` empties that tail at a command's start marker —
  right for output that has not arrived yet, and wrong for output that arrived in
  the same conpty chunk as the marker, which was read for a prompt and then thrown
  away by the very bytes that carried it. What rescued it was the repaint from the
  next pty resize, delivering the prompt a second time. That is a race, and with
  panes no longer leaving their terminals behind it was losing about one run in
  three: the composer stayed an ordinary composer and `Read-Host` took the
  password into it in the clear, where the DOM had it. The tail is read after the
  terminal has parsed the same bytes now, so it holds what it was always meant to
  hold — what has been printed since the marker.
- **How it is checked.** *live terminal* counts the terminals in each pane after a
  new session, a switch back and a split, asks each pane whether the one it holds
  is its own, and runs a full-screen program in the pane that was split away from.
  On the build before this, all five of those failed: three terminals in one pane,
  then four; the first session's line still in the second session's composer; and
  after a split, `{"panes":2,"perPane":[0,1]}` — one pane with none, which then
  took a full-screen program into an empty box.

### A block shows its own output, and only its own

- **Finished output was reachable by the command that came next.** Output is
  sliced out of the raw byte stream as it arrives, but the block that owns it
  does not come for it until the terminal has parsed its way to the end marker —
  and under a flood the parser runs thousands of lines behind. Anything starting
  in that gap cleared the buffer the previous command was still owed. Finished
  output is now queued and claimed in order, where nothing that starts later can
  reach it, and each render gets its own screen instead of sharing one that every
  render resets. Said plainly: this was found by reading the code, and repeated
  attempts to provoke it — including deliberately restoring the old behaviour —
  never reproduced it. It is a guard against something the code allowed, not a
  fix for something anyone watched happen.
- **A trimmed block sent you somewhere the text was not.** It said the full text
  was in history, when history keeps 100,000 characters of a block that may hold
  half a megabyte — and keeps them from the *beginning*, while the block keeps
  the end. So it pointed at the one copy that certainly did not have the part it
  had just dropped. It now says what history actually holds.
- **A conpty repaint could take the first half of a block silently.** The drop
  was right — nothing before an erase survived on the real screen either — but
  nothing said so, and the block came back looking complete and merely starting
  in the middle.

### Opening a repository is no longer agreeing to run it

- **Formatting ran the repository's own code.** A project's prettier is a program
  in that project, and it loads that project's `prettier.config.js` — so pressing
  Save in a repository you had just cloned ran a JavaScript file somebody else
  wrote, with your permissions. Ember now withholds that until you say otherwise.
  An untrusted folder is still fully browsable and editable — it simply does not
  get to run its formatter, its scripts or its launch configurations. Nothing is
  asked on the way in: the refusal arrives at the moment something is actually
  withheld, and carries **Trust this folder** beside it. The status bar reads
  **Restricted** while that is so, and the command palette grants or withdraws it
  at any time.
- **And it looked outside your project for that program.** The search walked up
  as many as thirty parent folders, so a file in a shallow directory could find
  and run `C:\node_modules\prettier`. It stops at the workspace root now, trusted
  or not.
- **What you typed while the formatter was thinking was overwritten.** Formatting
  goes out and comes back a moment later, and what came back was applied
  regardless of what had been typed meanwhile — then saved. An answer about a
  version of the file that no longer exists is now discarded rather than applied.
- **Two helpers ran with PowerShell's execution policy set to `Bypass`**, which
  ignores the Mark of the Web that Windows puts on downloaded files. They run
  under `RemoteSigned` now, which is the policy that honours it.

### Reloading after a crash brings the workspace back

- **The crash screen promised what it then threw away.** It said your workspace
  was still saved and that reloading would rebuild the window from it. Reloading
  actually got nothing: the saved workspace is handed to a window once, when it
  opens, so the reloaded window started fresh — and a second later its autosave
  wrote that empty workspace over the real one, unsaved buffers included. The
  window now gets back what it last saved, so the sentence is true.
- **And your shells came back too, twice.** A reload started new shells on top of
  the old ones, which kept running where nothing could reach them; the old shell's
  exit then arrived addressed to the pane that had just replaced it, marking a live
  pane as dead. Panes now reclaim the shells they already had, and anything nobody
  claims within ten seconds is closed rather than left running invisibly.
- **A renderer that dies outright is handled at all.** Ember's window has no title
  bar of its own, so a dead renderer left a blank rectangle with no buttons on it.
  Ember now notices, puts the workspace back, reloads, and says so quietly:
  "Restored 2 sessions after a crash."
- **A window that stops responding asks** rather than leaving you to guess — Wait,
  or Reload window — and says that your shells are still running either way.
- **A window that never finishes painting is shown anyway** after eight seconds.
  It used to stay invisible while holding the lock that keeps Ember to one
  instance, so every later launch did nothing at all, with nothing on screen to
  close.
- Crash dumps are written locally, and never sent anywhere.

### Shell integration that output cannot forge, and a policy cannot switch off

- **Anything that could print could move your pane.** Command blocks are cut at
  markers the shell prints, and those markers were seven printable characters and
  an escape — so reading a file, a build log, or a branch name could set the pane's
  working directory, rename the command a block records, or open a block that
  nothing would ever close. Each shell now starts with a secret only it and Ember
  know, its markers carry it, and markers without it are ignored. A shell
  integration you set up yourself still marks the pane as integrated, as before.
- **A directory the shell reports has to be one this machine can see.** UNC paths
  are refused on sight, before anything touches the network: that directory is
  re-read every few seconds by the git status poll, so a single forged
  `\\somewhere\share` was a stall on a timer, pointed at a host of somebody else's
  choosing.
- **On a machine whose execution policy is Restricted there were no blocks at
  all.** Ember loaded its integration by typing `. 'integration.ps1'` into your
  shell, and that is exactly what such a policy refuses. It is handed over as an
  encoded command now — not a file, so no policy applies to it — and your own
  profile still loads first.
- **And that line is no longer in your shell history.** Because it was typed,
  `Get-History` kept it, in every session, on every machine.
- **Git Bash reports its directory in a form Windows can open**, through cygpath,
  instead of the POSIX path that nothing on this side could read. What it records
  as the command moved to a DEBUG trap, so a command run from a keybinding is
  recorded as itself rather than as whatever was typed last.
- **zsh and fish say so.** They were started as though they spoke bash, so every
  command opened a block that never finished and the pane sat spinning. They open
  an ordinary terminal now, and say that integration is not there yet.

### Pasting into a terminal asks before it runs anything

- **A paste went straight to the shell and ran on arrival.** The clipboard was
  written to the terminal as if you had typed it, which skips bracketed paste
  entirely — the markers that tell a shell "this is text, hold it until Enter"
  never reached it. So three lines copied from a web page were three commands the
  moment they landed, and the line that ran need not be the line you could see.
  Pasted text now goes in as text, so a shell that will hold it does; and where
  the shell will not hold it, Ember asks first, saying how many lines it is and
  showing the one it would start with.
- **An escape character in the clipboard was an instruction, not text.** Anything
  that is neither tab nor newline is now removed before the paste goes in, and the
  question says how many characters went. That includes the marker that ends a
  bracketed paste, which is how pasted text talks its way out of being treated as
  text.
- **Plain Ctrl+V went around all of it.** It was answered inside the terminal
  widget rather than by Ember, so only the shifted chord ever reached these rules.
  Ctrl+V, Ctrl+Shift+V and right-click now go through the same path.
- **Enter on a multi-line composer ran every line of it**, under a single block
  named after the whole blob. Paste a page into the input and press Enter and it
  asks first — worded for what it is about to do, since that text has been on
  screen rather than arriving by surprise.

### Credentials stay out of what Ember writes down, and out of what it sends

- **A key typed as a bare argument was stored in the clear.** `./deploy.sh sk-ant-…`
  has no flag in front of it, so nothing recognised it, and the command line went
  into a database that outlives the session — twice over, because the search index
  keeps its own copy. Keys are now known by their own shape (Anthropic, OpenAI
  including the newer `sk-proj-`, GitHub including fine-grained tokens, GitLab,
  Slack, Google, AWS, Stripe, npm, Hugging Face, JWTs and private key blocks) as
  well as by the labels that carry them — `$env:…=`, `export`/`set`/`setx`,
  `x-api-key:`, and the `Password=` and `AccountKey=` of a connection string. A
  command carrying one is not stored at all, and anything credential-shaped left
  in a command that is stored is replaced with `[redacted]`.
- **The file you were editing went to the model in full.** Asking Claude a
  question with a .env open sent the whole buffer, keys and all — as it did the
  terminal blocks you attached and the question itself. All three are scrubbed
  now, before either door: the API and the Claude Code CLI.
- **Suggestions and inline edits are withheld rather than scrubbed.** What comes
  back from those is written into your file, so redacting would put `[redacted]`
  where the key was. A caret sitting in a credential gets no suggestion, and a
  selection carrying one is not sent to be rewritten — and says so.
- **A proposed file that would write `[redacted]` over a real key is refused**,
  unless the file already had that word in it.
- **Command notifications** no longer carry credentials. A Windows toast is not
  fleeting: it is kept in the Action Center, which is on disk.
- **The agent thread is scrubbed before session.json is written**, which is where
  a question typed with a key in it used to sit.
- **Forget this command.** The patterns are a net, not a proof. Every row in the
  history search now has a × — and Shift+Delete — that takes that command line out
  of the searchable history and out of the blocks your panes restore, with the
  bytes overwritten rather than left behind in the file.
- **The history you already have is cleaned once.** The first launch after this
  goes over the rows already in your database and takes the credentials out of
  them, in small batches in the background so nothing stalls while it works.
  Nothing is deleted: a command that carried a key keeps its line, with
  `[redacted]` where the value was. Afterwards the file is compacted, so what was
  taken out is not still sitting in it.

### Files that are not UTF-8 open, and save as what they are

- **A Windows-1252 file lost its accents the first time you saved it.** Ember read
  every file as UTF-8, which turns any byte that is not UTF-8 into a replacement
  character, and wrote UTF-8 back. An .ini or .csv holding "café" opened as "caf?",
  looked unmodified, and saving one unrelated line wrote EF BF BD over the é for
  good. Files are now read as what they are — UTF-8 with or without a byte-order
  mark, UTF-16 in either byte order, and Windows-1252 for bytes that are not
  UTF-8 — and written back the same way, mark and all: an edit to one line leaves
  every other byte where it was.
- **UTF-16 files were refused as binary.** A NUL byte meant binary, and every other
  byte of UTF-16 Latin text is one — so the file `>` writes in Windows PowerShell
  5.1 could not be opened at all. It opens now, and saves as UTF-16.
- **A character the file's encoding cannot hold stops the save and asks.** Typing
  東京 into a Windows-1252 file now says so — "legacy.ini holds “東”, which
  Windows-1252 cannot store. Save it as UTF-8?" — and nothing is written until you
  answer. The status bar names any encoding other than plain UTF-8, and offers the
  same conversion.
- **Replace in files left every file that was not UTF-8 alone,** while search went
  on finding matches in it and showed the lines it found as empty. Those lines now
  read as their text, and replacing in them keeps the file's encoding. Search itself
  still matches bytes: "café" typed into the box does not find a Windows-1252 file's
  café.
- **A committed file with a byte-order mark was marked changed on its first line**,
  every time, because the editor takes the mark off the text and the comparison with
  HEAD did not. Both sides are read the same way now.

### The editor stops losing work four more ways

- **Ctrl+S saved the file in the other editor.** It was bound for the whole
  window rather than for its editor, and the editor created last answered it. With
  two files side by side, Ctrl+S in the left one saved the right one, which had
  nothing to save, and left the edit where it was. Save, Format Document and
  Ctrl+K now belong to their own editor and go when it closes.
- **Closing a window, or quitting, could drop unsaved work without asking.** The
  question was skipped whenever session restore was on, on the grounds that the
  work would come back. But closing a window that is not the last one deletes that
  window's session, and a buffer over 4 MB is never written into one. Each window
  now reports what is unsaved and how much of it its session is keeping, and Ember
  asks whenever a close would lose something. A buffer that grows past 4 MB says
  so as it does: "big.log is too large to keep across restarts. Save it to keep
  your changes." A buffer with no file yet, which no session can keep, is asked
  about too.
- **Cancel on that question left Ember with dead terminals.** Quitting killed
  every shell, closed the history and stopped Claude Code's bridge before any
  window was asked about unsaved work. A quit cancelled at that question kept a
  window whose shells no longer ran anything. On the build before this, with
  restore off (where it did ask), a command typed after Cancel never ran. The
  teardown now waits until every window has actually closed.
- **A file opened under two spellings could lose its edit.** Closed files keep
  their buffers in a lot of twenty so reopening one is instant. The lot was keyed
  by how the path was spelled, but disposed by the file, and a language server
  hands paths back lowercased with forward slashes while Explorer does not. So a
  file closed under one spelling, then reopened and edited under the other, left a
  stale entry. Twenty files later that entry disposed the live buffer: the tab
  rebuilt itself from disk and the edit was gone. The lot is keyed by the file now,
  and never disposes a buffer an open tab still shows.
- **The change gutter marked every line of a CRLF file, and could freeze the
  window.** HEAD comes back from git as the LF blob, while the buffer was compared
  in its own CRLF line endings. So on a default Git for Windows checkout, every line
  of an untouched file was marked as changed, by a diff whose memory grew with
  edits times length: 68.7 MB for 1,500 lines, measured. Lines are compared without
  their endings now, and the diff keeps only what it needs to walk back. Past 1,000
  edits it marks the changed stretch as one.
  - Found on the way, by a unit test's random edits: deleting one whole line from
    a committed file sent the old diff into an endless loop. 300 ms after typing
    stopped, the window froze until it ran out of memory. The CRLF comparison had
    hidden it on Windows by never producing a pure deletion, so fixing that alone
    would have made the freeze reachable on every checkout.
- **How it is checked.**
  - *keeping work* does each of these on purpose: Ctrl+S in split editors, a file
    through the lot under two spellings, a second window and a 5 MB buffer at close,
    and a terminal command after a cancelled quit. Main's close question is replaced
    by one that writes it down and answers Cancel. On the build before this, Ctrl+S
    saved the wrong file, the edit was gone after the lot turned over, neither close
    asked anything, and the app quit without a word. The dead shell after Cancel was
    shown separately on that build, with restore off.
  - *line diff*, a unit test, checks the hunks by reverting them over 400 random
    edits, checks the CRLF case, and checks the memory bound by counting the diff's
    typed arrays. The old algorithm allocates 68.7 MB for 1,500 changed lines,
    against a bound of 8 MB.
  - *git gutters* gained a CRLF working copy and a whole-line deletion. The
    deletion was not run against the old build, where it would have frozen the
    window.

### Commands typed for you go only to a prompt, and values go in as data

- **Five buttons typed into whatever had the terminal.** Claude's Run, a block's
  Run again, a script, a history row's `git show` and the directory picker all sent
  their text straight to the terminal whatever held it at the time. With
  `ssh prod` open in the pane, Run on Claude's `rm -rf node_modules && npm ci` ran
  it on the server; with python open it went into the REPL; at a password prompt it
  was sent as the password. They now share one rule, the one the debugger's
  launcher already had: a command is typed only at the shell's prompt. Otherwise
  nothing is sent, and a notice says what has the terminal. It offers **Run in a
  new terminal** beside it, where the command runs once the shell is ready. For a
  program that reads lines, it also offers **Send to “python” anyway**, the one
  deliberate way to type into a REPL. Claude's card now says where it would run,
  "Runs in PowerShell · C:\proj". While the terminal is busy, it says with what, in
  place of the Run button. A shell that never reports its prompt, like the Command
  Prompt, cannot be vouched for either way, so there the second click is
  **Send anyway**. Nothing is ever sent into a password prompt or a full-screen
  program. A proposal in a terminal conversation is marked as run only once it
  has been.
- **A folder name could run code.** The directory picker moved the shell with
  `cd "…"`, and inside double quotes PowerShell and bash both expand `$(…)`. So a
  folder cloned as `a$(New-Item marker)b` ran New-Item the moment someone walked
  into it; the new picker suite watched it happen. Paths, script names, test
  files and the values for a saved command's blanks now go through one quoter per
  shell. The picker types `Set-Location -LiteralPath '…'`, where `-LiteralPath`
  also stops a folder called `[draft]` being read as a wildcard. The one quoter
  that did use single quotes, which also built the command that raises the
  administrator window, doubled only the ASCII quote. Measured on pwsh 7 and
  Windows PowerShell 5.1, `'Bob’s Projects'` is a parse error: PowerShell closes
  a string on ‘ ’ ‚ ‛ as well, so an ordinary name like O’Brien broke out of it.
  All four are doubled now. The Command Prompt has no quoting that holds `%`, `!`
  or `"`, so those are refused with a reason rather than guessed at. A script
  called `say hi` runs as that one script instead of `say` with `hi`.
- **A saved command's blanks go in by where they stand.** A blank standing as its
  own word is quoted as one value. One wrapped in quotes in the saved command,
  `"{{message}}"`, has those quotes replaced. One inside a longer quoted string,
  `"fix: {{what}}"`, goes in as typed. In that last case it is refused if the
  value would end or expand the string, because a value that breaks out of its
  quotes is a value that runs.
- **Escape in the directory picker cancels.** It used to be the move: closing the
  picker anywhere but where it started sent the `cd`, so the gesture every other
  picker means as "never mind" was the one that acted. Walking now ends at an
  explicit **Move the shell here**, first in the list, so it is one more Enter.
- **How it is checked.** Each of these was watched failing first:
  - *typing into terminals* holds the terminal with a program that writes down
    everything it is sent, then presses each button. On the build before this, the
    program received what Run again, Claude's Run and a script sent it. A line
    sent to the program on purpose must reach it as its input and open no block;
    that check failed on the build before its own fix, which had given the line a
    block no prompt would ever close. The history row's check was added after
    the first run, once its selector was corrected, and was not itself seen
    failing.
  - *directory picker* was rewritten around the injection, the apostrophe and
    Escape. On the build before this, Escape moved the shell, the hostile folder
    created its marker, and the move was typed into a running program while a
    notice said "Moved".
  - *shell quoting* is a unit test that hands every value to the real pwsh,
    Windows PowerShell, Git Bash and cmd and reads it back. On the old quoting it
    failed to parse, and the old `cd` created the marker file.

### A save never writes over a newer file, and open editors follow the disk

- **Saving put the old text back over changes made elsewhere.** Nothing watched
  the files an editor had open, and every save wrote without looking. Claude Code
  in the next pane, a `git checkout` in the terminal below, Ember's own Pull or
  branch switch, or a second window could change a file, and the next Ctrl+S — or
  an auto-save a second later — wrote the old version back with one new keystroke
  on top, and showed the tab as cleanly saved. That is the workflow Ember is built
  around, which made it the worst place to lose work silently. Every save now
  carries the version of the file its text was based on, and main checks, byte for
  byte, that the file still holds that version before writing. When it does not,
  nothing is written and a bar across the editor says the file changed on disk.
  The bar offers **Compare** (the disk's version beside yours), **Overwrite** and
  **Load from disk**, which Ctrl+Z undoes, as it now undoes Revert. A file deleted
  underneath the editor gets **Save anyway** or **Close** instead of being quietly
  put back. This covers every route that saves: Ctrl+S, auto-save, Save All, the
  write when a Claude Code diff is accepted, and Claude Code asking Ember to save
  an open file. That last one matters because the session is often what changed
  the file: it used to have its own edit reverted and be told "saved", and now it
  is told why nothing was written. A plain Ctrl+S over a buffer whose file had
  changed underneath used to count as the decision to overwrite it; it asks now.
- **Open editors follow the files they show.** Each open file is looked at every
  two seconds while the window is visible, again when the window gets focus back,
  and straight after Ember's own discard, stash, pull, branch switch and pull
  request checkout.
  - A buffer with no unsaved edits takes the new text as one undoable edit, so
    what Claude Code writes appears where you are reading it, and the caret stays
    put unless the change was under it.
  - A buffer with edits is not touched, and the bar appears now rather than at the
    next save.
  - A deleted file's text is kept and marked as the only copy left.
  - When the file comes back as it was, the bar goes again. That covers a stash
    popped or a branch switched back.

  This is done by polling rather than watching folders. On Windows, a watch on a
  folder stops the folder above it from being renamed. That was measured with both
  Node and PowerShell, and it would have broken renaming a project folder, or any
  folder in Ember's own tree that holds an open file.
- **Unsaved text carried over from the last session remembers what it was based
  on**, so a file changed between one launch and the next is still caught when
  that text is finally saved.
- **Found on the way: undo then redo of a reload could garble the buffer.** Monaco
  replays an edit at offsets counted in the line endings it was made in, but before
  it puts those line endings back. So when a reload had also changed a file's line
  endings, redo put the text a character early for every line above it. A
  line-ending change is now an undo step of its own.
- **Two new suites.** *save conflicts* checks every route that saves. *editors
  follow the disk* checks every case above, including a branch switch through the
  source control panel. Each was watched failing first:
  - *save conflicts* failed on 0.3.26's save path, 11 checks across Ctrl+S,
    auto-save, Save All and a deleted file. Its Claude Code check was added later
    and was watched failing against a save path made to write without looking.
  - *editors follow the disk* failed 12 checks on a build that only had the save
    check.

  Seeing it immediately after Ember's own git actions is a matter of speed only:
  the two-second look gets there anyway. So no check isolates that part, and none
  is claimed to.

### The composer is never cut off under a running command

- **Its last row was clipped at the bottom of the window.** While a command runs,
  its live view takes a share of the pane worked out from how much room the blocks
  above it need. That share was measured against the blocks area — the pane minus
  the composer — and then applied as a percentage of the whole pane. So the live
  view always came out taller than meant, and in a pane with no blocks yet, where
  it takes its largest share, it left the composer less room than it needs: the
  pane clips what overflows it, and the row of key hints under the input was cut
  in half. The share is now worked out in pixels and converted last, and if the
  composer still cannot fit — a very short window — it is the live view that gives
  way. The running block's own header, which the ceiling was always meant to keep
  in view and which the oversized view had been covering, is back above it.

### Caught by the rebuilt gate on its first run

The rebuilt release gate (described below) failed three suites the first time it
ran in full. Two were real bugs the old gate had been passing over; the third was
a check that failed a correct layout.

- **Restoring two windows could leave one of them empty.** Each restored window
  loads its saved blocks and then tells main which panes it answers for, and main
  prunes everything else. With two windows coming back at once, the one that
  finished first pruned to its own list — before the other had loaded — and
  deleted the other window's history, which came back as a blank pane. Whether it
  happened depended on which renderer was slower; it passed in 0.3.26's gate and
  failed in this one, run at lower priority. A window's panes are now spoken for
  from the moment its saved session is handed to it. The suite that restores two
  windows now holds one of them back on purpose, so it tests the race on every run
  instead of when it is unlucky, and it was watched failing that way first.
- **The window grew every time Ember started.** Its size is written down as
  Windows reports it and handed back on the next launch, and at a fractional
  display scale the two do not agree: measured at 110 DPI, a window built at 1000
  by 660 reads back as 1008 by 667, and even an exact resize reads back two pixels
  larger each way, because every conversion to whole device pixels rounds each
  edge outwards. So each launch reopened the window a little bigger than it was
  left, and wrote that down. It is now set, read back, and set again by the error,
  which lands exactly on the size it was given — so the size that is saved is the
  size that comes back. The suite that found it, *the window comes back where it
  was left*, had been written and then never run in the gate.
- **The title bar's corner check failed a button that was flush.** It compared the
  last caption button's edge with `innerWidth`, which is a whole number; at 110 DPI
  the page is 1182.545 pixels wide, the button ends at 1182.545, and the check
  rounded the half pixel between them into a failure. It measures against the
  viewport's real width now, and was watched catching a four-pixel gap.

### A gate that can fail

The release gate is what every other fix relies on to stay fixed, and an audit of
0.3.26 found it could pass while the app was broken.

- **Its first stage could not fail at all.** `verify.mjs` printed "tab completion:
  FAIL" and four siblings and then exited 0 whatever it had seen, and it is the
  suite that covers blocks, exit codes, splits, sessions, themes, completion,
  secret masking, history and the Command Prompt fallback. Everything it used to
  print for a human to read is now a check, and it exits nonzero when any fails.
  Its first honest run caught a check of its own that was wrong: Cancel in
  Settings was being compared against the theme at launch, when the suite had
  deliberately changed theme before reopening the dialog — and with nothing
  previewed in between, the check could not have failed anyway. It now previews a
  theme, proves the preview took, and then asks Cancel to put back the one the
  dialog opened with.
- **Fifteen suites were never run.** Flow control, language-server crash
  recovery, the updater, the Claude panel, the crash boundary and ten more had been
  written, passed once, and dropped out of a fifty-link `&&` chain nobody could
  check by eye. The gate is now `scripts/gate.mjs`, which holds the order in one
  list and refuses to start if any `verify-*.mjs` is neither on it nor set aside
  with a written reason — so a new suite cannot sit outside the gate by being
  forgotten. It runs every suite even after one fails, reports them all together,
  and runs at below-normal priority, which the Electron processes under it inherit:
  the machine stays usable while it grinds.
- **And one of those had been skipping anyway.** The updater's suite would only run
  if the packaged build carried an update-feed file, which the builder writes for
  installers and not for the unpacked build the gate makes — so it reported a skip,
  which passes, on every run. It writes its own feed for the length of the run now,
  and downloads, verifies and stages an update for real.
- **Checks that passed whether or not the bug was there.** These were rewritten
  and then watched failing against the bug each one guards, real or faithfully
  simulated:
  - *A moved session keeps its living shell* searched the pane's text for a marker
    the command line itself contained. With the proof variable deleted — exactly
    what a respawned shell looks like — the old check still said PASS. It reads the
    block's output now, and failed. (*A second window runs its own shell* had the
    same flaw and reads output through the same helper.)
  - *A native command reports its own exit code* matched `/7/` against a line that
    also holds the time of day. It reads the exit badge now, and caught an
    integration that stopped reading native exit codes.
  - *The flood's block is bounded* passed on an empty block, and its comment
    described the capture bug fixed in 0.3.26 as intended behaviour. It now
    requires thousands of rows and a note saying the rest was dropped; against the
    old capture it saw five rows.
  - *A second elevated Ember is turned away* counted any exception from launching
    it as a pass. It now spawns the process and requires a clean exit within
    fifteen seconds; given a profile whose lock was free, the twin stayed up and
    the check failed.
  - *Reload rebuilds the window from the session* was the literal `check(…, true)`.
    It checks for real now, and fails: the reload screen promises to restore the
    workspace, but main hands a window its saved session only once, so a reload
    starts empty and leaves the old shells running unseen. That is carried as a
    known bug rather than hidden — reported on every run, and turned into a
    failure the moment it starts passing, so the fix cannot go unnoticed.
- **Three more were tightened the same way but could not be seen failing here**,
  and are recorded as such rather than claimed. The live-terminal suite's
  *long output keeps its first line* asked `startsWith('line 1')`, the weakness
  fixed in verify-output last release; the identical assertion there failed in two
  of four runs against the old capture, but this suite's shorter command never
  tripped the race in four. *Nothing is written while auto save is off* and *the
  vanished workspace is not restored* passed just as well when the action never
  happened; each now shows its positive half first, using assertions those suites
  already exercise.
- **A fault in the main process fails the suite that caused it.** Main survives an
  uncaught exception on purpose — it logs it to `ember.log` and shows one dialog —
  so a suite driving the window saw nothing wrong while the log filled, and the log
  was deleted with each suite's throwaway profile. Every profile now audits its log
  on the way out and fails the run if main reported anything but updater chatter.
  Five suites in the gate that listened for no page errors now do, on every window
  they open.
- **A skipped suite fails when `EMBER_STRICT` is set**, so a run that is supposed
  to prove everything cannot report itself green having skipped half of it.

## 0.3.26 — 2026-09-06

### A long command keeps its own output

- **Six thousand lines came back beginning at line two thousand.** The front
  third was gone, with nothing to say so. Conpty redraws its viewport whenever a
  command scrolls quickly — cursor home, then the rows it has already sent, each
  closed with an erase-to-end-of-line — and Ember read that bare cursor-home as
  the signature of a full repaint, restarting the block's capture there and
  discarding everything before it. Every byte had arrived: the shell sent all six
  thousand lines and the block threw a third of them away. Only an erase means the
  screen was wiped, so only an erase restarts a capture now.
- **And a redraw no longer takes a screenful out of the middle.** The offscreen
  terminal a block is rendered in matched the live terminal's columns and kept its
  own two hundred rows. Conpty addresses the screen absolutely, so moves written
  for a fourteen-row screen landed fourteen rows down from the top of a two
  hundred-row one: a redraw painted over output in the interior and the stream
  carried on overwriting from there. Arriving before the screen had scrolled at
  all, it took out everything so far. Rows follow the live terminal now, for the
  same reason columns always have.
- **A block no longer sends you to history for output history never had.** Very
  long output can be cut twice — once when the capture itself hits its bound, and
  again when the rendered block does — and the second line was written over the
  first. So a command whose beginning was gone for good said "the full text is in
  history (Ctrl+R)", which was the one place it was guaranteed not to be, history
  being written from that same trimmed output. It says what was actually lost now.
  Found by the fix above: the old repaint bug had been cutting these captures down
  so small that the second bound was never reached, so the lie could not surface.
- **The check meant to catch this had been passing on the bug since the day it was
  written.** It asked whether the block began with "line 1" — a prefix of line
  1000 through line 1999 — so any block that had lost its first thousand-odd lines
  satisfied it, and most had. It reads the first two lines now, and a second check
  walks all six thousand in order. Both were watched failing against the shipped
  build before either fix was written. The suite also says when a command outran
  its own deadline rather than reading a block that is still running and reporting
  it as empty output.

### Typing and chords

- **Suggestions on the command line stopped writing essays.** Asked to complete
  `dism /online /`, the composer offered a paragraph explaining what DISM is. The
  request carried an empty suffix, on the reasoning that nothing follows the caret
  on a command line — but an empty suffix reads to the server as *no* suffix,
  which drops fill-in-the-middle entirely and falls back to the chat template. A
  chat template asked about `dism` explains `dism`. What actually follows the
  caret is the Enter that runs the line, so that is what is sent now: `sfc /`
  becomes `scannow`, `git comm` becomes `it -m "Initial commit"`, and
  `dism /online /` becomes `cleanup-image /restorehealth`.
- **Search everything is `Ctrl+Shift+A`.** It was briefly `Ctrl+Shift+O`, which is
  Monaco's Go to Symbol in File — so the chord the title bar advertised opened the
  search in a terminal and the symbol list in an editor. Checking this app's own
  registry for a conflict is not enough when half the window is somebody else's
  keymap.
- **Settings no longer says Tab accepts a suggestion everywhere.** It does in the
  editor. On the command line Tab belongs to shell completion, and the gesture is
  Right or End.
- The README was rewritten for somebody deciding whether to install this, and an
  audit against the source found several claims that had never been true — Git
  Bash and WSL do have shell integration, there are five language servers rather
  than four, and `Ctrl+O` opens a file rather than a folder.

## 0.3.25 — 2026-09-06

Three ways to lose work silently, an administrator window that stops lying about
why it failed, and the last of the design pass. The three data-loss bugs were
found by an adversarial audit of code that had been recorded as suspect months
earlier and never re-examined; two of the four claims it re-tested turned out to
be wrong, which is recorded here because re-asserting them would cost a fix for
nothing.

### Three ways your work could disappear without a word

- **Accepting a proposed change no longer overwrites edits made while it waited.**
  A proposal pane is a frozen snapshot: it reads the file once, nothing watches it
  afterwards, and a proposal raised in the Claude panel waits indefinitely. The
  file stays writable the whole time — by your own save, a formatter, a
  `git checkout` in the terminal below, a second Claude session — and accepting
  wrote the proposed text with no read-back, so whatever had arrived in between
  was gone. The editor then had its buffer reset to match, because the buffer
  looked unmodified: it had been saved. No dialog, no unsaved marker, and Claude
  was told the file was written. It reads the file first now and refuses rather
  than merging, telling both you and Claude why.
- **A breakpoint set while the debugger is starting is no longer erased.** Startup
  tells the adapter about one file at a time and waits for each. Every file's list
  was captured before the first of those exchanges, so a breakpoint added during
  an earlier file's turn was written back out of existence by the time its own
  file came round — from the margin, from the adapter, and permanently, because
  nothing resends afterwards. Which is precisely the moment somebody is most
  likely to be setting one.
- **A session moved to another window mid-answer no longer arrives holding a
  ghost.** Claude's reply is addressed to the window that asked, so a turn still
  streaming when its session walks out can never be finished by anyone. The panel
  refuses to send while anything is streaming, so its input was dead for the life
  of that window — and Stop always targets the first streaming turn, so the ghost
  absorbed every Stop from then on and a real answer behind it could never be
  interrupted.
- **And a change that cannot be written now says so.** A read-only file, one
  locked by another process, or a missing folder produced no message anywhere and
  left the proposal pane standing with both its buttons dead and no way to close
  it.

### The administrator window

- **Arguments with spaces in them survive the crossing.** The elevated window is
  raised through PowerShell, and its arguments cross two parsers that quote
  differently; only one of them was handled. An account name like
  `C:\Users\First Last` split in two, and the elevated Ember then adopted a
  truncated settings directory, wrote its "I have started" marker in the wrong
  place, and twenty-five seconds later the ordinary window announced that Windows
  had never started a window you were looking straight at.
- **That twenty-five second verdict can now be taken back.** It is a guess at how
  long a cold start takes, and the notice waits to be dismissed by hand — so
  getting it wrong left a false and alarming diagnosis on screen indefinitely. The
  watch keeps looking for another minute and says so if the window turns up.
- **The Administrator badge says what being elevated costs.** Keeping its own
  settings, session and history is deliberate — a file written by an administrator
  may be one the ordinary Ember can no longer replace — but it means two windows
  that look identical do not share what you change in them. Nothing said so, which
  is why settings that had drifted apart for six days looked like a bug.

### The administrator window opens

- **The button did nothing, and it was never your machine.** Ember raised the
  elevated window through a PowerShell child created as a *detached* process — and
  a detached process cannot raise the consent prompt. No prompt appeared, nothing
  started, and PowerShell exited reporting success. So Ember watched for a window
  that was never coming and, after twenty-five seconds, told you your machine's
  elevation was stuck and to restart Windows. Right-clicking the icon and choosing
  Run as administrator worked the whole time, which is what finally told the two
  apart. The child is no longer detached.

### Typing, suggestions and completion

- **Inline suggestions reach the terminal, not only the editor.** A model chosen in
  Settings did nothing for anybody typing a *command*, which is most of what this
  app is for — the feature was wired to the editor alone, and the grey text in the
  composer was command history and only ever history. The model is asked behind
  history rather than beside it: history is instant and already right for the
  command you ran last week, so the model is consulted only where history has
  nothing to say. Its answer joins the same grey text you already accept with Right
  or End, so there is one suggestion and one gesture rather than two competing.
- **A switch is no longer completed as a path.** Typing `dism /On` and pressing Tab
  replaced the switch with `C:\OneDriveTemp`. PowerShell reads a token beginning
  with `/` as a path from the drive root, which is right for `cd /Users` and wrong
  for the whole family of Windows tools that take switches — dism, robocopy, sfc,
  chkdsk, ipconfig, reg, icacls. The result shared nothing with what you typed, so
  it was not a completion but damage. Switches after a native command are left
  alone now; `cd /Users` still completes.
- **The size you set is the size you type at.** The font-size setting reached the
  terminal, the editor and the block that echoes your command — and stopped at the
  box you type into. Set nineteen pixels and you typed at thirteen, then watched it
  come back at eighteen and a half one row above. The agent's own surfaces had the
  same fault: at the largest setting its answers rendered at thirteen pixels beside
  thirty-one pixels of output.

### The rest of the design pass

- **The window is lit from its own first pixel.** The title bar sat outside the
  window's gradient on a flat fill that was *darker* than the ramp below it on
  every theme — so the brightest row in an Ember window was the forty-first, those
  first forty pixels read as a lid, and the seam beneath them read as a slot of
  light. The ramp starts at the top of the window now.
- **The window buttons are buttons.** They had a width and no height, so each was
  the line box of an eleven-pixel glyph — about fifteen pixels tall in a
  forty-pixel bar, the only controls in the window under the twenty-four the
  guidelines ask for. And the bar's right padding meant the very corner of a
  maximized window was a drag region: the fling into the corner that closes every
  other Windows program started moving this one instead.
- **A toggle says whether it is on, and keeps saying it under the pointer.** The
  panel toggle's entire pressed state was a text colour its own hover already set,
  so open-and-hovered and closed-and-hovered were identical — the button said
  nothing at the exact moment you were deciding whether to press it. The slot
  toggle had no pressed state at all.
- **The search box stops repeating the palette.** It said, word for word, the
  placeholder of the box it opens — a sentence whose only reader is somebody who
  has not pressed it yet. It names its chord instead, and the everything-search has
  one for the first time: **Ctrl+Shift+O**. Like every other hint here, the chord
  retires the first time you press it.
- **One mark, one treatment.** A keyboard cap was drawn four different ways
  depending on which legend wanted it; a file and a folder in one list were two
  different sizes to end up the same height; a button shrank because it moved into
  a different bar. A cap is a word in the sentence it stands in, so it takes that
  sentence's size.
- **Shadows are made of the theme's own light.** Every shadow in the app was
  literal black, which greys the ground on a light theme and pulls the colour out
  of one with a hue — Tidewater, Solar Dusk, Ember Deep. Each theme derives its
  own now: Paper casts a warm grey, Tidewater something very nearly black. The
  scrim over a dialog stays neutral on purpose; it is darkness laid over the whole
  window rather than light falling off an object.

## 0.3.24 — 2026-09-05

Three things that all presented the same way: the app quietly doing nothing.
Two of them were found by using it, and the third by an adversarial audit of
the code around them. None of them were visible to the checks, and in each case
the reason is more interesting than the bug.

### Asking Claude about an error now sends the error

- **"Explain last error" sent the question and threw the error away.** A question
  reaches a model one of two ways — the Anthropic API when a key is set, the
  Claude Code CLI when one is not — and each door assembled the system prompt for
  itself. The two copies drifted: the API path grew the attached blocks and the
  open file, and the CLI path never did. So for everyone signed in through the
  CLI rather than with a key, which is the ordinary way to use this, the model
  was asked why something had failed and shown nothing that had failed. The open
  file went the same way, so a question asked in the editor arrived without it.
- **Why no check caught it.** Every attachment check runs against the fake
  backend, which short-circuits before both real paths — so the covered path was
  not the used one, and the suite proved attachments reached a backend nobody is
  on. The fix is not another check on that seam: there is one builder now, and a
  door cannot forget to call what it does not have.

### Suggestions say why they are not appearing

- **A model that cannot fill in the middle now says so**, instead of returning
  nothing. That ability has to be trained into a model and spelled out in its
  template, and the newer agent-shaped coder models have dropped it while keeping
  the word "coder" in the name — `qwen3-coder:30b` cannot, the whole
  `qwen2.5-coder` family can. Asked anyway, such a model answers nothing and
  raises nothing, which is exactly what a model with nothing to suggest looks
  like. So the feature appeared broken with no clue anywhere as to what to change.
- **The model list marks them.** Read from the server rather than from a list of
  names kept in the app — Ollama reports what each model can do, and a hand-kept
  list of known-bad names would be wrong the week after it shipped. Marked rather
  than hidden: it is your server, and a list that quietly omits something you can
  see installed is the same unexplained silence one layer further back.
- **Unknown is not no.** An endpoint that lists names and nothing else leaves the
  answer unknown, and the request goes ahead exactly as before — refusing there
  would break every server that works fine and does not advertise.

### The administrator window stops fighting itself

- **Two elevated Embers can no longer run at once.** The single-instance check
  read "if this is not the admin window, and the lock is not free" — which
  short-circuits, so an elevated Ember never asked for a lock at all, above a
  comment claiming it held one. Two of them then shared one directory, each
  rewriting the whole session file from its own private map every second or so,
  so each erased the other's windows continuously — and a session snapshot
  carries unsaved editor buffers. It never needed the menu item either: any
  elevated launch is an administrator window, so Run as administrator from the
  taskbar beside an open one reached the same state.
- **The elevated window keeps up with your settings.** It was seeded once, ever —
  a photograph of your preferences on the day it first opened, drifting from that
  moment on. On the machine this was found on it still had a different default
  shell and a different suggestion model six days later, with nothing on screen
  to say why. Your themes and snippets travel with it now too: a theme id is a
  reference, and carrying the name without the file it names left the elevated
  window in a different colour scheme.
- **A failure is no longer reported as "you declined the prompt".** The reason was
  being discarded and then a cause asserted, so anyone whose elevation was broken
  for a reason they had not chosen was told they had dismissed a prompt they never
  saw. It now tells a real decline apart from everything else, says what actually
  went wrong, and writes it to the log.
- **And a press can no longer produce nothing at all.** When the launch failed
  before it began, the notice and the twenty-five second watchdog both sat in a
  branch that never ran — which is precisely the "a broken machine looks exactly
  like a broken button" the watchdog exists to end, surviving in the one path it
  did not cover.
- **The administrator window's own suite now runs in the gate.** It had one, and
  it was never run — which is how a lock that was never requested survived in a
  project that gates on everything else.

## 0.3.23 — 2026-09-05

### A window with a light source

A design pass with Warp as the reference. It began as a question of taste and
turned into a list of decisions that had been made and then silently overridden:
four separate times, the stylesheet said one thing and rendered another. The app
was not flat for want of effects. It was flat because the effects it had did not
reach the screen.

- **The window's ground is visible for the first time.** Ember has had a vertical
  gradient on the workspace since the look was chosen, and `.region--shells` was
  made transparent so the blocks would sit on it — there is a comment saying so.
  Nobody followed the chain one level further down. `.pane` has carried a flat
  fill since the first commit, and `.pane` holds the scrollback, the ruler, the
  terminal and the composer, so the ramp was painted over everywhere it mattered.
  What showed was a thirty-pixel band under the composer.
- **Light themes are lit from above.** The ramp had only ever been reasoned about
  on a dark theme. On Paper, Ember Light and Red–Green Safe (Light) the top of the
  window was *darker* than the middle, so a light window was a valley with a band
  of light across it and no light source anywhere.
- **What you can press is lit; what you cannot is not.** The status chips are
  raised panels now, lit from a top face down to a bottom one and translucent so
  the ground still tints them. The language label beside them is not — it carried
  a comment reading "a label with nothing behind it stays plain rather than
  pretending to be pressable" directly above six declarations giving it, byte for
  byte, the chrome of the eight things next to it that are.
- **You can tell which session you are in.** The active card and a card the
  pointer happened to be crossing were the same fill, byte for byte, separated by
  one hairline — and because `:hover` is a class plus a pseudo-class while the
  active class is a bare class, hover outranked it, so under the pointer there was
  no difference at all. The active card is a lit surface carrying the accent edge
  this app already uses for active in five other places.
- **A running session and a failed one differ in shape, not only in hue.** They
  were one seven-pixel circle in two colours, with a breathing animation carrying
  the difference — except the app clamps every animation to nothing for anyone who
  asks their system to stop moving things, and the two colours resolve to *the same
  hex* on Solar Dusk. A ring for in progress, a square for stopped badly.
- **Blocks stop casting a shadow for a card they no longer are.** When blocks were
  flattened for density they were given no shadow; a more specific rule from the
  card era went on winning, so every block on every dark theme cast a twenty-six
  pixel shadow with nothing above it to justify one. Invisible against a flat
  pane. Not invisible against a ground, which is what finally made it findable.
- **Contrast is measured against the surfaces text actually lands on.** Every
  colour was checked against the base — a colour that exists on one line of the
  window. Both ends of the ground and all three faces are now in the same list,
  and a guard fails if a raised surface ever escapes the band the palette has
  already paid for. All ten themes clear it unchanged, so this is a gate widened
  rather than a palette altered.

Not one pixel of padding, gap, type size or radius moves in any of it. Blocks are
exactly as dense as they were.

### Say a thing where it is news, and nowhere else

The other half of the pass, from Warp's per-block context line.

- **A block says where it ran** — on the blocks where that changed, and not on the
  forty after it. A block scrolled back to could not previously tell you where it
  had happened, and the status bar only ever knows about now.
- **Keyboard hints retire once they have taught you.** Five chords were listed
  under the composer permanently. Each line now disappears for good the first time
  its chord is pressed, which is the proof it was read. Nothing is timed out and
  nothing is counted, so a chord you never press is never taken away from you. A
  composer that has been used for a week shows one line, and it is an action
  rather than a legend.
- **An empty pane stops explaining itself** once it has. The welcome sentence goes
  with the first command ever run, and each of the five chord hints with its own
  first press.
- **The whole block is the target for its actions**, rather than the command line
  inside it — the copy and re-run controls appeared on a hover area narrower than
  the thing you were pointing at.
- **Failure is the rule down the left and nothing else.** It used to colour the
  separator underneath as well, and a red line under a block read as a frame drawn
  around it.

### The project's tests, one press each

- **The Run view lists the test files it can find** and runs one on a press,
  alongside the scripts it already listed. Discovery is gated on the project
  actually having a test script, so nothing appears for a project that cannot run
  them.

*Releases 0.3.10 through 0.3.22 have no entries here — thirteen of them, while the
file went unmaintained. They are deliberately not written up after the fact: an
entry reconstructed from its own commits months later is a guess wearing the same
clothes as the rest of this file, and this file is worth something only while every
line in it was written by somebody who knew. What those releases changed is in the
commits between the tags `v0.3.9` and `v0.3.23`.*

## 0.3.9 — 2026-08-29

### An administrator window, beside the ordinary one

- **`Ctrl+Shift+Alt+N`, the command palette, or the + menu** opens a second
  Ember running as administrator, after the usual permission prompt. Every
  shell in it is elevated; the window you were already using is untouched and
  keeps running as you.
- **Deliberately not a mode for the whole app.** Windows cannot mix integrity
  levels inside one process, so an elevated window has to be an elevated
  process. Elevating all of Ember instead would hand administrator rights to
  the language servers and to the agent that proposes and runs commands —
  a great deal of privilege for the sake of one `Remove-Item` under Program
  Files.
- **It says what it is.** An Administrator badge sits in its title bar for the
  window's whole life, because which window is elevated is not a thing to
  discover by accident three commands later.
- The elevated window keeps its own user-data directory, seeded from yours so
  it looks and behaves the same, rather than fighting the ordinary window over
  one session file, one settings file and one history database. It runs no
  update checks and no Claude Code bridge: an agent's edits should not land in
  the elevated window, and an update should not install itself as administrator.

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
