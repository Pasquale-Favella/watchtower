import type * as Cause from 'effect/Cause'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'
import * as ChildProcess from 'effect/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import * as Queue from 'effect/Queue'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import {
  CommandError,
  type CommandHandle,
  type CommandResult,
  type CommandRun,
  CommandRunner,
  type CommandRunOptions,
  type CommandSpawnOptions,
  type CommandStart,
  type CommandStartOptions,
} from '../../core/ports/process.js'
import { platformSpawnCommand, which } from './executable.js'

/**
 * `CommandRunner` — the `Command` step of the sequenced platform adoption
 * (HttpClient → FileSystem → Command, `docs/architecture.md`).
 *
 * This capability uses Effect's `effect/process` modules and the official
 * `@effect/platform-node` spawner. PATH discovery and Windows `.cmd` routing
 * remain application policy in `which()` and `platformSpawnCommand`.
 *
 * Synchronous provider discovery and the PATH walk in `which()` still happen
 * before an Effect context exists, so they remain plain Node operations.
 *
 * BOUNDARY RULE, so the exception stays an exception rather than a default that
 * spreads: SYNC DISCOVERY stays plain functions on `node:fs`; effectful,
 * streamed, retryable or scope-owned file work goes through a port. This port is
 * the existing example of the other half of that rule.
 *
 * TWO surfaces over ONE transport, because a call site either wants the answer
 * or wants the process:
 * - `run` — one short-lived command, captured to completion: stdout plus the
 *   exit code. The Claude auth probe's shape.
 * - `start` — a SUPERVISED child: the handle is returned to the caller and its
 *   lifetime is the caller's `Scope`, with readable stdout AND stderr. The
 *   ledger-mcp sidecar's shape (and later the harness runtime's).
 * The second surface exists because the first cannot express a long-lived
 * process: `run` owns the scope itself, so the child dies with the call, and
 * its `CommandResult` has nowhere to put a stream.
 *
 * Contract:
 * - `run` returns stdout plus the exit code as a SUCCESS. A non-zero exit is
 *   NOT a failure — callers that must inspect the code read `exitCode`, and
 *   callers that only read stdout (the Claude auth probe) are unaffected by a
 *   CLI that reports a logged-out state through a non-zero exit.
 * - operational failures land in the typed `CommandError` channel. A signal
 *   exit maps to numeric code 1 to retain the existing port contract.
 * - the deadline rides the Effect Clock (`Effect.timeoutOption`), so
 *   `TestClock` governs it in tests and no raw `setTimeout` is involved. Only
 *   `run` has a deadline: a supervised child's lifetime IS its scope, so a
 *   second, hidden lifetime on `start` would be a second thing to get wrong.
 *
 * The official spawner owns process-group teardown. On POSIX it waits for the
 * group; on Windows it uses `taskkill` while the leader is running and waits
 * for the leader only. Each declared output stream is pumped once into an
 * unbounded queue so independent port readers cannot steal bytes from each
 * other and an unread piped stream cannot block the child.
 */

/** The spawn knobs BOTH surfaces read. Mirrors the `ChildProcess`
 *  `CommandOptions` fields the harness seams rely on, minus `shell`: the
 *  Windows `.cmd` shim is DOMAIN code (`platformSpawnCommand`) that routes the
 *  command through `cmd.exe /c` explicitly, so the port never needs a shell
 *  and cannot accidentally re-introduce one. */
function captureOutputs(
  handle: ChildProcessSpawner.ChildProcessHandle,
  command: string,
): Effect.Effect<CommandOutputStreams, never, Scope.Scope> {
  return Effect.gen(function* () {
    const stdout = yield* Queue.make<Uint8Array, CommandError | Cause.Done<void>>()
    const stderr = yield* Queue.make<Uint8Array, CommandError | Cause.Done<void>>()
    const all = yield* Queue.make<Uint8Array, CommandError | Cause.Done<void>>()
    let remaining = 2

    const pump = (
      source: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
      destination: OutputQueue,
      label: 'stdout' | 'stderr',
    ) =>
      Stream.runForEach(source, chunk =>
        Effect.gen(function* () {
          yield* Queue.offer(destination, chunk).pipe(Effect.catch(() => Effect.succeed(false)))
          yield* Queue.offer(all, chunk).pipe(Effect.catch(() => Effect.succeed(false)))
        }),
      ).pipe(
        Effect.matchEffect({
          onFailure: error => {
            const failure = streamFailure(command, label, error)
            return Effect.gen(function* () {
              yield* Queue.fail(destination, failure)
              yield* Queue.fail(all, failure)
            })
          },
          onSuccess: () =>
            Effect.gen(function* () {
              yield* Queue.end(destination)
              remaining -= 1
              if (remaining === 0) yield* Queue.end(all)
            }),
        }),
      )

    yield* Effect.forkScoped(pump(handle.stdout, stdout, 'stdout'))
    yield* Effect.forkScoped(pump(handle.stderr, stderr, 'stderr'))

    return {
      stdout: Stream.fromQueue(stdout),
      stderr: Stream.fromQueue(stderr),
      all: Stream.fromQueue(all),
    }
  })
}

