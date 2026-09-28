import { type ChildProcess as NodeChildProcess, spawn as spawnProcess } from 'node:child_process'
import { Readable } from 'node:stream'

import type * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import { which } from './detect.js'
import { acpSpawnCommand } from './runtime.js'

/**
 * `CommandRunner` — the `Command` step of the sequenced platform adoption
 * (HttpClient → FileSystem → Command, `docs/architecture.md`).
 *
 * Why this shape and not a `@effect/platform` Command: the pinned
 * `effect@4.0.0-rc.115` ships the `ChildProcess`/`FileSystem` SERVICES and
 * their `make` constructors but NO platform implementation for either (those
 * live in `@effect/platform-node`, and every `@effect/platform*` release is
 * Effect-v3-only — peer `effect ^3.22.2` — so none can be added here). The
 * sequence is therefore followed in spirit and re-specified on the in-package
 * modules: `FileSystem` stays BLOCKED pending a decision about hand-writing a
 * Node fs transport the same way this slice hand-writes the child-process one,
 * and `Command` lands on `effect/unstable/process`, which the packaged app
 * already ships (asar-safe: no new externals, no new dependency).
 *
 * What rc.115 DOES ship in-package is `effect/unstable/process`: the
 * `ChildProcess` command model (executable, args, env, cwd, stdio, kill
 * options) and the `ChildProcessSpawner` service boundary that starts a
 * `Command` and hands back a handle. This port is built on exactly those two
 * modules — `ChildProcess.make` describes the run, `ChildProcessSpawner.spawn`
 * starts it — so the port is a thin, honest projection of the upstream API.
 *
 * `FileSystem` remains BLOCKED and is NOT faked here: `which()` still walks
 * PATH through `node:fs` as domain code. This slice is the ONE tracer call
 * site (the Claude auth probe) so the port shape is proven on a real caller
 * before the harness runtime and the ledger-mcp sidecar move over.
 *
 * Contract (mirrors the proven `HttpFetch` shape in
 * `src/main/pipeline/fetch-utils.ts`):
 * - `run` returns stdout plus the exit code as a SUCCESS. A non-zero exit is
 *   NOT a failure — callers that must inspect the code read `exitCode`, and
 *   callers that only read stdout (the Claude auth probe) are unaffected by a
 *   CLI that reports a logged-out state through a non-zero exit.
 * - every failure lands in the typed error channel as `CommandError`; the
 *   layer NEVER throws and NEVER rejects out of an Effect.
 * - the deadline rides the Effect Clock (`Effect.timeoutOption`), so
 *   `TestClock` governs it in tests and no raw `setTimeout` is involved.
 */

/** Spawn knobs the call sites actually use. Mirrors the `ChildProcess`
 *  `CommandOptions` fields the harness seams rely on, minus `shell`: the
 *  Windows `.cmd` shim is DOMAIN code (`acpSpawnCommand`) that routes the
 *  command through `cmd.exe /c` explicitly, so the port never needs a shell
 *  and cannot accidentally re-introduce one. */
export interface CommandRunOptions {
  /** Working directory for the child; inherited when omitted. */
  readonly cwd?: string | undefined
  /** Child environment. REPLACES the inherited environment (the upstream
   *  `CommandOptions.env` gotcha) unless `extendEnv` is set. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Merge `env` over `process.env` instead of replacing it. */
  readonly extendEnv?: boolean | undefined
  /** Windows only: never flash a console window. Defaults to `true`, the
   *  behavior the `execFile` call site hard-coded. */
  readonly windowsHide?: boolean | undefined
  /** Clock-bounded deadline for the whole run (spawn + stdout + exit). No
   *  deadline when omitted. */
  readonly timeoutMs?: number | undefined
}

/** What one completed run produced. `stdout` is the raw text (never trimmed —
 *  parsing stays the caller's job); `exitCode` is a plain number so callers
 *  never touch the upstream branded `ExitCode`. */
export interface CommandResult {
  readonly stdout: string
  readonly exitCode: number
}

/** Typed command failure — never a thrown error. `spawn` is every host-level
 *  failure of the transport (ENOENT, EACCES, an aborted stdout pipe) with the
 *  host detail in `message`; `timeout` is the Effect Clock deadline elapsing,
 *  by which point the child has already been killed. */
export class CommandError extends Schema.TaggedError<CommandError>()('CommandError', {
  reason: Schema.Literals(['spawn', 'timeout']),
  message: Schema.String,
  command: Schema.String,
}) {}

