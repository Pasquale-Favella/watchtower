import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'

import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import { TerminalHost, TerminalHostError, type TerminalSpawnRequest } from '@/core/ports/terminal-host.js'
import { killProcessTree } from '@/infrastructure/agent-harnesses/process-tree.js'
import { terminalEnvironment, type TerminalEnvironmentSource } from '@/infrastructure/terminal/environment.js'
import { nodePtySpawner, type PtyProcess, type PtySpawner } from '@/infrastructure/terminal/pty.js'
import { TerminalScrollback } from '@/infrastructure/terminal/scrollback.js'
import { resolveTerminalShell } from '@/infrastructure/terminal/shell.js'
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_LIVE_SESSIONS,
  TERMINAL_MAX_PER_TASK,
  TERMINAL_MAX_ROWS,
  TERMINAL_SCROLLBACK_BYTES,
  TERMINAL_WRITE_MAX_CHARS,
  type TerminalFrame,
  type TerminalId,
  terminalSessionKey,
  type TerminalSnapshot,
  type TerminalStatus,
  type TerminalSummary,
} from '@/shared/schemas/terminal.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

const KILL_GRACE_MS = 1000
const COALESCE_MS = 8
const COALESCE_FLUSH_CHARS = 16 * 1024
const SUBSCRIBER_CAPACITY = 512
const SUBSCRIBER_BYTES = 1024 * 1024
const FRAME_OVERHEAD_BYTES = 64

export interface TerminalHostOptions {
  readonly spawner?: PtySpawner
  readonly platform?: NodeJS.Platform
  readonly environment?: () => TerminalEnvironmentSource
  readonly shellExists?: (file: string) => boolean
  readonly directoryExists?: (directory: string) => Effect.Effect<boolean>
  readonly killTree?: (pid: number) => Effect.Effect<unknown>
  readonly killGraceMs?: number
  readonly coalesceMs?: number
  readonly scrollbackBytes?: number
  readonly maxLiveSessions?: number
  readonly maxPerTask?: number
}

/** Resolved when the current process exits or the session closes. */
type ExitSignal = Deferred.Deferred<undefined>

interface Subscriber {
  readonly queue: Queue.Queue<TerminalFrame, TerminalHostError | Cause.Done>
  bytes: number
}

interface Session {
  readonly taskId: TaskId
  readonly terminalId: TerminalId
  readonly scrollback: TerminalScrollback
  readonly subscribers: Set<Subscriber>
  status: TerminalStatus
  exitCode: number | null
  cols: number
  rows: number
  /** Last event number emitted to subscribers. Every output, exit and restart event advances it. */
  sequence: number
  /** Output received from the pty but not yet emitted; small chunks are merged until the flush. */
  pending: string
  flushTimer: ReturnType<typeof setTimeout> | undefined
  /** Identifies the current process so late events from a replaced process are ignored. */
  generation: number
  pty: PtyProcess | undefined
  exitSignal: ExitSignal
  closed: boolean
}

const failure = (reason: TerminalHostError['reason']) => new TerminalHostError({ reason })

const frameBytes = (frame: TerminalFrame): number =>
  'data' in frame ? Buffer.byteLength(frame.data, 'utf8') + FRAME_OVERHEAD_BYTES : FRAME_OVERHEAD_BYTES

const isDimension = (value: number, max: number): boolean => Number.isInteger(value) && value >= 1 && value <= max

const defaultDirectoryExists = (directory: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    stat(directory).then(
      info => info.isDirectory(),
      () => false,
    ),
  )

const defaultKillTree = (pid: number): Effect.Effect<unknown> => Effect.promise(() => killProcessTree(pid))

/**
 * Process-wide terminal sessions. Mutations run one at a time; output reaches each attached
 * subscriber through a bounded queue, and a subscriber that falls behind is failed, not buffered.
 */