function streamFailure(command: string, label: 'stdout' | 'stderr', cause: PlatformError.PlatformError): CommandError {
  return new CommandError({
    reason: 'stream',
    message: `${label}: ${cause.message}`,
    command,
  })
}

function spawnFailure(command: string, cause: PlatformError.PlatformError): CommandError {
  return new CommandError({ reason: 'spawn', message: cause.message, command })
}

function exitCodeOrFailure(handle: ChildProcessSpawner.ChildProcessHandle): Effect.Effect<number, never> {
  // The official handle reports signal exits as PlatformError because Node
  // supplies code=null. The port has always represented these as code 1.
  return handle.exitCode.pipe(
    Effect.map(Number),
    Effect.catch(() => Effect.succeed(1)),
  )
}
// ---------------------------------------------------------------------------
// Port implementation
// ---------------------------------------------------------------------------

/**
 * The `CommandOptions` BOTH surfaces declare: the shared knobs translated
 * one-for-one, plus the capture-only stdio they run under.
 *
 * The stdio is the load-bearing half and it is pinned deliberately:
 * - `stdin: 'ignore'` gives the child an immediate EOF instead of a pipe nobody
 *   writes to, which is a child blocked on `read` forever — the never-closed
 *   pipe the legacy `execFile` handed it. Named removal: the write surface (the
 *   harness ACP slice) replaces this line and the transport's `Sink.drain`
 *   together.
 * - `stdout: 'pipe'` is the capture both surfaces read.
 * - `stderr` defaults to the DISCARDED fd, because an unread stderr pipe wedges
 *   a chatty child once the OS buffer fills (the legacy `execFile` callback
 *   discarded it too). `pipeStderr` is the opt-in that pays for a pipe: `run`
 *   drains it and throws it away, `start` exposes it as `handle.stderr` / `all`.
 */
function commandOptions(options: CommandSpawnOptions): ChildProcess.CommandOptions {
  return {
    cwd: options.cwd,
    env: options.env,
    extendEnv: options.extendEnv,
    windowsHide: options.windowsHide ?? true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: options.pipeStderr === true ? 'pipe' : 'ignore',
    // Bound both timeout interruption and scope finalization when a child
    // ignores SIGTERM. The upstream default may await the leader forever.
    forceKillAfter: Duration.seconds(1),
  }
}

/**
 * The live `run`.
 *
 * DOMAIN CODE STAYS DOMAIN CODE (§5.3): the PATH lookup (`which`) and the
 * Windows `.cmd` shim (`platformSpawnCommand`) are called HERE, in the same order
 * as the legacy `execFile` path, rather than hidden behind the abstraction.
 * Nothing about the shim changed — it is still the shared helper the harness
 * spawns use, so a change to it moves the probe and the runtime together.
 */
function makeCommandRun(spawner: ChildProcessSpawner.ChildProcessSpawner['Service']): CommandRun {
  // `Effect.fn` calls the body with `body.apply(this, arguments)`, so the
  // `options = {}` default below covers a missing OR an `undefined` third
  // argument — the returned function IS the `CommandRun` port, no re-wrapper
  // (and no second place that could default options differently).
  return Effect.fn('CommandRunner.run')(function* (
    command: string,
    args: readonly string[],
    options: CommandRunOptions = {},
  ): Effect.fn.Return<CommandResult, CommandError> {
    const bin = which(command) ?? command
    const spawn = platformSpawnCommand(bin, args, process.platform)
    const attempt = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(ChildProcess.make(spawn.command, spawn.args, commandOptions(options)))
          .pipe(Effect.mapError(error => spawnFailure(spawn.command, error)))
        const outputs = yield* captureOutputs(handle, spawn.command)
        // `run` only returns stdout. Keep consuming the other independent
        // streams so their fanout queues do not retain the child's output.
        yield* Effect.forkScoped(Stream.runDrain(outputs.stderr).pipe(Effect.catch(() => Effect.void)))
        yield* Effect.forkScoped(Stream.runDrain(outputs.all).pipe(Effect.catch(() => Effect.void)))
        const stdout = yield* Stream.mkString(Stream.decodeText(outputs.stdout))
        const exitCode = yield* exitCodeOrFailure(handle)
        return { stdout, exitCode }
      }),
    )
    if (options.timeoutMs === undefined) return yield* attempt
    // `timeoutOption` is `raceFirst`: when the deadline wins it INTERRUPTS the
    // run, and `raceFirst` awaits the interrupted loser before resolving, so
    // the scope above has already closed and the child is already dead by the
    // time the `CommandError{timeout}` is raised.
    const outcome = yield* attempt.pipe(Effect.timeoutOption(Duration.millis(options.timeoutMs)))
    if (Option.isNone(outcome)) {
      return yield* new CommandError({
        reason: 'timeout',
        message: `${spawn.command} timed out after ${options.timeoutMs}ms`,
        command: spawn.command,
      })
    }
    return outcome.value
  })
}