/** The port surface: a plain function type so `layerWithRunner` can install any
 *  fake and the interface stays readable at the call site. */
export type CommandRun = (
  command: string,
  args: readonly string[],
  options?: CommandRunOptions | undefined,
) => Effect.Effect<CommandResult, CommandError>

// ---------------------------------------------------------------------------
// Live transport: `node:child_process` behind the in-package spawner service
// ---------------------------------------------------------------------------

/**
 * `rc.115` ships the `ChildProcessSpawner` SERVICE and its `make` constructor
 * but no platform implementation — that lives in `@effect/platform-node`, which
 * is Effect-v3-only and cannot be added here (no new dependency). So the live
 * layer supplies the transport through the package's own constructor: the
 * upstream `spawn` contract, with `ChildProcess.make` describing each run.
 *
 * Handle surface actually implemented: `pid`, `exitCode`, `isRunning`, `kill`,
 * `stdout`. The rest (`stdin`, `stderr`, `all`, the additional-fd accessors,
 * `unref`) are documented stubs: the tracer call site captures stdout of a
 * short-lived, non-interactive child, and the harness runtime keeps its own
 * spawn path until the slice that needs the write/interleave surface.
 */
function nodeSpawn(
  command: ChildProcess.Command,
): Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> {
  return Effect.gen(function* () {
    if (!ChildProcess.isStandardCommand(command)) {
      return yield* Effect.fail(
        PlatformError.badArgument({
          module: 'CommandRunner',
          method: 'spawn',
          description: 'piped commands are not supported by this transport',
        }),
      )
    }
    // `acquireRelease` is what makes the deadline work: the kill is a SCOPE
    // finalizer, so interrupting the run (Clock deadline, or the caller
    // interrupting the fiber) closes the scope and terminates the child
    // instead of leaking it.
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () => spawnProcess(command.command, [...command.args], toSpawnOptions(command.options)),
        catch: cause => spawnFailure(command.command, cause),
      }),
      spawned => Effect.sync(() => killQuietly(spawned, command.options)),
    )
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>()
    yield* Effect.sync(() => observeExit(child, exit, command.command))
    // Built ONCE: `stdoutStream` acquires a queue and forks a pump, so a second
    // evaluation would be a second reader on the same pipe.
    const stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError> =
      child.stdout === null
        ? Stream.fail(
            PlatformError.systemError({
              _tag: 'UnexpectedEof',
              module: 'CommandRunner',
              method: 'spawn',
              pathOrDescriptor: command.command,
              description: 'child stdout was not piped',
            }),
          )
        : yield* stdoutStream(child.stdout, command.command)
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(child.pid ?? -1),
      exitCode: Deferred.await(exit),
      isRunning: Effect.sync(() => child.exitCode === null && child.signalCode === null),
      kill: options => Effect.sync(() => killQuietly(child, options)),
      stdin: Sink.drain,
      stdout,
      // stderr is not piped by `toSpawnOptions`, so there is nothing to merge
      // into `all` — and merging is not implemented here, so `all` ALIASES the
      // one stdout queue. Two consumers of `all` and `stdout` split the chunks
      // between them rather than each seeing the full output, and
      // `ChildProcessSpawner.make`'s `string(cmd, { includeStderr: true })`
      // routes here — so a later slice MUST replace both with a real merged
      // stream before any caller reads stderr. The tracer call site reads
      // stdout only.
      stderr: Stream.empty,
      all: stdout,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    })
  })
}

/** Sentinel for a clean end-of-stream in the chunk pump. */
const END_OF_STREAM: unique symbol = Symbol('watchtower/CommandRunner/endOfStream')

/** One chunk of the child's stdout, or the end sentinel, as an interruptible
 *  Effect. `Effect.callback` is what makes the deadline safe: the register
 *  returns immediately, so the fiber is suspended in Effect (not parked on a
 *  raw JS promise) and an interruption runs the returned cleanup.
 *
 *  `Stream.fromAsyncIterable` — the obvious conversion for a Node `Readable` —
 *  is deliberately NOT used: its `Effect.tryPromise(() => iterator.next())`
 *  cannot be interrupted, so an interrupted stream never completes and the
 *  Clock deadline would hang instead of killing the child. */
