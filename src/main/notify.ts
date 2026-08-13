import { app, BrowserWindow, Notification } from 'electron'
import { join } from 'node:path'
import type { CommandNotice } from '../shared/types.js'

/**
 * Desktop notifications for commands that finished while you were elsewhere.
 *
 * Windows will not show a toast from an application it cannot identify, so the
 * AppUserModelID has to be set before the first notification — without it they are
 * silently dropped, which looks exactly like the feature not working.
 */
export class Notifier {
  constructor(private focus: () => void) {
    if (process.platform === 'win32') {
      // Matches the appId electron-builder installs under, so a packaged build and
      // a development one are the same application as far as the shell is concerned.
      app.setAppUserModelId('dev.dkflint.ember')
    }
  }

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
      // The command itself, which is the only thing that identifies which of
      // several long-running things this was.
      body: notice.command.length > 120 ? `${notice.command.slice(0, 117)}…` : notice.command,
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

/** Bring the window back and put it in front, for a notification click. */
export function focusWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
