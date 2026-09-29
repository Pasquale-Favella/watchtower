/**
 * `CommandRunner.start` — the supervised-child surface of the §5.3 `Command`
 * port (issue #148, Wave 10), in a sibling file to
 * `tests/command-runner.test.ts` so that file stays the untouched proof that
 * `run` did not move.
 *
 * Everything here that needs a process uses the LIVE layer with the test
 * runner's own `process.execPath` (`node -e <source>`) — no harness CLI, no
 * sidecar entry — so the transport, the stream pumps, the merged `all`, the
 * scope-bound lifetime and the DOMAIN CODE shim walk (`which` + the win32
 * `cmd.exe /c` shim) are all exercised for real. The fake seam covers only
 * what a fake can honestly prove: which operation a call site used.
 *
 * Every termination case asserts an OS FACT — the child the port started is
 * gone afterwards — rather than that the port stopped waiting for it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import {
  CommandError,
  type CommandHandle,
  CommandRunner,
  type CommandStartOptions,
  makeRecordingCommandRunner,
} from '../src/main/agents/command-runner.js'

/** One `start` through `CommandRunner.layer` — a real child process, no
 *  installed CLI required. Left UNRUN so a case can `Effect.scoped`/
 *  `Effect.flip`/fork it. */
function liveStart(command: string, args: readonly string[], options?: CommandStartOptions) {
  return Effect.gen(function* () {
    const runner = yield* CommandRunner
    return yield* runner.start(command, args, options)
  }).pipe(Effect.provide(CommandRunner.layer))
}

/** One `start` through a recording fake, SCOPE ALREADY CLOSED — the supervised
 *  surface borrows the caller's scope, so a one-shot case has to close it
 *  itself; the error channel survives so a case can `Effect.flip`. */
function startThrough(
  layer: Layer.Layer<CommandRunner>,
  command: string,
  args: readonly string[] = [],
  options?: CommandStartOptions,
): Effect.Effect<CommandHandle, CommandError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const runner = yield* CommandRunner
      return yield* runner.start(command, args, options)
    }).pipe(Effect.provide(layer)),
  )
}

/** `node -e <source> [arg]` — a real child process that needs no installed CLI. */
const node = (source: string, ...args: string[]): readonly string[] => ['-e', source, ...args]

/** A child that publishes its pid to `argv[1]` and then stays up until the
 *  file `argv[2]` exists, at which point it exits 0. The gate is what makes
 *  "is it running?", "what is its pid?" and "did the scope kill it?" testable
 *  without a sleep: the child only ends when the test says so. The wait polls
 *  with `Atomics.wait`, so a gated child costs no CPU. */
const GATED =
  'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], String(process.pid)); while (!fs.existsSync(process.argv[2])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)'

/** A temp dir for one test's files, cleaned up by the caller. */
function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'watchtower-command-start-'))
  return { path, cleanup: () => rmSync(path, { force: true, recursive: true }) }
}

/** The same temp dir, pre-named for the two files `GATED` reads: the child
 *  publishes its pid to `pidFile` and exits once `gateFile` exists. */
function gatedDir(): { pidFile: string; gateFile: string; cleanup: () => void } {
  const { path, cleanup } = tempDir()
  return { pidFile: join(path, 'pid'), gateFile: join(path, 'gate'), cleanup }
}

/** Reads the pid a child published, waiting for it to appear. The budget is
 *  deliberately generous: the assertions are about an OS FACT (the child
 *  process is gone), not about a race, so a loaded machine must not decide the
 *  outcome — only a child that truly never started can fail here. */
