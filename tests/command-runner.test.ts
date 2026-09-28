/**
 * `CommandRunner` — the §5.3 `Command` step of the sequenced platform
 * adoption (issue #148, Wave 9).
 *
 * Two layers of coverage, deliberately:
 *
 * 1. The PORT, through `CommandRunner.layerWithRunner` (the
 *    `HttpFetch.layerWithFetch` / `HarnessProbe.layerWithProbe` fake-ability):
 *    options pass-through, the "a non-zero exit is not a failure" contract, and
 *    the typed `CommandError`. No process is ever started.
 * 2. The LIVE layer, over `effect/unstable/process`'s in-package
 *    `ChildProcess`/`ChildProcessSpawner`. The child is the test runner's own
 *    `process.execPath` — no harness CLI is required or spawned (there is no
 *    `claude` binary on the box) — so the transport, the stdout capture, the
 *    exit code, the spawn-failure mapping and, most importantly, the DEADLINE
 *    are exercised for real. Both termination tests prove the child is killed
 *    (its pid is gone afterwards) rather than merely abandoned.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import type * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import { runClaudeAuthProbe } from '../src/main/agents/auth-probe.js'
import {
  CommandError,
  type CommandResult,
  CommandRunner,
  type CommandRunOptions,
  makeRecordingCommandRunner,
} from '../src/main/agents/command-runner.js'

/** One `run` through whichever `CommandRunner` layer the case is exercising —
 *  the recording fake or `CommandRunner.layer` — returned UNRUN so a case can
 *  `Effect.flip`/`fork`/supply a TestClock on it. */
function runThrough(
  layer: Layer.Layer<CommandRunner>,
  command: string,
  args: readonly string[],
  options?: CommandRunOptions,
): Effect.Effect<CommandResult, CommandError> {
  return Effect.gen(function* () {
    const runner = yield* CommandRunner
    return yield* runner.run(command, args, options)
  }).pipe(Effect.provide(layer))
}

/** The LIVE layer: a real child process, no installed CLI required. */
function liveRun(command: string, args: readonly string[], options?: CommandRunOptions) {
  return runThrough(CommandRunner.layer, command, args, options)
}

function liveRunError(command: string, args: readonly string[], options?: CommandRunOptions) {
  return Effect.runPromise(liveRun(command, args, options).pipe(Effect.flip))
}

/** `node -e <source> [arg]` — a real child process that needs no installed CLI. */
const node = (source: string, ...args: string[]): readonly string[] => ['-e', source, ...args]

/** A child that writes its own pid to `pidFile` and then outlives the test by
 *  an hour. The pid file is how a test observes the child the transport
 *  actually started — the port deliberately does not return a pid. */
const HANGING_PIDFILE =
  'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 3_600_000)'

/** A child that outlives the test by an hour and reports nothing. */
const HANGING = node('setTimeout(() => {}, 3_600_000)')

/** A temp dir for one test's pid files, cleaned up by the caller. */
function pidFileDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'watchtower-command-runner-'))
  return { path, cleanup: () => rmSync(path, { force: true, recursive: true }) }
}

/** Reads the pid a child published, waiting for it to appear. The budget is
 *  deliberately generous: the assertions below are about an OS FACT (the child
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
 *  liveness probe and reports ESRCH for a dead pid on every platform the app
 *  packages for (verified on Windows and POSIX). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Polls until the pid is gone, so the assertion is not racing the OS's exit
 *  notification. Returns whether it actually went away. Same load tolerance as
 *  `readChildPid`: the OS may take a moment to reap a killed process. */
