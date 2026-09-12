import { app, BrowserWindow, Notification } from 'electron'
import { join } from 'node:path'
import type { CommandNotice } from '../shared/types.js'
import { redactSecrets } from '../shared/secrets.js'

/**
 * Desktop notifications for commands that finished while you were elsewhere.
 *
 * Windows will not show a toast from an application it cannot identify. The
 * AppUserModelID that identifies it is set at the very top of main/index.ts,
 * before the window exists — setting it here, at construction time, was late
 * enough that the taskbar had already filed the window under Electron's own
 * identity and showed Electron's icon for the life of the process.
 */
export class Notifier {
  constructor(private focus: () => void) {}

  get supported(): boolean {
    return Notification.isSupported()
  }

  /**
   * Show one. The renderer decides *whether* to — it knows the threshold, whether
   * the window had focus, and whether the command was an interactive session — and
   * this only decides how it looks.
   */
  show(notice: CommandNotice): void {
    if (!Notification.isSupported()) return

    const seconds = notice.durationMs / 1000
    const took = seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
      : `${seconds.toFixed(1)}s`

    const notification = new Notification({
      title: notice.ok ? `Finished in ${took}` : `Failed after ${took}`,
      /*
       * The command itself, which is the only thing that identifies which of
       * several long-running things this was — with any credential in it taken
       * out. A toast is not a fleeting thing on Windows: it is kept in the Action
       * Center, which is on disk and outlives the window that raised it.
       */
      body: shorten(redactSecrets(notice.command)),
      icon: join(
        app.isPackaged ? process.resourcesPath : app.getAppPath(),
        'resources',
        'icon.png'
      ),
      // Failures are worth a sound; a build finishing quietly is not.
      silent: notice.ok
    })

    notification.on('click', () => this.focus())
    notification.show()
  }
}

/** A toast is one line, and the tail of a long command line says the least. */
function shorten(command: string): string {
  return command.length > 120 ? `${command.slice(0, 117)}…` : command
}

/** Bring the window back and put it in front, for a notification click. */
export function focusWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
