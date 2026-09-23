import { execFile, execFileSync } from 'node:child_process'

/** Best-effort termination for a harness process and its descendants. */
export function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: typeof execFile = execFile,
): Promise<void> {
  if (platform === 'win32') {
    return new Promise(resolve => {
      try {
        run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      } catch {
        resolve()
      }
    })
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // The process may already have exited.
  }
  return Promise.resolve()
}

/** win32 tree kill that returns only once the tree is gone — for callers that
 *  kill the root right after (a dead root orphans its descendants). */
export function killProcessTreeSync(pid: number, run: typeof execFileSync = execFileSync): void {
  try {
    run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 })
  } catch {
    // Already exited, or taskkill unavailable — the root kill still follows.
  }
}