function nextChunk(
  readable: Readable,
  command: string,
): Effect.Effect<Uint8Array | typeof END_OF_STREAM, PlatformError.PlatformError> {
  return Effect.callback(resume => {
    const cleanup = (): void => {
      readable.off('data', onData)
      readable.off('end', onEnd)
      readable.off('error', onError)
    }
    function onData(chunk: Buffer): void {
      cleanup()
      resume(Effect.succeed(new Uint8Array(chunk)))
    }
    function onEnd(): void {
      cleanup()
      resume(Effect.succeed(END_OF_STREAM))
    }
    function onError(cause: unknown): void {
      cleanup()
      resume(Effect.fail(streamFailure(command, cause)))
    }
    readable.on('data', onData)
    readable.once('end', onEnd)
    readable.once('error', onError)
    return Effect.sync(cleanup)
  })
}

/** The child's stdout as a `Stream`, pumped by a scope-owned fiber into an
 *  unbounded queue. Queue hand-off (not a raw promise) is what keeps the
 *  consumer interruptible, so a deadline or a caller interruption tears the
 *  whole capture down deterministically.
 *
 *  The queue is unbounded on purpose: it buffers the whole stdout of a
 *  short-lived CLI, which is exactly what the previous `execFile` capture did
 *  — minus its 1MB `maxBuffer` failure arm, which could only ever degrade a
 *  probe to `'unknown'`. Nothing reads stderr, so it is never piped. */
function stdoutStream(
  readable: Readable,
  command: string,
): Effect.Effect<Stream.Stream<Uint8Array, PlatformError.PlatformError>, never, Scope.Scope> {
  return Effect.gen(function* () {
    // `Queue.end` closes the queue with a `Done` cause, so the queue's error
    // channel carries it; `Stream.fromQueue` strips it back out.
    const queue = yield* Queue.make<Uint8Array, PlatformError.PlatformError | Cause.Done<void>>()
    const pump = Effect.gen(function* () {
      for (;;) {
        const chunk = yield* nextChunk(readable, command)
        if (chunk === END_OF_STREAM) break
        yield* Queue.offer(queue, chunk)
      }
      yield* Queue.end(queue)
    }).pipe(Effect.catch(error => Queue.fail(queue, error)))
    yield* Effect.forkChild(pump)
    return Stream.fromQueue(queue)
  })
}

function toSpawnOptions(options: ChildProcess.CommandOptions): Parameters<typeof spawnProcess>[2] {
  const env =
    options.env === undefined
      ? undefined
      : options.extendEnv === true
        ? { ...process.env, ...options.env }
        : options.env
  return {
    cwd: options.cwd,
    env,
    windowsHide: options.windowsHide,
    killSignal: options.killSignal,
  }
}

function spawnFailure(command: string, cause: unknown): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: 'Unknown',
    module: 'CommandRunner',
    method: 'spawn',
    pathOrDescriptor: command,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })
}

function streamFailure(command: string, cause: unknown): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: 'UnexpectedEof',
    module: 'CommandRunner',
    method: 'stdout',
    pathOrDescriptor: command,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })
}

/** Completes `exit` exactly once, from whichever comes first. `doneUnsafe` is
 *  the documented low-level completion: the listeners run outside a fiber, and
 *  the completion effect is already evaluated, so there is no `run*` here.
 *  A signal death reports `code: null`; the port's contract is a number, so it
 *  surfaces as `1` ("did not exit cleanly") with the signal detail in the
 *  message-free code field the callers already ignore. */
function observeExit(
  child: NodeChildProcess,
  exit: Deferred.Deferred<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
  command: string,
): void {
  child.once('error', (cause: Error) => {
    Deferred.doneUnsafe(exit, Effect.fail(spawnFailure(command, cause)))
  })
  child.once('close', (code: number | null) => {
    Deferred.doneUnsafe(exit, Effect.succeed(ChildProcessSpawner.ExitCode(code ?? 1)))
  })
}

/** Teardown must never throw: a child that already exited, or a platform that
 *  rejects the signal, still has to let the scope close. `forceKillAfter` is
 *  deliberately not honored — SIGKILL escalation and the process-TREE kill are
 *  the harness runtime's existing job (`src/main/agents/process-tree.ts`), a
 *  later slice. */
function killQuietly(child: NodeChildProcess, options: ChildProcess.KillOptions | undefined): void {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill(options?.killSignal ?? 'SIGTERM')
  } catch {
    /* teardown must not fail the run */
  }
}

