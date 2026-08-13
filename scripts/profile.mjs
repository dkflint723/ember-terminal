import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * A throwaway Electron profile for a verification run.
 *
 * Every harness launched against the real userData directory until now, which meant
 * each run appended to the user's command history and wrote their settings file.
 * Session restore made that visible rather than merely rude: a run would come back
 * holding the previous run's tabs, and checks that assumed a fresh window started
 * failing for reasons that had nothing to do with the code under test.
 *
 * `--user-data-dir` is Electron's own switch, so nothing in the app needs a testing
 * seam to support this.
 */
export function newProfile(label = 'run') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ember-profile-${label}-`))
  return {
    dir,
    arg: `--user-data-dir=${dir}`,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // A leftover temp directory is not worth failing a run over.
      }
    }
  }
}
