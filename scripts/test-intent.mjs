// Which of the two things a typed line is, one line at a time.
//
// The composer routes what you type to a shell or to a model, and it decides from
// the text alone, on every keystroke. The two mistakes are not the same size. A
// question sent to the shell is usually just an error message — but when the line
// happens to also be a valid command it is not: "npm install is slow" installed
// packages named is and slow, "pip install breaks my venv" pulled two more off
// PyPI, and "exit code 1 from npm test" closed the shell, because PowerShell's
// exit takes an expression and evaluated the rest of the sentence as one.
//
// A table, because the rules are a pile of overlapping heuristics and the only
// way to change one safely is to see what it does to the others. Every line in it
// is one somebody could plausibly type.
//
// Run: node --no-warnings scripts/test-intent.mjs
import { classifyIntent } from '../src/renderer/src/composer/intent.ts'

/** Lines whose routing is settled, and has to stay settled. */
const CASES = [
  ["npm install is slow", "agent", "the audit: installs packages named is and slow"],
  ["exit code 1 from npm test", "agent", "the audit: PowerShell exit evaluates the rest and closes the shell"],
  ["rm the old logs", "agent", "the audit: deletes files named the, old and logs"],
  ["del the old build folder", "agent", "the audit"],
  ["pip install breaks my venv", "agent", "the audit: pulls PyPI packages named after English words"],
  ["npm install hangs forever?", "agent", "the audit"],
  ["build --release", "shell", "the audit: a project script, not a request"],
  ["deploy staging", "shell", "the audit"],
  ["setup /quiet", "shell", "the audit"],
  ["rg \"is not a function\" src", "shell", "a search pattern is an argument, whatever it reads like"],
  ["refactor intent.ts to use a lookup table", "agent", "prose that names a file is still prose"],
  ["git commit -m \"fix the login bug\"", "shell", "a quoted message is not a question"],
  ["echo the build is done > status.txt", "shell", "a redirect is what a shell is for"],
  ["find . -name x", "shell"],
  ["find the file that imports the store", "agent"],
  ["make all", "shell"],
  ["make all the tests pass", "agent"],
  ["docker ps?", "shell", "short lines keep their command reading"],
  ["git status", "shell"],
  ["cd ..", "shell"],
  ["ls -la", "shell"],
  ["kill port 3000", "shell", "two words after the head is still a command shape"],
  ["restart nginx", "shell", "one word after the head"],
  ["npx create-next-app hung at the install step", "agent", "past-tense report of what already happened"],
  ["git rebase keeps eating my stash", "agent", "\"keeps\" plus a possessive is narration, not a git subcommand"],
  ["docker compose keeps restarting the db", "agent", "an observation about container behavior, not a compose subcommand"],
  ["del wiped the wrong folder, can I undo it?", "agent", "asking about damage already done, not asking to repeat it"],
  ["kill -9 doesn't stop the process", "agent", "reports that a signal failed; no PID to act on"],
  ["curl returns 404 but the browser works", "agent", "contrastive \"but\" clause comparing two clients"],
  ["ssh hangs on that box after the update", "agent", "\"that box\" is a reference, not a hostname argument"],
  ["node crashed with heap out of memory, how do I raise it?", "agent", "crash report plus an explicit how-do-I question"],
  ["python is resolving to the wrong venv, why?", "agent", "asks for a cause, not for an interpreter to start"],
  ["cd doesn't persist between commands here", "agent", "a statement about cd's semantics with no target directory"],
  ["kubectl get pods returns nothing, is the context wrong?", "agent", "diagnostic question about the result of a prior run"],
  ["make clean didn't actually clean anything", "agent", "past-tense complaint; rerunning make clean is not what is wanted"],
  ["grep found nothing but the string is there", "agent", "contradiction between result and expectation, with no pattern given"],
  ["cargo build works but cargo test fails", "agent", "compares two invocations; running it would only do the first"],
  ["go mod tidy removed a dependency I need", "agent", "reports an unwanted edit and implies a fix is wanted"],
  ["ping times out only over the VPN", "agent", "a conditional observation with no host to ping"],
  ["chmod +x didn't survive the checkout", "agent", "describes a lost permission bit; no file operand present"],
  ["history got wiped when the terminal crashed", "agent", "narrates a loss; running history would just print the empty list"],
  ["which python does the venv actually use?", "agent", "\"which\" is interrogative here, not the lookup tool"],
  ["clear the scrollback but keep my session", "agent", "a qualified instruction bare clear cannot express, though some would want plain clear"],
  ["start the dev server on 3001", "agent", "names no script, so the agent must pick the command — but a user may expect shell start"],
  ["how do I pipe git log | head?", "agent", "interrogative opener with a question mark; the pipe is being asked about, not used"],
  ["what does chmod 755 do", "agent", "a question with no question mark that names a command as its subject"],
  ["explain this stack trace", "agent", "plain imperative request; 'explain' is no one's binary"],
  ["the build is broken", "agent", "bare statement of a problem, opening with a determiner no command starts with"],
  ["it says permission denied", "agent", "reporting an error message; pronoun subject, nothing runnable"],
  ["git blame is confusing, how do I read it?", "agent", "a sentence about a command rather than an invocation of it"],
  ["npm run build works but npm run dev doesn't", "agent", "comparing two behaviours; sent to the shell it would actually start a build"],
  ["docker says no space left on device", "agent", "quoting a tool's error, not calling the tool"],
  ["webpack build fails after upgrading to node 22", "agent", "past-tense report about webpack; 'fails after upgrading to' is not argument syntax"],
  ["pytest collects 0 items and I don't know why", "agent", "observation plus admission of confusion; would otherwise re-run the suite"],
  ["why did the postinstall hook run twice", "agent", "interrogative opener, no question mark typed"],
  ["is there a way to undo the last commit", "agent", "yes/no question about git, phrased entirely in English"],
  ["any idea why the dev server exits with code 1", "agent", "hedged question opener; nothing on the line is a command"],
  ["whats the difference between npm ci and npm install", "agent", "comparison question naming two commands as its objects"],
  ["does eslint cache results between runs", "agent", "auxiliary-verb question about a tool's behaviour, no question mark"],
  ["help me understand this regex", "agent", "'help' plus a pronoun object is a request, not the builtin"],
  ["make sense of this error output", "agent", "'make' with a determiner in the object; there is no such target"],
  ["rename these test files to match the new convention", "agent", "a bulk refactor described in prose, not a two-argument rename"],
  ["review the diff before I push", "agent", "request for judgement ahead of an action"],
  ["tests pass locally but fail in CI", "agent", "contrastive statement of a problem with no verb the shell knows"],
  ["walk me through what resolveAmbiguous does", "agent", "request for an explanation of a function by name"],
  ["clear the old build output", "agent", "'clear' with a determiner object means delete artifacts, not clear the screen"],
  ["git commit -m \"why is this null?\"", "shell", "the question mark is inside quotes, not addressed to the terminal"],
  ["git log --author=\"dkflint\" --since=\"2 weeks ago\" --pretty=format:\"%h %s\" -- src/renderer", "shell", "length and quoted English are all flag values on a known command"],
  ["echo the api key is not set", "shell", "printing a sentence is echo's entire job, operator or not"],
  ["grep the src -r", "shell", "\"the\" is the pattern being searched for, not a determiner"],
  ["grep -r \"the user is not logged in\" src/", "shell", "a whole quoted sentence as a search pattern, flanked by a flag and a path"],
  ["cat the log | more", "shell", "a pipe settles it even though an ambiguous command is followed by \"the\""],
  ["sed -i 's/the old name/the new name/g' README.md", "shell", "two English phrases inside a substitution expression"],
  ["find . -name \"*.test.ts\" -newer package.json", "shell", "find with a dot, flags and a glob is the command reading, not the verb"],
  ["ls src dist build", "shell", "three plain nouns after ls are directories, not a phrase"],
  ["which tsc", "shell", "\"which\" opens questions too, but two tokens and a binary name is a lookup"],
  ["set NODE_ENV=production", "shell", "an assignment argument, not the verb \"set\""],
  ["$env:VITE_API_URL = \"http://localhost:5173\"", "shell", "a line that starts with a variable is PowerShell before it is anything"],
  ["VITE_API_URL=http://localhost:3000 npm run dev", "shell", "an inline env assignment prefixing a command"],
  [".\\scripts\\build.ps1 -Configuration Release -Verbose", "shell", "a relative script path is a file to execute"],
  ["& \"C:\\Program Files\\nodejs\\node.exe\" --version", "shell", "the call operator plus a quoted absolute path with a space in it"],
  ["for %f in (*.log) do @echo %f", "shell", "a cmd loop whose keywords (in, do) read as English but glob and %vars do not"],
  ["foreach ($f in $files) { Remove-Item $f -Force }", "shell", "PowerShell loop syntax: variables, braces and a cmdlet"],
  ["Get-Content .\\server.log -Tail 200 | Select-String \"connection refused\"", "shell", "Verb-Noun cmdlets piped together, with prose as the match string"],
  ["robocopy D:\\builds\\latest \\\\fileserver\\releases /MIR /R:2 /W:5 /LOG:copy.log", "shell", "drive path, UNC share and Windows-style switches"],
  ["curl -s \"https://api.example.com/v1/items?limit=10\" | jq \".items | length\"", "shell", "the \"?\" is a query string and the pipes are real pipes"],
  ["npm run build", "shell", "the most ordinary project script there is"],
  ["setup /quiet /norestart", "shell", "installer switches; nobody asks an agent for /quiet"],
  ["pre-commit run --all-files", "shell", "a real hyphenated tool whose prefix looks like English hyphenation"],
  ["find . -name \"*.snap\" -delete", "shell", "dot path plus flags is argv, not a phrase"],
  ["where node npm", "shell", "two plain arguments to Windows where, not three words of English"],
  ["help", "shell", "bare help is PowerShell's pager, though a beginner may mean the agent"],
  ["help me", "agent", "one pronoun added and it is plainly addressed to a person"],
  ["write-host \"the build is done\"", "shell", "the determiner and auxiliary are the string being printed"],
  ["rg is not finding anything in src, why?", "agent", "same words unquoted, ending in a question about the tool"],
  ["npm test -- -t \"renders the empty state\"", "shell", "prose is the -t filter argument"],
  ["npm test keeps hanging on the store spec", "agent", "a complaint about the command, with no question mark to signal it"],
  ["psql -c \"select * from users where email is null\"", "shell", "SQL is another language full of English stopwords"],
  ["psql wont connect from wsl, any ideas?", "agent", "same opener, but asking rather than invoking"],
  ["start .", "shell", "opens the current folder in Explorer"],
  ["npm ci; npm test", "shell", "semicolon joining two commands, with no English around it"],
  ["the build breaks on ci; locally it passes", "agent", "same semicolon joining two clauses instead"],
  ["make all tests deterministic", "agent", "all now quantifies a noun, and no other English word appears"],
  ["remove-item dist -recurse", "shell", "verb-noun cmdlet with a switch"],
  ["re-run the failing spec", "agent", "hyphenated English prefix, not a cmdlet verb"],
  [".\\build.ps1 -Release", "shell", "a script path in first position is a thing to run"],
  ["why does .\\build.ps1 fail on a clean clone", "agent", "the same path is the subject of a question, not the command"],
]