async function waitForDeath(pid: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

describe('CommandRunner port (fake runner — no process is started)', () => {
  it('resolves stdout and the exit code, passing the spawn options through', async () => {
    const { layer, calls } = makeRecordingCommandRunner(() =>
      Effect.succeed({ stdout: '{"loggedIn":true}', exitCode: 0 } satisfies CommandResult),
    )
    const options = { cwd: '/tmp', env: { FOO: 'bar' }, extendEnv: true, windowsHide: false, timeoutMs: 1234 }
    const result = await Effect.runPromise(runThrough(layer, 'claude', ['auth', 'status', '--json'], options))
    expect(result).toEqual({ stdout: '{"loggedIn":true}', exitCode: 0 })
    expect(calls).toEqual([{ command: 'claude', args: ['auth', 'status', '--json'], options }])
  })

  it('defaults the options to an empty object (no undefined envelope)', async () => {
    const { layer, calls } = makeRecordingCommandRunner(() => Effect.succeed({ stdout: '', exitCode: 0 }))
    await Effect.runPromise(runThrough(layer, 'claude', []))
    expect(calls[0]?.options).toEqual({})
  })

  it('a non-zero exit is a SUCCESS with the code attached, never a failure', async () => {
    const { layer } = makeRecordingCommandRunner(() =>
      Effect.succeed({ stdout: '{"loggedIn":false}', exitCode: 1 } satisfies CommandResult),
    )
    const result = await Effect.runPromise(
      runThrough(layer, 'claude', ['auth', 'status', '--json'], { timeoutMs: 5000 }),
    )
    expect(result).toEqual({ stdout: '{"loggedIn":false}', exitCode: 1 })
  })

  it('surfaces a failure as the typed CommandError, never a throw', async () => {
    const { layer } = makeRecordingCommandRunner(() =>
      Effect.fail(new CommandError({ reason: 'spawn', message: 'spawn ENOENT', command: 'claude' })),
    )
    const error = await Effect.runPromise(runThrough(layer, 'claude', []).pipe(Effect.flip))
    expect(error).toBeInstanceOf(CommandError)
    expect(error._tag).toBe('CommandError')
    expect(error.reason).toBe('spawn')
    expect(error.message).toBe('spawn ENOENT')
  })
})

describe('CommandRunner live layer (in-package effect/unstable/process, real child)', () => {
  it('captures stdout and the exit code of a successful run', async () => {
    const result = await Effect.runPromise(
      liveRun(process.execPath, node('process.stdout.write(JSON.stringify({ loggedIn: true }))')),
    )
    expect(result).toEqual({ stdout: '{"loggedIn":true}', exitCode: 0 })
  })

  it('resolves a non-zero exit with the code AND the stdout it still printed', async () => {
    const result = await Effect.runPromise(
      liveRun(process.execPath, node('process.stdout.write(JSON.stringify({ loggedIn: false })); process.exit(1)')),
    )
    expect(result).toEqual({ stdout: '{"loggedIn":false}', exitCode: 1 })
  })

  // The `.cmd` shim is DOMAIN CODE, and it changes what a missing binary
  // looks like per platform: on win32 the command is routed through
  // `cmd.exe /c`, which EXISTS and reports a non-zero exit, while POSIX
  // surfaces a real ENOENT spawn error. Both shapes predate this slice (the
  // legacy `execFile` path used the same shim) and both degrade a probe to
  // `'unknown'`, so each arm is pinned where it applies.
  it.skipIf(process.platform === 'win32')(
    'maps a missing executable to CommandError reason spawn (POSIX ENOENT)',
    async () => {
      const error = await liveRunError('watchtower-no-such-cli-9f3a', [])
      expect(error).toBeInstanceOf(CommandError)
      expect(error.reason).toBe('spawn')
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'a missing executable resolves as a cmd.exe non-zero exit under the win32 shim',
    async () => {
      const result = await Effect.runPromise(liveRun('watchtower-no-such-cli-9f3a', []))
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('')
    },
  )

  it('honors cwd, env and extendEnv', async () => {
    const result = await Effect.runPromise(
      liveRun(
        process.execPath,
        node('process.stdout.write([process.cwd(), process.env.WT_PROBE, process.env.PATH].join("|"))'),
        { cwd: process.cwd(), env: { WT_PROBE: 'probe-value' }, extendEnv: true },
      ),
    )
    expect(result.exitCode).toBe(0)
    const [cwd, probe, path] = result.stdout.split('|')
    expect(resolve(cwd ?? '').toLowerCase()).toBe(resolve(process.cwd()).toLowerCase())
    expect(probe).toBe('probe-value')
    // `extendEnv` merged over the parent env instead of replacing it.
    expect(path).not.toBe('undefined')
  })

  it('the liveness probe itself is sound: a running child reads alive, a killed one does not', async () => {
    // Sanity-checks the detector the termination tests below rely on, so a
    // false "the child is dead" cannot pass by accident.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
    const pid = child.pid ?? 0
    try {
      expect(isAlive(pid)).toBe(true)
      child.kill('SIGTERM')
      expect(await waitForDeath(pid)).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('the deadline rides the Effect Clock and fails the run (TestClock)', async () => {
    // A 60s deadline elapses in zero wall time under the TestClock: the timeout
    // is provably the Clock's, not a `setTimeout`. The kill itself is observed
    // on the wall clock in the next two tests, where a child can actually
    // publish its pid first.
    const program = liveRun(process.execPath, HANGING, { timeoutMs: 60_000 })
    const startedAt = Date.now()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(program)
        yield* TestClock.adjust(Duration.seconds(60))
        return yield* Fiber.join(fiber).pipe(Effect.flip)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(error).toBeInstanceOf(CommandError)
    expect(error.reason).toBe('timeout')
    expect(Date.now() - startedAt).toBeLessThan(30_000)
  })

  it('a wall-clock deadline KILLS the child (the pid is gone afterwards)', async () => {
    const { path, cleanup } = pidFileDir()
    const pidFile = join(path, 'pid')
    try {
      // The deadline has to be long enough that the child is really up (and has
      // published its pid) before it fires, otherwise the assertion below would
      // be testing the machine's load instead of the kill.
      const error = await liveRunError(process.execPath, node(HANGING_PIDFILE, pidFile), { timeoutMs: 8_000 })
      expect(error).toBeInstanceOf(CommandError)
      expect(error.reason).toBe('timeout')
      // The child really ran (it published its pid) and the deadline really
      // terminated it — the port did not merely abandon it.
      expect(await waitForDeath(await readChildPid(pidFile))).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('fiber interruption terminates the child too (not just the deadline)', async () => {
    const { path, cleanup } = pidFileDir()
    const pidFile = join(path, 'pid')
    try {
      const program = liveRun(process.execPath, node(HANGING_PIDFILE, pidFile))
      const pid = await Effect.runPromise(
        // Wait for the child to be REALLY up before interrupting it: a fixed
        // sleep would make this test depend on how fast the machine starts a
        // process, and an interrupted-before-start child proves nothing.
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(program)
          const startedPid = yield* Effect.promise(() => readChildPid(pidFile))
          // No deadline at all: the only thing that can end this run is the
          // caller's interruption.
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.join(fiber).pipe(
            Effect.exit,
            Effect.map(exit => ({ exit, pid: startedPid })),
          )
        }),
      )
      // The run never completed on its own terms.
      expect(Exit.isSuccess(pid.exit)).toBe(false)
      expect(await waitForDeath(pid.pid)).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe('Claude auth probe over the port (no harness CLI is spawned)', () => {
  const PROBE = ['auth', 'status', '--json'] as const

  it('asks for the documented argv with the single-source deadline and maps loggedIn', async () => {
    const { layer, calls } = makeRecordingCommandRunner(() =>
      Effect.succeed({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth' }), exitCode: 0 }),
    )
    const status = await Effect.runPromise(runClaudeAuthProbe('claude', PROBE).pipe(Effect.provide(layer)))
    expect(status).toBe('configured')
    expect(calls).toEqual([{ command: 'claude', args: PROBE, options: { timeoutMs: 5000 } }])
  })

  it('collapses a port failure to unknown instead of failing the probe', async () => {
    const { layer } = makeRecordingCommandRunner(() =>
      Effect.fail(new CommandError({ reason: 'spawn', message: 'spawn claude ENOENT', command: 'claude' })),
    )
    await expect(Effect.runPromise(runClaudeAuthProbe('claude', PROBE).pipe(Effect.provide(layer)))).resolves.toBe(
      'unknown',
    )
  })

  it('collapses unparseable stdout to unknown', async () => {
    const { layer } = makeRecordingCommandRunner(() => Effect.succeed({ stdout: 'not json', exitCode: 0 }))
    await expect(Effect.runPromise(runClaudeAuthProbe('claude', PROBE).pipe(Effect.provide(layer)))).resolves.toBe(
      'unknown',
    )
  })

  it('reads a logged-out non-zero exit as unauthenticated, not as a failure', async () => {
    const { layer } = makeRecordingCommandRunner(() =>
      Effect.succeed({ stdout: JSON.stringify({ loggedIn: false }), exitCode: 1 }),
    )
    await expect(Effect.runPromise(runClaudeAuthProbe('claude', PROBE).pipe(Effect.provide(layer)))).resolves.toBe(
      'unauthenticated',
    )
  })

  it('the probe deadline still bounds a runner that ignores timeoutMs (TestClock)', async () => {
    // A runner that never settles: the probe's own Clock deadline is the
    // backstop that keeps harness detection from hanging.
    const { layer } = makeRecordingCommandRunner(() => Effect.never)
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runClaudeAuthProbe('claude', PROBE).pipe(Effect.provide(layer)))
        yield* TestClock.adjust(5000)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(status).toBe('unknown')
  })
})