export const makeTerminalHost = (options: TerminalHostOptions = {}) =>
  Effect.gen(function* () {
    const spawner = options.spawner ?? nodePtySpawner
    const platform = options.platform ?? process.platform
    const environment = options.environment ?? (() => process.env)
    const shellExists = options.shellExists ?? existsSync
    const directoryExists = options.directoryExists ?? defaultDirectoryExists
    const killTree = options.killTree ?? defaultKillTree
    const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS
    const coalesceMs = options.coalesceMs ?? COALESCE_MS
    const scrollbackBytes = options.scrollbackBytes ?? TERMINAL_SCROLLBACK_BYTES
    const maxLiveSessions = options.maxLiveSessions ?? TERMINAL_MAX_LIVE_SESSIONS
    const maxPerTask = options.maxPerTask ?? TERMINAL_MAX_PER_TASK

    const sessions = new Map<string, Session>()
    const gate = Semaphore.makeUnsafe(1)

    const countForTask = (taskId: TaskId): number =>
      [...sessions.values()].filter(session => session.taskId === taskId).length
    const countLive = (): number => [...sessions.values()].filter(session => session.status === 'running').length
    const summaryOf = (session: Session): TerminalSummary => ({
      terminalId: session.terminalId,
      status: session.status,
      exitCode: session.exitCode,
      cols: session.cols,
      rows: session.rows,
      sequence: session.sequence,
    })
    const snapshotOf = (session: Session): TerminalSnapshot => ({
      ...summaryOf(session),
      data: session.scrollback.snapshot(),
    })
    const lookup = (taskId: TaskId, terminalId: TerminalId): Effect.Effect<Session, TerminalHostError> => {
      const session = sessions.get(terminalSessionKey(taskId, terminalId))
      return session ? Effect.succeed(session) : Effect.fail(failure('not-found'))
    }
    const requireDimensions = (cols: number, rows: number): Effect.Effect<void, TerminalHostError> =>
      isDimension(cols, TERMINAL_MAX_COLS) && isDimension(rows, TERMINAL_MAX_ROWS)
        ? Effect.void
        : Effect.fail(failure('invalid-request'))
    const requireDirectory = (cwd: string): Effect.Effect<void, TerminalHostError> =>
      Effect.flatMap(directoryExists(cwd), exists => (exists ? Effect.void : Effect.fail(failure('cwd-unavailable'))))

    const publish = (session: Session, frame: TerminalFrame): void => {
      const bytes = frameBytes(frame)
      for (const subscriber of [...session.subscribers]) {
        if (subscriber.bytes + bytes > SUBSCRIBER_BYTES || !Queue.offerUnsafe(subscriber.queue, frame)) {
          session.subscribers.delete(subscriber)
          Queue.failCauseUnsafe(subscriber.queue, Cause.fail(failure('stream-overflow')))
          continue
        }
        subscriber.bytes += bytes
      }
    }
    const cancelFlush = (session: Session): void => {
      if (session.flushTimer === undefined) return
      clearTimeout(session.flushTimer)
      session.flushTimer = undefined
    }
    const flush = (session: Session): void => {
      cancelFlush(session)
      if (session.pending.length === 0) return
      const data = session.pending
      session.pending = ''
      session.sequence += 1
      session.scrollback.append(data)
      publish(session, { _tag: 'output', sequence: session.sequence, data })
    }
    const receive = (session: Session, generation: number, data: string): void => {
      if (session.closed || session.generation !== generation) return
      session.pending += data
      if (coalesceMs <= 0 || session.pending.length >= COALESCE_FLUSH_CHARS) {
        flush(session)
        return
      }
      session.flushTimer ??= setTimeout(() => flush(session), coalesceMs)
    }
    const exited = (session: Session, generation: number, exitCode: number): void => {
      if (session.generation !== generation) return
      if (session.closed) {
        session.pty = undefined
        Deferred.doneUnsafe(session.exitSignal, Effect.succeed(undefined))
        return
      }
      flush(session)
      session.status = 'exited'
      session.exitCode = exitCode
      session.pty = undefined
      session.sequence += 1
      publish(session, { _tag: 'exited', sequence: session.sequence, exitCode })
      Deferred.doneUnsafe(session.exitSignal, Effect.succeed(undefined))
    }

    /** Spawns the shell synchronously, so no pty event can interleave with the state change. */
    const startProcess = (session: Session, cwd: string, cols: number, rows: number, restarted: boolean): void => {
      const env = environment()
      const shell = resolveTerminalShell({ platform, env, exists: shellExists })
      const pty = spawner.spawn(shell.file, shell.args, { cols, rows, cwd, env: terminalEnvironment(env) })
      const generation = session.generation + 1
      session.generation = generation
      session.pty = pty
      session.status = 'running'
      session.exitCode = null
      session.cols = cols
      session.rows = rows
      session.exitSignal = Deferred.makeUnsafe<undefined>()
      pty.onData(data => receive(session, generation, data))
      pty.onExit(({ exitCode }) => exited(session, generation, exitCode))
      if (!restarted) return
      cancelFlush(session)
      session.pending = ''
      session.scrollback.clear()
      session.sequence += 1
      publish(session, { _tag: 'restarted', sequence: session.sequence, cols, rows })
    }

    /** Synchronously removes the session from service and ends its streams. Returns the process still to stop. */
    const detach = (session: Session): PtyProcess | undefined => {
      const key = terminalSessionKey(session.taskId, session.terminalId)
      if (sessions.get(key) === session) sessions.delete(key)
      session.closed = true
      cancelFlush(session)
      session.pending = ''
      for (const subscriber of session.subscribers) Queue.endUnsafe(subscriber.queue)
      session.subscribers.clear()
      const pty = session.pty
      session.pty = undefined
      return pty
    }

    /** Hangs up the process, waits the grace period, then kills its tree. */
    const terminate = (session: Session, pty: PtyProcess): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          try {
            pty.kill()
          } catch {
            // The pseudo-terminal already exited; the exit signal below still resolves.
          }
        })
        const stopped = yield* Deferred.await(session.exitSignal).pipe(Effect.timeoutOption(killGraceMs))
        if (Option.isNone(stopped)) yield* killTree(pty.pid).pipe(Effect.ignore)
      })

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...sessions.values()],
        session => {
          const pty = detach(session)
          return pty ? terminate(session, pty) : Effect.void
        },
        { concurrency: 'unbounded', discard: true },
      ),
    )

    const open = (request: TerminalSpawnRequest): Effect.Effect<TerminalSnapshot, TerminalHostError> =>
      gate.withPermit(
        Effect.gen(function* () {
          yield* requireDimensions(request.cols, request.rows)
          const existing = sessions.get(terminalSessionKey(request.taskId, request.terminalId))
          if (existing) return snapshotOf(existing)
          if (countForTask(request.taskId) >= maxPerTask || countLive() >= maxLiveSessions) {
            return yield* Effect.fail(failure('limit-reached'))
          }
          yield* requireDirectory(request.cwd)
          const session: Session = {
            taskId: request.taskId,
            terminalId: request.terminalId,
            scrollback: new TerminalScrollback(scrollbackBytes),
            subscribers: new Set(),
            status: 'exited',
            exitCode: null,
            cols: request.cols,
            rows: request.rows,
            sequence: 0,
            pending: '',
            flushTimer: undefined,
            generation: 0,
            pty: undefined,
            exitSignal: Deferred.makeUnsafe<undefined>(),
            closed: false,
          }
          yield* Effect.try({
            try: () => startProcess(session, request.cwd, request.cols, request.rows, false),
            catch: () => failure('spawn-failed'),
          })
          sessions.set(terminalSessionKey(request.taskId, request.terminalId), session)
          return snapshotOf(session)
        }),
      )

    const restart = (request: TerminalSpawnRequest): Effect.Effect<TerminalSnapshot, TerminalHostError> =>
      gate.withPermit(
        Effect.gen(function* () {
          yield* requireDimensions(request.cols, request.rows)
          const session = yield* lookup(request.taskId, request.terminalId)
          if (session.status !== 'exited') return yield* Effect.fail(failure('conflict'))
          yield* requireDirectory(request.cwd)
          yield* Effect.try({
            try: () => startProcess(session, request.cwd, request.cols, request.rows, true),
            catch: () => failure('spawn-failed'),
          })
          return snapshotOf(session)
        }),
      )

    const attach = (taskId: TaskId, terminalId: TerminalId): Stream.Stream<TerminalFrame, TerminalHostError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.bounded<TerminalFrame, TerminalHostError | Cause.Done>(SUBSCRIBER_CAPACITY)
          // The lookup, registration and snapshot run without yielding, so no output can fall between them.
          const session = sessions.get(terminalSessionKey(taskId, terminalId))
          if (!session) return Stream.fail(failure('not-found'))
          const subscriber: Subscriber = { queue, bytes: 0 }
          session.subscribers.add(subscriber)
          const snapshot: TerminalFrame = {
            _tag: 'snapshot',
            sequence: session.sequence,
            status: session.status,
            exitCode: session.exitCode,
            cols: session.cols,
            rows: session.rows,
            data: session.scrollback.snapshot(),
          }
          return Stream.make(snapshot).pipe(
            Stream.concat(
              Stream.fromQueue(queue).pipe(
                Stream.mapEffect(frame =>
                  Effect.sync(() => {
                    subscriber.bytes -= frameBytes(frame)
                    return frame
                  }),
                ),
              ),
            ),
            Stream.ensuring(
              Effect.sync(() => {
                session.subscribers.delete(subscriber)
              }),
            ),
          )
        }),
      )

    return TerminalHost.of({
      open,
      restart,
      attach,
      write: (taskId, terminalId, data) =>
        Effect.gen(function* () {
          const session = yield* lookup(taskId, terminalId)
          if (data.length > TERMINAL_WRITE_MAX_CHARS) return yield* Effect.fail(failure('invalid-request'))
          const pty = session.pty
          if (session.status !== 'running' || !pty) return yield* Effect.fail(failure('not-running'))
          yield* Effect.try({ try: () => pty.write(data), catch: () => failure('failed') })
        }),
      resize: (taskId, terminalId, cols, rows) =>
        Effect.gen(function* () {
          yield* requireDimensions(cols, rows)
          const session = yield* lookup(taskId, terminalId)
          const pty = session.pty
          if (session.status !== 'running' || !pty) return
          if (session.cols === cols && session.rows === rows) return
          yield* Effect.sync(() => {
            try {
              pty.resize(cols, rows)
              session.cols = cols
              session.rows = rows
            } catch {
              // A resize that races with exit is harmless; the exit event reports the outcome.
            }
          })
        }),
      close: (taskId, terminalId) =>
        Effect.gen(function* () {
          // The session leaves the registry under the gate; the grace period runs outside it.
          const session = yield* gate.withPermit(
            Effect.map(lookup(taskId, terminalId), found => ({ found, pty: detach(found) })),
          )
          if (session.pty) yield* terminate(session.found, session.pty)
        }),
      list: taskId =>
        Effect.sync(() =>
          [...sessions.values()]
            .filter(session => session.taskId === taskId)
            .sort((left, right) => left.terminalId.localeCompare(right.terminalId))
            .map(summaryOf),
        ),
    })
  })

/** Application-lifetime host: every session is ended when the layer's scope closes. */
export const terminalHostLayer = (options: TerminalHostOptions = {}) =>
  Layer.effect(TerminalHost, makeTerminalHost(options))

export const TerminalHostLive = terminalHostLayer()
