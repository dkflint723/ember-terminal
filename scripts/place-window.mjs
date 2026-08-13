/**
 * Put a harness window in the top-right corner of the primary display.
 *
 * The verification scripts drive a real, visible Electron window — there is no
 * headless mode for a terminal that has to render through a GPU canvas. Left alone
 * it lands wherever Electron decides, which on a machine someone is working on
 * means over the top of whatever they were doing. Top-right keeps it out of the way
 * and consistent, so screenshots also stay comparable between runs.
 *
 * Runs in the main process via Playwright's `app.evaluate`, which is the only place
 * BrowserWindow and screen are reachable.
 */
export async function placeTopRight(app) {
  try {
    await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      // workArea, not bounds: it excludes the taskbar, so the title bar stays
      // reachable on a display with the bar along the top.
      const area = screen.getPrimaryDisplay().workArea
      const [width, height] = win.getSize()
      win.setPosition(
        Math.max(area.x, area.x + area.width - width),
        Math.max(area.y, Math.min(area.y, area.y + area.height - height))
      )
    })
  } catch {
    // Positioning is a courtesy, never a reason for a verification run to fail.
  }
}
