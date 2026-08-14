/**
 * Opening a file and putting the cursor somewhere in it.
 *
 * The app root owns this — it knows how to read a file, choose a pane and wait for
 * the editor to claim the model — but the things that need it are scattered:
 * search results, the problems list, and Go to Definition from inside an editor.
 * Threading a callback down through the pane tree to reach one action would mean
 * every component in between carrying something it does not use.
 *
 * The same shape the palette uses for its file opener, for the same reason.
 */
type Revealer = (filePath: string, line: number, column: number) => void

let reveal: Revealer = () => {}

export function setRevealer(fn: Revealer): void {
  reveal = fn
}

/** Open `filePath` and put the cursor on that position. Line is 1-based. */
export function openAt(filePath: string, line: number, column: number): void {
  reveal(filePath, line, column)
}
