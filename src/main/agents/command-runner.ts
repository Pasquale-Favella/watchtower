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
 * `FileSystem` — platform step 2 — is CLOSED AS "no", by owner decision
 * (issue #148, 2026-09-29). The blocker was always the same and never went away:
 * rc.115 ships the service and its `make` constructor with NO platform
 * implementation, so adoption means hand-writing a Node fs transport by hand —
 * and the inputs are ~20 SYNCHRONOUS discovery reads (`existsSync`,
 * `readFileSync`, `statSync`) on provider paths that must resolve before any
 * Effect context exists, plus the PATH walk in `which()`. A transport for those
 * would buy substitution no test uses and lifecycle no resource needs, which is
 * why `which()` still walks PATH through `node:fs` here.
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
 * Contract (mirrors the proven `HttpFetch` shape in
 * `src/main/pipeline/fetch-utils.ts`):
 * - `run` returns stdout plus the exit code as a SUCCESS. A non-zero exit is
 *   NOT a failure — callers that must inspect the code read `exitCode`, and
 *   callers that only read stdout (the Claude auth probe) are unaffected by a
 *   CLI that reports a logged-out state through a non-zero exit.
 * - every failure lands in the typed error channel as `CommandError`; the
 *   layer NEVER throws and NEVER rejects out of an Effect. The two exceptions
 *   are `CommandHandle.isRunning` / `.kill`, which are typed INFAILIBLE on
 *   purpose: both are transport-local reads of the Node handle's own state (and
 *   a `try/catch` kill), so upstream's `PlatformError` channel is collapsed with
 *   `Effect.orDie` rather than forced on every caller to handle an error that
 *   cannot happen. A defect there is a transport bug, not an operational
 *   outcome.
 * - the deadline rides the Effect Clock (`Effect.timeoutOption`), so
 *   `TestClock` governs it in tests and no raw `setTimeout` is involved. Only
 *   `run` has a deadline: a supervised child's lifetime IS its scope, so a
 *   second, hidden lifetime on `start` would be a second thing to get wrong.
 *
 * ONE DISCLOSED TRANSPORT CHANGE (Wave 10): `run`'s observable contract — what
 * it resolves, what it times out on, its typed error, and every existing test —
 * is unchanged, but its child's FILE DESCRIPTORS are now really what the port
 * always declared (`stdin: 'ignore'`, `stdout: 'pipe'`, `stderr: 'ignore'`).
 * Node's default gave every child three live pipes, so a chatty-stderr child
 * could wedge a run and a child reading stdin never saw EOF; translating the
 * declaration into `spawn`'s `stdio` fixes both. The first `run` call site was
 * `execFile`, which never closed stdin either, so no existing caller relied on
 * the old shape.
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
  /** stdout and stderr interleaved, genuinely merged. Equal to `stdout` only
   *  when there is no stderr pipe to merge with. */
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
 * `stdout`, `stderr`, `all`. Still documented stubs: `stdin` (`Sink.drain`),
 * the additional-fd accessors (`getInputFd`/`getOutputFd`), and `unref` (a
 * no-op) — no call site writes to a child or unrefs one, and the harness
 * runtime keeps its own spawn path until the slice that needs the write
 * surface.
 *
 * DRAIN POLICY (the rule that makes a supervised child safe): the `stdin`,
 * `stdout` and `stderr` a command declares are translated VERBATIM into
 * `node:child_process`'s `stdio`, and a pipe this transport opens is pumped
 * from the moment the child starts — whether or not anybody ever reads the
 * stream. A pipe nobody reads therefore cannot wedge a chatty child, which is
 * the failure the `'ignore'` default exists to avoid in the first place. The
 * price is heap, not a hang: an unread pipe's chunks accumulate in its queue
 * until the child exits or the scope closes, so a caller that pipes a stream
 * it never reads is paying for it. `pipeStderr` defaults to `false`, so the
 * common "I never read stderr" case never opens a stderr pipe at all.
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
    const executable = command.command
    const started = yield* Deferred.make<undefined, PlatformError.PlatformError>()
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>()
    // `acquireRelease` is what makes the deadline work: the kill is a SCOPE
    // finalizer, so interrupting the run (Clock deadline, or the caller
    // interrupting the fiber) closes the scope and terminates the child
    // instead of leaking it. The event listeners are installed in the same
    // synchronous acquisition that creates the child, before interruption can
    // leave an unobserved `error` event behind.
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const spawned = spawnProcess(command.command, [...command.args], toSpawnOptions(command.options))
          observeProcess(spawned, started, exit, executable)
          return spawned
        },
        catch: cause => spawnFailure(command.command, cause),
      }),
      spawned => Effect.sync(() => killQuietly(spawned, command.options)),
    )
    // Node returns a ChildProcess before the OS spawn result is known. Waiting
    // for `spawn` keeps an asynchronous `error` in the start failure channel.
    yield* Deferred.await(started)
    // Built ONCE: the capture below forks a pump per pipe, so a second
    // evaluation would be a second reader on the same pipe.
    const outputs = yield* pipedOutputs(child, command.command)
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(child.pid ?? -1),
      exitCode: Deferred.await(exit),
      isRunning: Effect.sync(() => child.exitCode === null && child.signalCode === null),
      kill: options => Effect.sync(() => killQuietly(child, options)),
      stdin: Sink.drain,
      ...outputs,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    })
  })
}

