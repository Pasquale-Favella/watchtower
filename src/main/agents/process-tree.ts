import { execFile, execFileSync } from 'node:child_process'

import * as Effect from 'effect/Effect'

/** win32 `taskkill` as a never-fails Effect (the teardown exemplar): the
 *  callback `execFile` is wrapped in `Effect.tryPromise` and `ignore`d, so
 *  already-exited processes, missing taskkill, and callback errors all
 *  resolve — never reject. `run*` stays at this spawn-function boundary;
 *  callers keep the `Promise<void>` seam.
 *  Removal: raw `new Promise(resolve => ...)` callback juggling removed when
 *  the win32 kill rides this Effect. */
const taskkillTreeEffect = Effect.fnUntraced(function* (pid: number, run: typeof execFile): Effect.fn.Return<void> {
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>(resolve => {
        try {
          run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
        } catch {
          resolve()
        }
      }),
    catch: error => error,
  }).pipe(Effect.ignore)
})

/** Best-effort termination for a harness process and its descendants. */
export function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: typeof execFile = execFile,
): Promise<void> {
  if (platform === 'win32') {
    return Effect.runPromise(taskkillTreeEffect(pid, run) as Effect.Effect<void>)
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // The process may already have exited.
  }
  return Promise.resolve()
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
