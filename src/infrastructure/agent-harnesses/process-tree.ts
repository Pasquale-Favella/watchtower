import { execFile, execFileSync } from 'node:child_process'

export const PROBE_TEARDOWN_TIMEOUT_MS = 2_000

export type ProcessTreeTermination =
  { readonly status: 'confirmed' } | { readonly status: 'unconfirmed'; readonly reason: 'deadline' | 'failed' }

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Probe leaders must be spawned detached on POSIX to own their process group. */
export async function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: typeof execFile = execFile,
  timeoutMs = PROBE_TEARDOWN_TIMEOUT_MS,
): Promise<ProcessTreeTermination> {
  const deadline = performance.now() + timeoutMs
  const target = platform === 'win32' ? pid : -pid
  if (platform === 'win32') {
    const result = await new Promise<ProcessTreeTermination>(resolve => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        resolve({ status: 'unconfirmed', reason: 'deadline' })
        controller.abort()
      }, timeoutMs)
      try {
        run(
          'taskkill',
          ['/pid', String(pid), '/T', '/F'],
          {
            windowsHide: true,
            timeout: timeoutMs,
            signal: controller.signal,
          },
          error => {
            clearTimeout(timer)
            resolve(error ? { status: 'unconfirmed', reason: 'failed' } : { status: 'confirmed' })
          },
        )
      } catch {
        clearTimeout(timer)
        resolve({ status: 'unconfirmed', reason: 'failed' })
      }
    })
    // A vanished leader alone cannot confirm that Windows killed its descendants.
    if (result.status === 'unconfirmed') return result
  } else {
    try {
      process.kill(target, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return { status: 'unconfirmed', reason: 'failed' }
    }
  }
  while (processExists(target)) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return { status: 'unconfirmed', reason: 'deadline' }
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(10, remaining)))
  }
  return { status: 'confirmed' }
}

/** win32 tree kill that returns only once the tree is gone — for callers that
 *  kill the root right after (a dead root orphans its descendants). Stays
 *  sync on purpose: the caller kills the root immediately after, so an async
 *  tree kill would race the root kill and orphan descendants. No Effect here
 *  — `run*` would defer the kill past the root kill. */
export function killProcessTreeSync(pid: number, run: typeof execFileSync = execFileSync): void {
  try {
    run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 })
  } catch {
    // Already exited, or taskkill unavailable — the root kill still follows.
  }
}