/** Sentinel for a clean end-of-stream in the chunk pump. */
const END_OF_STREAM: unique symbol = Symbol('watchtower/CommandRunner/endOfStream')

/** The queue behind one reader of one pipe. The `Cause.Done` in its error
 *  channel is the end-of-stream sentinel `Queue.end` writes; `Stream.fromQueue`
 *  strips it back out. */
type CaptureQueue = Queue.Queue<Uint8Array, PlatformError.PlatformError | Cause.Done<void>>

/** One reader's view of a pipe. */
type CaptureStream = Stream.Stream<Uint8Array, PlatformError.PlatformError>

/** The shared merge, when a pipe is one of TWO: the queue `all` reads, and the
 *  countdown that says which pump ends it. Absent for a single-pipe child. */
interface MergeTarget {
  readonly queue: CaptureQueue
  readonly isLast: () => boolean
}

/** The handle's three streams over the child's pipes.
 *
 *  `stdout` gets its own pump and queue. `stderr` gets its own pump and queue
 *  when it is piped, and `all` gets a THIRD queue that both pumps offer every
 *  chunk to — so the merge is real, no reader of one stream can steal another's
 *  chunks, and the interleaving is the order the two pumps dequeued their
 *  chunks (the same best-effort interleave a `PassThrough` merge would give).
 *
 *  With no stderr pipe there is genuinely nothing to merge, so `all` IS the
 *  stdout stream — the same value, now for a true reason instead of a stub's. */
function pipedOutputs(
  child: NodeChildProcess,
  command: string,
): Effect.Effect<
  { readonly stdout: CaptureStream; readonly stderr: CaptureStream; readonly all: CaptureStream },
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    if (child.stdout === null) {
      return {
        stdout: Stream.fail(notPiped(command, 'stdout')),
        stderr: Stream.empty,
        all: Stream.empty,
      }
    }
    if (child.stderr === null) {
      const stdout = yield* capturePipe(child.stdout, command, 'stdout')
      return { stdout, stderr: Stream.empty, all: stdout }
    }
    const merged: CaptureQueue = yield* Queue.make<Uint8Array, PlatformError.PlatformError | Cause.Done<void>>()
    const isLast = lastToClose(2)
    const stdout = yield* capturePipe(child.stdout, command, 'stdout', { queue: merged, isLast })
    const stderr = yield* capturePipe(child.stderr, command, 'stderr', { queue: merged, isLast })
    return { stdout, stderr, all: Stream.fromQueue(merged) }
  })
}

/** Countdown for the merged queue: `all` ends when the LAST pipe ends, so a
 *  child that closes stdout early (the ledger sidecar drains stdout once it
 *  has its READY line) does not truncate the merge. Each pump calls it
 *  exactly once, on its way out. */
function lastToClose(sources: number): () => boolean {
  let open = sources
  return () => {
    open -= 1
    return open === 0
  }
}

