import type * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'
import * as ChildProcess from 'effect/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import { which } from './detect.js'
import { acpSpawnCommand } from './runtime.js'

/**
 * `CommandRunner` — the `Command` step of the sequenced platform adoption
 * (HttpClient → FileSystem → Command, `docs/architecture.md`).
 *
 * This capability uses Effect's `effect/process` modules and the official
 * `@effect/platform-node` spawner. PATH discovery and Windows `.cmd` routing
 * remain application policy in `which()` and `acpSpawnCommand`.
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
 *  Windows `.cmd` shim is DOMAIN code (`acpSpawnCommand`) that routes the
 *  command through `cmd.exe /c` explicitly, so the port never needs a shell
 *  and cannot accidentally re-introduce one. */
export interface CommandSpawnOptions {
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
  /** Pipe the child's stderr so the transport owns and drains the pipe,
   *  instead of handing the child a discarded fd. Defaults to `false`
   *  (`'ignore'`), which is what every existing `run` caller gets.
   *
   *  This knob only decides the CHILD'S FILE DESCRIPTOR: `run` drains stderr
   *  and throws it away, while `start` exposes it as `handle.stderr` /
   *  `handle.all`. Named removal: it deletes with the last `run` call site
   *  (the auth probe), after which only `CommandStartOptions` exists. */
  readonly pipeStderr?: boolean | undefined
}

/** What one `run` call may ask for: the shared spawn knobs plus the
 *  Clock deadline that bounds the whole call. */
export interface CommandRunOptions extends CommandSpawnOptions {
  /** Clock-bounded deadline for the whole run (spawn + stdout + exit). No
   *  deadline when omitted. */
  readonly timeoutMs?: number | undefined
}

/** What one `start` call may ask for. Deliberately NOT a `CommandRunOptions`:
 *  the shared spawn knobs and nothing else, so a supervised child can never be
 *  handed a run deadline that would kill it behind the supervisor's back. */
export type CommandStartOptions = CommandSpawnOptions

/** What one completed run produced. `stdout` is the raw text (never trimmed —
 * parsing stays the caller's job); `exitCode` is a plain number so callers
 * never touch the upstream branded `ExitCode`. */
export interface CommandResult {
  readonly stdout: string
  readonly exitCode: number
}

/** A live child, owned by the caller's `Scope`.
 *
 *  Each piped fd gets its OWN pump and its OWN queue, and `all` is a third
 *  queue both pumps offer every chunk to — so `all` is a genuine merge of
 *  `stdout` and `stderr`, not three names for one pipe: a caller may read any
 *  of them and still see everything that pipe carried. (The stub this replaces
 *  ALIASED `all` to `stdout`, and two readers of an alias split the chunks
 *  between them.) When the call did NOT ask for `pipeStderr` there is no stderr
 *  pipe to merge with, so `all` IS `stdout` — for a true reason this time.
 *  Each stream is built ONCE per handle: a second reader of the same name
 *  splits that pipe's chunks, which is a property of a Node pipe, not of this
 *  port. */
export interface CommandHandle {
  /** OS process id, or `-1` when the platform reported none. */
  readonly pid: number
  /** Completes when the child exits. A signal death reports a non-zero code
   *  (the same "did not exit cleanly" convention `run` uses) rather than an
   *  error; the failure channel is a child that errored before it ran. */
  readonly exitCode: Effect.Effect<number, CommandError>
  /** Whether the child is running right now. Infallible: it reads the Node
   *  handle's own state. */
  readonly isRunning: Effect.Effect<boolean>
  /** stdout, chunk by chunk, for as long as the caller keeps reading. */
  readonly stdout: Stream.Stream<Uint8Array, CommandError>
  /** stderr; `Stream.empty` unless the call asked for `pipeStderr`. */
  readonly stderr: Stream.Stream<Uint8Array, CommandError>
  /** stdout and stderr interleaved. When no stderr pipe exists, this contains
   *  the same chunks as `stdout`. */
  readonly all: Stream.Stream<Uint8Array, CommandError>
  /** Terminate the child now (SIGTERM). Infallible: killing a child that has
   *  already exited is a no-op, because teardown must never fail the caller. */
  readonly kill: Effect.Effect<void>
}