/**
 * The live `start`: a supervised child whose lifetime is the CALLER's scope.
 *
 * DOMAIN CODE STAYS DOMAIN CODE (§5.3), the same two calls as `run` and in the
 * same order — the PATH lookup (`which`) then the Windows `.cmd` shim
 * (`platformSpawnCommand`). They are repeated here rather than folded into a shared
 * helper on purpose: a supervised spawn of `node` on win32 must go through the
 * shim exactly as a probe of `claude` does, and the reader of this function
 * should be able to see that without following an indirection.
 *
 * The returned handle's `Scope` requirement is the whole point: `spawn` needs a
 * scope to register its kill finalizer on, so a handle cannot outlive the scope
 * that produced it, and there is no `kill()` the caller can forget.
 */
function makeCommandStart(spawner: ChildProcessSpawner.ChildProcessSpawner['Service']): CommandStart {
  return Effect.fn('CommandRunner.start')(function* (
    command: string,
    args: readonly string[],
    options: CommandStartOptions = {},
  ): Effect.fn.Return<CommandHandle, CommandError, Scope.Scope> {
    const bin = which(command) ?? command
    const spawn = platformSpawnCommand(bin, args, process.platform)
    const handle = yield* spawner
      .spawn(ChildProcess.make(spawn.command, spawn.args, commandOptions(options)))
      .pipe(Effect.mapError(error => spawnFailure(spawn.command, error)))
    const outputs = yield* captureOutputs(handle, spawn.command)
    const kill = Effect.flatMap(handle.isRunning, running =>
      running ? handle.kill({ forceKillAfter: Duration.seconds(1) }) : Effect.void,
    ).pipe(
      // Closing the supervisor's scope must remain quiet if the leader exited
      // between the state check and the process-group signal.
      Effect.catch(() => Effect.void),
    )
    return {
      pid: Number(handle.pid),
      exitCode: exitCodeOrFailure(handle),
      isRunning: handle.isRunning.pipe(Effect.catch(() => Effect.succeed(false))),
      stdout: outputs.stdout,
      stderr: outputs.stderr,
      all: outputs.all,
      kill,
    }
  })
}

// ---------------------------------------------------------------------------
// Service + layers
// ---------------------------------------------------------------------------

/** The `start` a run-only fake installs. It fails through the port's own typed
 *  channel rather than throwing or returning a lie, so a test that reaches for
 *  the supervised surface through a fake that never declared one fails with a
 *  readable message instead of `undefined is not a function`.
 *
 *  Named removal: with the last `layerWithRunner(run)` call site. It exists so
 *  the fake seam stayed a one-argument seam when the second operation landed,
 *  rather than breaking every existing fake. */

export const CommandRunnerLive = Layer.effect(
  CommandRunner,
  Effect.map(ChildProcessSpawner.ChildProcessSpawner, spawner =>
    CommandRunner.of({ run: makeCommandRun(spawner), start: makeCommandStart(spawner) }),
  ),
)

type OutputQueue = Queue.Queue<Uint8Array, CommandError | Cause.Done<void>>

interface CommandOutputStreams {
  readonly stdout: Stream.Stream<Uint8Array, CommandError>
  readonly stderr: Stream.Stream<Uint8Array, CommandError>
  readonly all: Stream.Stream<Uint8Array, CommandError>
}

/**
 * Reads each official handle stream once and fans chunks out to independent
 * queues. That lets callers read stdout, stderr, and all without competing
 * readers while the scoped pumps keep each opened OS pipe draining.
 */