/** Pumps ONE piped `Readable` into its own unbounded queue (one reader) and,
 *  when `merge` is given, also offers every chunk to the shared merge queue.
 *
 * The queue hand-off (not a raw promise) is what keeps the consumer
 * interruptible, so a deadline, a scope close, or a caller interruption tears
 * the whole capture down deterministically. It is unbounded on purpose: the
 * pump must never block on a slow or absent consumer, because a blocked pump
 * is a filled OS pipe, which is a wedged child.
 *
 * `Stream.fromAsyncIterable` — the obvious conversion for a Node `Readable` —
 * is deliberately NOT used: its `Effect.tryPromise(() => iterator.next())`
 * cannot be interrupted, so an interrupted stream never completes and the
 * Clock deadline would hang instead of killing the child. */
function capturePipe(
  readable: Readable,
  command: string,
  label: 'stdout' | 'stderr',
  merge?: MergeTarget,
): Effect.Effect<CaptureStream, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.make<Uint8Array, PlatformError.PlatformError | Cause.Done<void>>()
    const pump = Effect.gen(function* () {
      for (;;) {
        const chunk = yield* nextChunk(readable, command, label)
        if (chunk === END_OF_STREAM) break
        yield* Queue.offer(queue, chunk)
        if (merge !== undefined) yield* Queue.offer(merge.queue, chunk)
      }
      yield* Queue.end(queue)
      if (merge !== undefined && merge.isLast()) yield* Queue.end(merge.queue)
    }).pipe(
      // A broken pipe fails every reader it was feeding, the merged one
      // included: half a capture is not a capture.
      Effect.catch((error: PlatformError.PlatformError) =>
        Effect.gen(function* () {
          yield* Queue.fail(queue, error)
          if (merge !== undefined) yield* Queue.fail(merge.queue, error)
        }),
      ),
    )
    yield* Effect.forkChild(pump)
    return Stream.fromQueue(queue)
  })
}

/** One chunk of a child's pipe, or the end sentinel, as an interruptible
 *  Effect. Registering a `data` listener is also what puts the pipe in
 *  flowing mode, so the child is drained from the moment the child starts.
 *  `Effect.callback` is what makes the deadline safe: the register returns
 *  immediately, so the fiber is suspended in Effect (not parked on a raw JS
 *  promise) and an interruption runs the returned cleanup. */
function nextChunk(
  readable: Readable,
  command: string,
  label: 'stdout' | 'stderr',
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
      resume(Effect.fail(streamFailure(command, label, cause)))
    }
    readable.on('data', onData)
    readable.once('end', onEnd)
    readable.once('error', onError)
    return Effect.sync(cleanup)
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
    // The stdio declaration is TRANSLATED, not ignored: this is the only
    // source `node:child_process` has for it, so without these three lines a
    // command that declared `stderr: 'ignore'` still got a live — and
    // unread — stderr pipe, which is the exact wedging the declaration
    // exists to prevent. A non-string config (a `Stream` into stdin, a `Sink`
    // out of stdout) has no channel to be wired through by this transport and
    // falls back to `'pipe'`, the upstream default; the port only ever
    // declares strings.
    stdio: [stdioMode(options.stdin), stdioMode(options.stdout), stdioMode(options.stderr)],
  }
}

/** The `stdio` entry `node:child_process` understands, or the upstream
 *  `'pipe'` default. `'overlapped'` is deliberately not special-cased: it is
 *  Windows-only, and a POSIX child given one would be handed an invalid fd
 *  rather than a loud error. */
function stdioMode(config: unknown): 'pipe' | 'ignore' | 'inherit' {
  const mode: unknown = typeof config === 'object' && config !== null ? (config as { stream?: unknown }).stream : config
  return mode === 'ignore' || mode === 'inherit' ? mode : 'pipe'
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

function streamFailure(command: string, label: 'stdout' | 'stderr', cause: unknown): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: 'UnexpectedEof',
    module: 'CommandRunner',
    method: label,
    pathOrDescriptor: command,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })
}

function notPiped(command: string, label: 'stdout' | 'stderr'): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: 'UnexpectedEof',
    module: 'CommandRunner',
    method: 'spawn',
    pathOrDescriptor: command,
    description: `child ${label} was not piped`,
  })
}

/** Completes `exit` exactly once, from whichever comes first. `doneUnsafe` is
 *  the documented low-level completion: the listeners run outside a fiber, and
 *  the completion effect is already evaluated, so there is no `run*` here.
 *  A signal death reports `code: null`; the port's contract is a number, so it
 *  surfaces as `1` ("did not exit cleanly") with the signal detail in the
 *  message-free code field the callers already ignore. */
