import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import type * as Stream from 'effect/Stream'

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
 * The live implementation requires the root to choose its `ChildProcessSpawner`;
 * this keeps production composition and test substitution on the same path.
 */
export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    readonly run: CommandRun
    readonly start: CommandStart
  }
>()('watchtower/agents/CommandRunner') {
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