/** Typed command failure — never a thrown error. `spawn` is every host-level
 *  failure of the transport (ENOENT, EACCES, a child that errored before it
 *  ran); `timeout` is the Effect Clock deadline elapsing, by which point the
 *  child has already been killed; `stream` is a piped output failing mid-read
 *  (an aborted pipe). `stream` is the only reason the supervised surface
 *  needed: `run` drains its only stream to completion and could only ever
 *  report the other two. */
export class CommandError extends Schema.TaggedError<CommandError>()('CommandError', {
  reason: Schema.Literals(['spawn', 'timeout', 'stream']),
  message: Schema.String,
  command: Schema.String,
}) {}

/** The port surface: plain function types so `layerWithRunner` can install any
 *  fake and the interface stays readable at the call site. `run` owns its own
 *  scope; `start` borrows the caller's, which is the whole difference. */
export type CommandRun = (
  command: string,
  args: readonly string[],
  options?: CommandRunOptions | undefined,
) => Effect.Effect<CommandResult, CommandError>

export type CommandStart = (
  command: string,
  args: readonly string[],
  options?: CommandStartOptions | undefined,
) => Effect.Effect<CommandHandle, CommandError, Scope.Scope>

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
 * (`acpSpawnCommand`). They are repeated here rather than folded into a shared
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
    const spawn = acpSpawnCommand(bin, args, process.platform)
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
const uninstalledStart: CommandStart = command =>
  Effect.fail(
    new CommandError({
      reason: 'spawn',
      message: 'CommandRunner.layerWithRunner was installed without a start implementation',
      command,
    }),
  )

/**
 * Effect-native `Command` boundary (ADR 0032): one service, two operations, one typed
 * failure, test fakes through `layerWithRunner` — the same fake-ability as
 * `HttpFetch.layerWithFetch` and `HarnessProbe.layerWithProbe`.
 *
 * `CommandRunner.layer` requires the root to choose its `ChildProcessSpawner`;
 * this keeps production composition and test substitution on the same path.
 */
export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    readonly run: CommandRun
    readonly start: CommandStart
  }
>()('watchtower/agents/CommandRunner') {
  static readonly layer: Layer.Layer<CommandRunner, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
    CommandRunner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, spawner =>
      CommandRunner.of({ run: makeCommandRun(spawner), start: makeCommandStart(spawner) }),
    ),
  )

  /** Test seam: any `CommandRun` stands in for the live child process, so no
   *  test needs a harness CLI installed (the `HttpFetch.layerWithFetch` /
   *  `HarnessProbe.layerWithProbe` pattern). A `start` implementation may be
   *  supplied for the tests that exercise the supervised surface; without one
   *  the fake fails typed instead of throwing. */
  static readonly layerWithRunner = (
    runImpl: CommandRun,
    startImpl: CommandStart = uninstalledStart,
  ): Layer.Layer<CommandRunner> => Layer.succeed(CommandRunner, CommandRunner.of({ run: runImpl, start: startImpl }))
}

/** What one `run` call was asked to do — the assertion surface for tests that
 *  need to prove the live layer received the shim/PATH inputs unchanged. */
export interface RecordedCommandRun {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CommandRunOptions
}

/** What one `start` call was asked to do. The same assertion surface for the
 *  supervised surface; `options` is the spawn-only shape, so a `start` can
 *  never be recorded as having taken a run deadline. */
export interface RecordedCommandStart {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CommandStartOptions
}

/** Recording fake runner: replays `respond` for every call and remembers each
 *  one. `respond` receives the same inputs the live layer would have spawned,
 *  so a test can assert the command name, the argv, and the `timeoutMs` the
 *  caller passed — the port-level equivalent of asserting `execFile` was called
 *  with the expected arguments. `respondStart` does the same for the
 *  supervised surface and is recorded separately, so a fake can prove which
 *  operation a call site used. */
export function makeRecordingCommandRunner(
  respond: CommandRun,
  respondStart: CommandStart = uninstalledStart,
): {
  readonly layer: Layer.Layer<CommandRunner>
  readonly calls: Array<RecordedCommandRun>
  readonly starts: Array<RecordedCommandStart>
} {
  const calls: Array<RecordedCommandRun> = []
  const starts: Array<RecordedCommandStart> = []
  const layer = CommandRunner.layerWithRunner(
    (command, args, options = {}) => {
      calls.push({ command, args, options })
      return respond(command, args, options)
    },
    (command, args, options = {}) => {
      starts.push({ command, args, options })
      return respondStart(command, args, options)
    },
  )
  return { layer, calls, starts }
}