async function readChildPid(pidFile: string, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    }
    if (Date.now() > deadline) throw new Error(`child never published its pid to ${pidFile}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** True while the pid is still alive. `process.kill(pid, 0)` is the zero-signal
 *  liveness probe and reports ESRCH for a dead pid (verified on Windows and
 *  POSIX). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Polls until the pid is gone, so the assertion is not racing the OS's exit
 *  notification. Returns whether it actually went away. */
async function waitForDeath(pid: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

/** Runs `f` with `process.env[name]` temporarily set, restoring it even when
 *  `f` throws — the parent env is the only way to observe a child's
 *  replace-semantics or the PATH walk. */
async function withParentEnv<T>(name: string, value: string, f: () => Promise<T>): Promise<T> {
  const previous = process.env[name]
  process.env[name] = value
  try {
    return await f()
  } finally {
    // `Reflect.deleteProperty` rather than `delete process.env[name]`: the same
    // unlink, without the `no-dynamic-delete` lint warning the bracket form costs
    // (the two existing env-mutating helpers in this suite both carry it).
    if (previous === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = previous
  }
}

describe('CommandRunner.start over a fake runner (no process is started)', () => {
  /** A handle the fake hands back. Nothing reads its streams, so the emptiest
   *  legal one is the honest one. */
  const stub: CommandHandle = {
    pid: 4321,
    exitCode: Effect.succeed(0),
    isRunning: Effect.succeed(true),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    kill: Effect.void,
  }

  it('resolves the handle and records the call, passing the options through', async () => {
    const { layer, starts, calls } = makeRecordingCommandRunner(
      () => Effect.succeed({ stdout: '', exitCode: 0 }),
      () => Effect.succeed(stub),
    )
    const options = { cwd: '/tmp', env: { FOO: 'bar' }, extendEnv: true, pipeStderr: true }
    const handle = await Effect.runPromise(startThrough(layer, 'node', ['server.js'], options))
    expect(handle).toBe(stub)
    expect(starts).toEqual([{ command: 'node', args: ['server.js'], options }])
    // The supervised surface and the one-shot surface are recorded separately:
    // a call site cannot quietly get one when it asked for the other.
    expect(calls).toEqual([])
  })

  it('defaults the options to an empty object (no undefined envelope)', async () => {
    const { layer, starts } = makeRecordingCommandRunner(
      () => Effect.succeed({ stdout: '', exitCode: 0 }),
      () => Effect.succeed(stub),
    )
    await Effect.runPromise(startThrough(layer, 'node'))
    expect(starts[0]?.options).toEqual({})
  })

  it('a run-only fake fails `start` through the typed channel instead of throwing', async () => {
    // The bridge that kept `layerWithRunner` a one-argument seam: reaching for
    // the supervised surface through a fake that never declared one has to be
    // a readable `CommandError`, not a `TypeError`.
    const { layer } = makeRecordingCommandRunner(() => Effect.succeed({ stdout: '', exitCode: 0 }))
    const error = await Effect.runPromise(startThrough(layer, 'node').pipe(Effect.flip))
    expect(error).toBeInstanceOf(CommandError)
    expect(error._tag).toBe('CommandError')
    expect(error.reason).toBe('spawn')
    expect(error.message).toContain('without a start implementation')
  })

  it('the stream failure reason is expressible on the same tagged error', async () => {
    // `stream` is the one reason the supervised surface added; the other two
    // must keep their literals so every existing construction stays valid.
    const error = new CommandError({ reason: 'stream', message: 'pipe aborted', command: 'node' })
    expect(error.reason).toBe('stream')
    expect(new CommandError({ reason: 'spawn', message: 'm', command: 'c' }).reason).toBe('spawn')
    expect(new CommandError({ reason: 'timeout', message: 'm', command: 'c' }).reason).toBe('timeout')
  })
})

describe('CommandRunner.start live layer (real child, scope-bound lifetime)', () => {
  it('hands back a live handle whose pid is the child the transport started', async () => {
    const { pidFile, gateFile, cleanup } = gatedDir()
    try {
      const observed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* liveStart(process.execPath, node(GATED, pidFile, gateFile))
            const runningWhileGated = yield* handle.isRunning
            writeFileSync(gateFile, '') // the child may now exit
            const exitCode = yield* handle.exitCode
            return { pid: handle.pid, runningWhileGated, runningAfterExit: yield* handle.isRunning, exitCode }
          }),
        ),
      )
      expect(observed.pid).toBe(await readChildPid(pidFile))
      expect(observed.runningWhileGated).toBe(true)
      expect(observed.exitCode).toBe(0)
      expect(observed.runningAfterExit).toBe(false)
    } finally {
      cleanup()
    }
  })

  it("`all` is a genuine merge: reading it never steals another stream's chunks", async () => {
    // The stub this replaces ALIASED `all` to `stdout`, so two readers of the
    // two names split one pipe's chunks between them. Here all three readers
    // run at once over a child that writes to both pipes, and each must see
    // everything its own pipe carried.
    const child = node(
      'process.stdout.write("out-1\\n"); process.stderr.write("err-1\\n"); process.stdout.write("out-2\\n"); process.stderr.write("err-2\\n")',
    )
    const { stdout, stderr, all } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* liveStart(process.execPath, child, { pipeStderr: true })
          const [all, stdout, stderr] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.all)),
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
            ],
            { concurrency: 'unbounded' },
          )
          return { all, stdout, stderr }
        }),
      ),
    )
    expect(stdout).toBe('out-1\nout-2\n')
    expect(stderr).toBe('err-1\nerr-2\n')
    // The merge carries BOTH pipes' chunks, none lost and none doubled. Its
    // ORDER is not asserted: two independent pumps race, which is the same
    // best-effort interleave a `PassThrough` merge gives.
    expect(
      all
        .split('\n')
        .filter(line => line !== '')
        .sort(),
    ).toEqual(['err-1', 'err-2', 'out-1', 'out-2'])
    expect(all).toHaveLength(stdout.length + stderr.length)
  })

  it('without a stderr pipe there is nothing to merge, so `all` carries stdout', async () => {
    const child = node('process.stdout.write("only-stdout"); process.stderr.write("dropped")')
    const { all, stderr } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* liveStart(process.execPath, child)
          // `stdout` is deliberately NOT read here: with no stderr pipe `all`
          // and `stdout` are one pipe, so a second concurrent reader would
          // split it. Reading `all` alone is what proves the merge carries
          // stdout — the merged case above is what proves independence.
          const [all, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.all)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 'unbounded' },
          )
          return { all, stderr }
        }),
      ),
    )
    // The child's stderr is a discarded fd by default, so it never even
    // reaches the transport — and the merge is honest rather than a stub.
    expect(all).toBe('only-stdout')
    expect(stderr).toBe('')
  })

  it('closing the scope kills the child (the pid is gone afterwards)', async () => {
    const { pidFile, gateFile, cleanup } = gatedDir()
    try {
      const pid = await Effect.runPromise(
        Effect.gen(function* () {
          const release = yield* Deferred.make<undefined>()
          const fiber = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                yield* liveStart(process.execPath, node(GATED, pidFile, gateFile))
                yield* Deferred.await(release)
              }),
            ),
          )
          // Wait for the child to be REALLY up before closing anything: a
          // child killed before it started would prove nothing.
          const startedPid = yield* Effect.promise(() => readChildPid(pidFile))
          Deferred.doneUnsafe(release, Effect.void)
          yield* Fiber.join(fiber).pipe(Effect.exit)
          return startedPid
        }),
      )
      expect(await waitForDeath(pid)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('an abandoned fiber leaves no child behind', async () => {
    const { pidFile, gateFile, cleanup } = gatedDir()
    try {
      const { pid, exit } = await Effect.runPromise(
        Effect.gen(function* () {
          // The scope lives INSIDE the fiber, so interrupting the fiber is
          // what closes it — the shape the harness/ledger supervisors use.
          const fiber = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                yield* liveStart(process.execPath, node(GATED, pidFile, gateFile))
                yield* Effect.never
              }),
            ),
          )
          const startedPid = yield* Effect.promise(() => readChildPid(pidFile))
          yield* Fiber.interrupt(fiber)
          return { pid: startedPid, exit: yield* Fiber.join(fiber).pipe(Effect.exit) }
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(false)
      expect(await waitForDeath(pid)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('`kill` resolves even when the child is already gone (teardown never throws)', async () => {
    const { pidFile, gateFile, cleanup } = gatedDir()
    try {
      const { exitCode, pid } = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* liveStart(process.execPath, node(GATED, pidFile, gateFile))
            const startedPid = yield* Effect.promise(() => readChildPid(pidFile))
            yield* handle.kill
            yield* handle.kill // a second kill of a dead child is still a success
            return { pid: startedPid, exitCode: yield* handle.exitCode }
          }),
        ),
      )
      // A signal death is reported as a non-zero code, never as a failure.
      expect(exitCode).not.toBe(0)
      expect(await waitForDeath(pid)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('applies the PATH walk and the win32 shim, exactly as `run` does (§5.3)', async () => {
    // DOMAIN CODE proof for the new surface: a name that exists ONLY on PATH.
    // Skip the walk and POSIX gets ENOENT, while win32's `cmd.exe /c` shim
    // resolves the bare name and reports a non-zero exit — so a clean exit 0
    // is only reachable when both `which` and `acpSpawnCommand` ran.
    const { path, cleanup } = tempDir()
    const name = 'wt-command-runner-start-probe'
    const win32 = process.platform === 'win32'
    writeFileSync(join(path, win32 ? `${name}.cmd` : name), win32 ? '@exit /b 0\n' : '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    })
    try {
      const exitCode = await withParentEnv('PATH', `${path}${delimiter}${process.env.PATH ?? ''}`, () =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* liveStart(name, [])
              return yield* handle.exitCode
            }),
          ),
        ),
      )
      expect(exitCode).toBe(0)
    } finally {
      cleanup()
    }
  })

  it('replaces the inherited environment unless extendEnv is set (the secret scrub)', async () => {
    // The ledger sidecar spawns with a hand-built allowlist and relies on
    // REPLACE semantics for its scrub, so this is a load-bearing property of
    // the transport, not an upstream detail to be rediscovered. `PATH` is
    // deliberately NOT asserted: Windows' `spawn` re-injects the parent's
    // `PATH` into the child whatever `env` says (verified), which is exactly
    // why the sidecar's allowlist names it explicitly.
    const child = node(
      'process.stdout.write(JSON.stringify({ child: process.env.WT_CHILD ?? null, parent: process.env.WT_PARENT_SECRET ?? null }))',
    )
    const stdout = await withParentEnv('WT_PARENT_SECRET', 'leaked', () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* liveStart(process.execPath, child, { env: { WT_CHILD: 'kept' } })
            return yield* Stream.mkString(Stream.decodeText(handle.stdout))
          }),
        ),
      ),
    )
    expect(JSON.parse(stdout)).toEqual({ child: 'kept', parent: null })
  })

  it('surfaces a missing executable as CommandError reason spawn (POSIX ENOENT)', async () => {
    if (process.platform === 'win32') return
    const error = await Effect.runPromise(Effect.scoped(liveStart('watchtower-no-such-cli-9f3a', []).pipe(Effect.flip)))
    expect(error).toBeInstanceOf(CommandError)
    expect(error.reason).toBe('spawn')
  })
})

describe('the stdio declaration reaches the OS (shared transport)', () => {
  // These two guard `toSpawnOptions`: the port DECLARES `stdin: 'ignore'` and
  // (by default) `stderr: 'ignore'`, and the declaration is the only thing
  // `node:child_process` has. Before the stdio was translated, a `run` child
  // got THREE live pipes regardless — an unread stderr pipe that wedges a
  // chatty child, and a stdin pipe that never EOFs so a child reading stdin
  // hangs forever. Both would hang rather than fail, so each carries a
  // deadline that turns a regression into a typed `timeout` instead.
  it('a chatty stderr child cannot wedge a run', async () => {
    // `fs.writeSync` and not `process.stderr.write`: Node's own stderr writes
    // are queued in libuv and silently dropped at exit, so only a SYNCHRONOUS
    // write actually blocks a child on a full pipe — which is the wedge this
    // pins down. 4MB is past any platform's pipe buffer; verified that an
    // unread stderr pipe wedges this child.
    const child = node(
      'const fs = require("node:fs"); const chunk = "x".repeat(1024); for (let i = 0; i < 4096; i += 1) fs.writeSync(2, chunk); process.stdout.write("done")',
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* CommandRunner
        return yield* runner.run(process.execPath, child, { timeoutMs: 20_000 })
      }).pipe(Effect.provide(CommandRunner.layer)),
    )
    expect(result).toEqual({ stdout: 'done', exitCode: 0 })
  })

  it('a child that reads stdin to EOF is not held open by an unwritten pipe', async () => {
    const child = node('process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"))')
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* CommandRunner
        return yield* runner.run(process.execPath, child, { timeoutMs: 20_000 })
      }).pipe(Effect.provide(CommandRunner.layer)),
    )
    expect(result).toEqual({ stdout: 'eof', exitCode: 0 })
  })

  // The DRAIN POLICY claim in `command-runner.ts`: a pipe the transport OPENS is
  // pumped whether or not anybody reads it, so an unread stream cannot wedge the
  // child. `start` has no deadline (its lifetime IS its scope), so the guard is
  // the test timeout: a regression wedges the child and vitest fails the case on
  // time instead of the suite hanging.
  it('a PIPED stderr nobody reads still cannot wedge the child (the drain policy)', { timeout: 30_000 }, async () => {
    const child = node(
      'const fs = require("node:fs"); const chunk = "x".repeat(1024); for (let i = 0; i < 4096; i += 1) fs.writeSync(2, chunk); process.stdout.write("done")',
    )
    const { stdout, exitCode } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* liveStart(process.execPath, child, { pipeStderr: true })
          // Only stdout is read. The 4MB of stderr stays in its queue forever,
          // which is the documented price of the policy; the child still runs to
          // completion and still exits 0.
          return {
            stdout: yield* Stream.mkString(Stream.decodeText(handle.stdout)),
            exitCode: yield* handle.exitCode,
          }
        }),
      ),
    )
    expect(stdout).toBe('done')
    expect(exitCode).toBe(0)
  })
})