/** The live `ChildProcessSpawner`: the upstream `make` constructor over the
 *  Node transport. Exported so `CommandRunner.layer` can `provide` it, and so a
 *  later slice can hoist the ONE spawner into `MainLive` when a second call
 *  site needs it. Note it is captured by value when `CommandRunner.layer` is
 *  built — `Effect.provideService` from the outside does NOT reach it. */
export const liveSpawner: ChildProcessSpawner.ChildProcessSpawner['Service'] = ChildProcessSpawner.make(nodeSpawn)

/** The layer `CommandRunner.layer` is built from. Exported for the same reason
 *  as `liveSpawner`. */
export const liveSpawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, liveSpawner)

// ---------------------------------------------------------------------------
// Port implementation
// ---------------------------------------------------------------------------

/**
 * The live `run`.
 *
 * DOMAIN CODE STAYS DOMAIN CODE (§5.3): the PATH lookup (`which`) and the
 * Windows `.cmd` shim (`acpSpawnCommand`) are called HERE, in the same order
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
    const spawn = acpSpawnCommand(bin, args, process.platform)
    const attempt = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(spawn.command, spawn.args, {
            cwd: options.cwd,
            env: options.env,
            extendEnv: options.extendEnv,
            windowsHide: options.windowsHide ?? true,
            // Capture-only stdio, pinned deliberately: an unread `stderr` pipe
            // would wedge a chatty child once the OS buffer fills, and nothing
            // on this path reads stderr (the legacy `execFile` callback
            // discarded it too). `stdin: 'ignore'` gives the child an immediate
            // EOF instead of the never-closed pipe `execFile` handed it.
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'ignore',
          }),
        )
        const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout))
        const exitCode = yield* handle.exitCode
        return { stdout, exitCode: Number(exitCode) }
      }),
    ).pipe(
      Effect.mapError(
        (error: PlatformError.PlatformError) =>
          new CommandError({ reason: 'spawn', message: error.message, command: spawn.command }),
      ),
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

// ---------------------------------------------------------------------------
// Service + layers
// ---------------------------------------------------------------------------

/**
 * Effect-native `Command` boundary (ADR 0032): the third step of the
 * sequenced platform adoption, landing on the in-package
 * `effect/unstable/process` modules. One service, one method, one typed
 * failure, test fakes through `layerWithRunner` — the same fake-ability as
 * `HttpFetch.layerWithFetch` and `HarnessProbe.layerWithProbe`.
 *
 * `CommandRunner.layer` is the LIVE capability; it needs no services from
 * outside its own `liveSpawnerLayer`, so composing it costs nothing until a
 * second call site exists.
 */
export class CommandRunner extends Context.Service<CommandRunner, { readonly run: CommandRun }>()(
  'watchtower/agents/CommandRunner',
) {
  static readonly layer: Layer.Layer<CommandRunner> = Layer.effect(
    CommandRunner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, spawner => CommandRunner.of({ run: makeCommandRun(spawner) })),
  ).pipe(Layer.provide(liveSpawnerLayer))

  /** Test seam: any `CommandRun` stands in for the live child process, so no
   *  test needs a harness CLI installed (the `HttpFetch.layerWithFetch` /
   *  `HarnessProbe.layerWithProbe` pattern). */
  static readonly layerWithRunner = (runImpl: CommandRun): Layer.Layer<CommandRunner> =>
    Layer.succeed(CommandRunner, CommandRunner.of({ run: runImpl }))
}

/** What one `run` call was asked to do — the assertion surface for tests that
 *  need to prove the live layer received the shim/PATH inputs unchanged. */
export interface RecordedCommandRun {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CommandRunOptions
}

/** Recording fake runner: replays `respond` for every call and remembers each
 *  one. `respond` receives the same inputs the live layer would have spawned,
 *  so a test can assert the command name, the argv, and the `timeoutMs` the
 *  caller passed — the port-level equivalent of asserting `execFile` was called
 *  with the expected arguments. */
export function makeRecordingCommandRunner(respond: CommandRun): {
  readonly layer: Layer.Layer<CommandRunner>
  readonly calls: Array<RecordedCommandRun>
} {
  const calls: Array<RecordedCommandRun> = []
  const layer = CommandRunner.layerWithRunner((command, args, options = {}) => {
    calls.push({ command, args, options })
    return respond(command, args, options)
  })
  return { layer, calls }
}
