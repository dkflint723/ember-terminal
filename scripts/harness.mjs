/**
 * Pieces every verification suite can share.
 *
 * The suites grew one at a time, each with its own copy of launch, check and exit,
 * and each copy drifted: most listened for uncaught page errors on the one page they
 * drove, a suite that opened a second window or relaunched stopped listening at the
 * first page, and five suites in the gate listened for none at all. What belongs in
 * every suite lives here instead, so the next one gets it by importing it.
 */

/**
 * Collect every uncaught page error from every window an app has, or opens later.
 *
 * Playwright reports windows that already exist through `windows()` and new ones
 * through the 'window' event, so both are hooked; a window cannot appear in both.
 * `ignore` names errors a suite causes on purpose.
 */
export function watchPageErrors(app, sink, { ignore = [] } = {}) {
  const hook = (w) =>
    w.on('pageerror', (e) => {
      if (!ignore.some((re) => re.test(e.message))) sink.push(e.message)
    })
  for (const w of app.windows()) hook(w)
  app.on('window', hook)
  return app
}
