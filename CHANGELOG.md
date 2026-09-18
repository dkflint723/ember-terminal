# Changelog

Notable changes to Ember. Versions follow [semver](https://semver.org); the
newest entry sits on top.

## Unreleased

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

*Releases 0.3.9 through 0.3.22 have no entries here — the file went unmaintained
through those. Their contents are in the tags and the commit log.*

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