function observeProcess(
  child: NodeChildProcess,
  started: Deferred.Deferred<undefined, PlatformError.PlatformError>,
  exit: Deferred.Deferred<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
  command: string,
): void {
  const cleanup = (): void => {
    child.off('spawn', onSpawn)
    child.off('error', onError)
    child.off('close', onClose)
  }
  function onSpawn(): void {
    Deferred.doneUnsafe(started, Effect.succeed(undefined))
    child.off('spawn', onSpawn)
  }
  function onError(cause: Error): void {
    const failure = spawnFailure(command, cause)
    Deferred.doneUnsafe(started, Effect.fail(failure))
    Deferred.doneUnsafe(exit, Effect.fail(failure))
  }
  function onClose(code: number | null): void {
    Deferred.doneUnsafe(exit, Effect.succeed(ChildProcessSpawner.ExitCode(code ?? 1)))
    cleanup()
  }
  child.once('spawn', onSpawn)
  child.on('error', onError)
  child.once('close', onClose)
}

/** Teardown must never throw: a child that already exited, or a platform that
 *  rejects the signal, still has to let the scope close. `forceKillAfter` is
 *  deliberately not honored — SIGKILL escalation and the process-TREE kill are
 *  the harness runtime's existing job (`src/main/agents/process-tree.ts`), a
 *  later slice. */
function killQuietly(child: NodeChildProcess, options: ChildProcess.KillOptions | undefined): void {
  try {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill(options?.killSignal ?? 'SIGTERM')
    }
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
        const handle = yield* spawner.spawn(ChildProcess.make(spawn.command, spawn.args, commandOptions(options)))
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
    // Both transport failures are `spawn`: the spawn itself, and a child that
    // errored before it ran (the `exit` deferred the transport resolves with
    // the same `PlatformError`). The piped streams fail as `stream` instead.
    const asSpawnError = (error: PlatformError.PlatformError) =>
      new CommandError({ reason: 'spawn', message: error.message, command: spawn.command })
    const asStreamError = (error: PlatformError.PlatformError) =>
      new CommandError({ reason: 'stream', message: error.message, command: spawn.command })
    const handle = yield* spawner
      .spawn(ChildProcess.make(spawn.command, spawn.args, commandOptions(options)))
      .pipe(Effect.mapError(asSpawnError))
    return {
      pid: Number(handle.pid),
      exitCode: handle.exitCode.pipe(Effect.map(Number), Effect.mapError(asSpawnError)),
      // `orDie` on the two members that CANNOT fail in this transport (a
      // synchronous read of Node's own child state, and a kill wrapped in
      // `try/catch`): a defect here is a transport bug, not an operational
      // outcome, and a typed `CommandError` a caller must handle for an
      // operation that always succeeds is noise. Their types say so.
      isRunning: Effect.orDie(handle.isRunning),
      stdout: handle.stdout.pipe(Stream.mapError(asStreamError)),
      stderr: handle.stderr.pipe(Stream.mapError(asStreamError)),
      all: handle.all.pipe(Stream.mapError(asStreamError)),
      kill: Effect.orDie(handle.kill()),
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
const uninstalledStart: CommandStart = (command, _args, _options) =>
  Effect.fail(
    new CommandError({
      reason: 'spawn',
      message: 'CommandRunner.layerWithRunner was installed without a start implementation',
      command,
    }),
  )

/**
 * Effect-native `Command` boundary (ADR 0032): the third step of the
 * sequenced platform adoption, landing on the in-package
 * `effect/unstable/process` modules. One service, two operations, one typed
 * failure, test fakes through `layerWithRunner` — the same fake-ability as
 * `HttpFetch.layerWithFetch` and `HarnessProbe.layerWithProbe`.
 *
 * `CommandRunner.layer` is the LIVE capability; it needs no services from
 * outside its own `liveSpawnerLayer`, so composing it costs nothing until a
 * second call site exists.
 */
export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    readonly run: CommandRun
    readonly start: CommandStart
  }
>()('watchtower/agents/CommandRunner') {
  static readonly layer: Layer.Layer<CommandRunner> = Layer.effect(
    CommandRunner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, spawner =>
      CommandRunner.of({ run: makeCommandRun(spawner), start: makeCommandStart(spawner) }),
    ),
  ).pipe(Layer.provide(liveSpawnerLayer))

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
