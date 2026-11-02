import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import { TerminalRpcError } from '@/shared/rpc/terminal.js'
import { type TerminalId, terminalSessionKey } from '@/shared/schemas/terminal.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import type { TerminalSessionEvent } from './terminal-storage.js'

const terminalRuntime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)

export type TerminalSessionListener = (event: TerminalSessionEvent) => void

type SessionCommand =
  | { readonly _tag: 'write'; readonly data: string }
  | { readonly _tag: 'resize'; readonly cols: number; readonly rows: number }

const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 5_000
/** These failures will not change on retry, so the pane reports them and stops. */
const PERMANENT_CODES = new Set(['cwd-unavailable', 'limit-reached', 'spawn-failed', 'invalid-request', 'conflict'])
const CONNECTION_LOST = 'Connection interrupted. Reconnecting.'

const listeners = new Map<string, Set<TerminalSessionListener>>()
const commandQueues = new Map<string, Queue.Queue<SessionCommand>>()
const sessionAtoms = new Map<string, ReturnType<typeof createSessionAtom>>()

function publish(key: string, event: TerminalSessionEvent): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener(event)
}

/** Registers a pane for one session's events. Frames are delivered synchronously, in server order. */
export function subscribeTerminalSession(
  taskId: TaskId,
  terminalId: TerminalId,
  listener: TerminalSessionListener,
): () => void {
  const key = terminalSessionKey(taskId, terminalId)
  const set = listeners.get(key) ?? new Set<TerminalSessionListener>()
  set.add(listener)
  listeners.set(key, set)
  return () => {
    set.delete(listener)
    if (set.size === 0 && listeners.get(key) === set) listeners.delete(key)
  }
}

/** Queues input or a resize for one attached session. Commands are sent in the order they were queued. */
export function sendTerminalCommand(taskId: TaskId, terminalId: TerminalId, command: SessionCommand): boolean {
  const queue = commandQueues.get(terminalSessionKey(taskId, terminalId))
  return queue !== undefined && Queue.offerUnsafe(queue, command)
}

const failureMessage = (error: unknown): string =>
  Schema.is(TerminalRpcError)(error) ? error.message : CONNECTION_LOST

/** Reconnect waits double from the minimum up to the maximum. */
function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt)
}

function createSessionAtom(taskId: TaskId, terminalId: TerminalId) {
  const key = terminalSessionKey(taskId, terminalId)
  return terminalRuntime.atom(get =>
    Effect.gen(function* () {
      const rpc = yield* ApplicationClient
      const commands = yield* Queue.unbounded<SessionCommand>()
      commandQueues.set(key, commands)
      get.addFinalizer(() => {
        if (commandQueues.get(key) === commands) commandQueues.delete(key)
      })
      yield* Effect.forkChild(
        Stream.runForEach(Stream.fromQueue(commands), command =>
          (command._tag === 'write'
            ? rpc('terminal:write', { taskId, terminalId, data: command.data })
            : rpc('terminal:resize', { taskId, terminalId, cols: command.cols, rows: command.rows })
          ).pipe(Effect.ignore),
        ),
      )

      let opened = false
      let attempt = 0
      while (true) {
        if (!opened) {
          const outcome = yield* Effect.exit(rpc('terminal:open', { taskId, terminalId }))
          if (Exit.isSuccess(outcome)) {
            opened = true
          } else {
            if (Cause.hasInterruptsOnly(outcome.cause)) return
            const failure = Option.getOrUndefined(Cause.findErrorOption(outcome.cause))
            publish(key, { _tag: 'failed', message: failureMessage(failure) })
            if (Schema.is(TerminalRpcError)(failure) && PERMANENT_CODES.has(failure.code)) return
            yield* Effect.sleep(reconnectDelayMs(attempt))
            attempt += 1
            continue
          }
        }

        const streamed = yield* Effect.exit(
          Stream.runForEach(rpc('terminal:attach', { taskId, terminalId }), frame =>
            Effect.sync(() => {
              attempt = 0
              publish(key, frame)
            }),
          ),
        )
        if (Exit.isSuccess(streamed)) {
          publish(key, { _tag: 'ended' })
          return
        }
        if (Cause.hasInterruptsOnly(streamed.cause)) return
        const failure = Option.getOrUndefined(Cause.findErrorOption(streamed.cause))
        if (Schema.is(TerminalRpcError)(failure) && failure.code === 'not-found') {
          publish(key, { _tag: 'ended' })
          return
        }
        if (Schema.is(TerminalRpcError)(failure) && failure.code === 'stream-overflow') {
          // The server ended a slow stream; a new attach begins with a fresh snapshot after a short pause.
          attempt = 0
          yield* Effect.sleep(RECONNECT_MIN_MS)
          continue
        }
        publish(key, { _tag: 'failed', message: failureMessage(failure) })
        yield* Effect.sleep(reconnectDelayMs(attempt))
        attempt += 1
        opened = false
      }
    }),
  )
}

/**
 * One live attachment per session. Mounting it opens the session if needed, then streams its
 * snapshot and output. Unmounting ends the stream; the server keeps the process running.
 */
export function terminalSessionAtom(taskId: TaskId, terminalId: TerminalId) {
  const key = terminalSessionKey(taskId, terminalId)
  let atom = sessionAtoms.get(key)
  if (!atom) {
    atom = createSessionAtom(taskId, terminalId)
    sessionAtoms.set(key, atom)
  }
  return atom
}

export interface TerminalTabInput {
  readonly taskId: TaskId
  readonly terminalId: TerminalId
  readonly cols?: number | undefined
  readonly rows?: number | undefined
}

/** Tab commands are independent, so they run concurrently; each one reports its own result. */
export const openTerminalAtom = terminalRuntime.fn<TerminalTabInput>()(
  input => Effect.flatMap(ApplicationClient, rpc => rpc('terminal:open', input)),
  { concurrent: true },
)

export const restartTerminalAtom = terminalRuntime.fn<TerminalTabInput>()(
  input => Effect.flatMap(ApplicationClient, rpc => rpc('terminal:restart', input)),
  { concurrent: true },
)

export const closeTerminalAtom = terminalRuntime.fn<Pick<TerminalTabInput, 'taskId' | 'terminalId'>>()(
  input => Effect.flatMap(ApplicationClient, rpc => rpc('terminal:close', input)),
  { concurrent: true },
)

export const listTerminalsAtom = terminalRuntime.fn<{ readonly taskId: TaskId }>()(
  input => Effect.flatMap(ApplicationClient, rpc => rpc('terminal:list', input)),
  { concurrent: true },
)
