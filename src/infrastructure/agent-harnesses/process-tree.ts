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

/** Tree kill that returns only once the tree is gone — for callers that kill the
 *  root right after (a dead root orphans its descendants). Stays sync on
 *  purpose: the caller kills the root immediately after, so an async tree kill
 *  would race the root kill and orphan descendants. No Effect here — `run*`
 *  would defer the kill past the root kill. On POSIX the root leads its own
 *  process group (spawned detached), so the group id is the tree. */
export function killProcessTreeSync(
  pid: number,
  run: typeof execFileSync = execFileSync,
  platform: NodeJS.Platform = process.platform,
  kill: (target: number, signal: NodeJS.Signals) => void = process.kill,
): void {
  if (platform !== 'win32') {
    try {
      kill(-pid, 'SIGKILL')
      return
    } catch {
      // No group led by this pid (already exited, or not detached): signal the root alone.
    }
    try {
      kill(pid, 'SIGKILL')
    } catch {
      // Already exited — nothing left to kill.
    }
    return
  }
  try {
    run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 })
  } catch {
    // Already exited, or taskkill unavailable — the root kill still follows.
  }
}

export interface ProcessGroupSignals {
  readonly kill: (target: number, signal: NodeJS.Signals) => void
  /** Whether any member of the group (`-pgid`) is still alive. */
  readonly isAlive: (target: number) => boolean
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

const defaultProcessGroupSignals: ProcessGroupSignals = {
  kill: (target, signal) => {
    process.kill(target, signal)
  },
  isAlive: target => {
    try {
      process.kill(target, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  },
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/** POSIX: SIGTERM the whole process group, wait up to `graceMs` for it to empty, then SIGKILL it. */
export async function terminateProcessGroup(
  pid: number,
  graceMs: number,
  signals: ProcessGroupSignals = defaultProcessGroupSignals,
): Promise<ProcessTreeTermination> {
  const group = -pid
  try {
    signals.kill(group, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { status: 'confirmed' }
    return { status: 'unconfirmed', reason: 'failed' }
  }
  const graceDeadline = signals.now() + graceMs
  while (signals.isAlive(group)) {
    if (signals.now() >= graceDeadline) break
    await signals.sleep(10)
  }
  if (!signals.isAlive(group)) return { status: 'confirmed' }
  try {
    signals.kill(group, 'SIGKILL')
  } catch {
    return { status: 'unconfirmed', reason: 'failed' }
  }
  const killDeadline = signals.now() + PROBE_TEARDOWN_TIMEOUT_MS
  while (signals.isAlive(group)) {
    if (signals.now() >= killDeadline) return { status: 'unconfirmed', reason: 'deadline' }
    await signals.sleep(10)
  }
  return { status: 'confirmed' }
}