/*
 * Lines that still go the wrong way, written down rather than left out.
 *
 * Three kinds, none of them reached by the rule this file was written for: prose
 * carrying a flag or a path ("rm -rf node_modules didn't fix it"), prose with no
 * function word in it at all ("cat mangles CRLF line endings"), and bare-word
 * command lines long enough to trip the length rule ("make clean deps build test
 * lint docs"). Two more — "kill port 3000" and "restart nginx" — are in the
 * audit's own list of misroutings, and its own prescription does not reach them
 * either: two words after a command name is still a command shape.
 *
 * Each is asserted to be still wrong, so that fixing one fails here and says so.
 * A gap nobody is told about is indistinguishable from a gap nobody knows about.
 */
const GAPS = [
  ["git push --force-with-lease safer than --force?", "agent", "shell"],
  ["curl -I returns 301, should I follow it?", "agent", "shell"],
  ["ls sorts dotfiles first now", "agent", "shell"],
  ["cat mangles CRLF line endings", "agent", "shell"],
  ["ps shows two electron processes", "agent", "shell"],
  ["write a script that renames these files to kebab-case", "agent", "shell"],
  ["rm -rf node_modules didn't fix it", "agent", "shell"],
  ["git push --force didn't work, it says the branch is protected", "agent", "shell"],
  ["safe to run git reset --hard here?", "agent", "shell"],
  ["bump react to 19 in package.json", "agent", "shell"],
  ["something in src/main.ts breaks on startup", "agent", "shell"],
  ["make clean deps build test lint docs", "shell", "agent"],
  ["just lint format typecheck test build docs", "shell", "agent"],
  ["find duplicate config keys", "agent", "shell"],
  ["where npm puts global installs", "agent", "shell"],
  ["write a test for the retry helper", "agent", "shell"],
  ["start over", "agent", "shell"],
]

let failures = 0
const fail = (message) => {
  failures++
  console.log('  - ' + message)
}

for (const [line, want, why] of CASES) {
  const got = classifyIntent(line)
  if (got !== want) {
    fail(JSON.stringify(line) + ' went to ' + got + ', wanted ' + want + (why ? ' — ' + why : ''))
  }
}

/* A gap that closed is news, and so is one that moved. */
for (const [line, want, gets] of GAPS) {
  const got = classifyIntent(line)
  if (got === want) {
    fail(JSON.stringify(line) + ' now goes to ' + want + ', which is right — move it into CASES')
  } else if (got !== gets) {
    fail(JSON.stringify(line) + ' went to ' + got + '; it used to go to ' + gets)
  }
}

console.log('intent: ' + CASES.length + ' settled, ' + GAPS.length + ' known gaps')
console.log(failures === 0 ? 'intent classifier: PASS' : 'intent classifier: FAIL')
process.exit(failures === 0 ? 0 : 1)
