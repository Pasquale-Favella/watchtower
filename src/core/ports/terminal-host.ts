import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Stream from 'effect/Stream'

import type {
  DraftTerminalTarget,
  TerminalFrame,
  TerminalId,
  TerminalOwner,
  TerminalOwnerRequest,
  TerminalSnapshot,
  TerminalSummary,
} from '@/shared/schemas/terminal.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

/** Reasons a terminal operation can fail. Adapters map platform errors onto these; the RPC boundary sanitizes them. */
export class TerminalHostError extends Schema.TaggedError<TerminalHostError>()('TerminalHostError', {
  reason: Schema.Literals([
    'invalid-request',
    'not-found',
    'limit-reached',
    'not-running',
    'conflict',
    'cwd-unavailable',
    'spawn-failed',
    'stream-overflow',
    'failed',
  ]),
}) {}

export interface TerminalSpawnRequest extends TerminalOwnerRequest {
  readonly terminalId: TerminalId
  /** Resolved by the caller from the Task's checkout. The host verifies it exists before spawning. */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
}

/**
 * Owns the Task-scoped shell sessions for the whole application lifetime. Sessions are keyed by
 * (taskId, terminalId); a session keeps running while no client is attached.
 */
export class TerminalHost extends Context.Service<
  TerminalHost,
  {
    /** Returns the existing session's snapshot, or spawns a new shell in `cwd`. */
    readonly open: (request: TerminalSpawnRequest) => Effect.Effect<TerminalSnapshot, TerminalHostError>
    /** Re-spawns an exited session under the same id and clears its scrollback. */
    readonly restart: (request: TerminalSpawnRequest) => Effect.Effect<TerminalSnapshot, TerminalHostError>
    /** Snapshot first, then live frames in sequence order. The stream ends when the session closes. */
    readonly attach: (taskId: TerminalOwner, terminalId: TerminalId) => Stream.Stream<TerminalFrame, TerminalHostError>
    readonly write: (
      taskId: TerminalOwner,
      terminalId: TerminalId,
      data: string,
    ) => Effect.Effect<void, TerminalHostError>
    readonly resize: (
      taskId: TerminalOwner,
      terminalId: TerminalId,
      cols: number,
      rows: number,
    ) => Effect.Effect<void, TerminalHostError>
    /** Terminates the process tree and removes the session. */
    readonly close: (taskId: TerminalOwner, terminalId: TerminalId) => Effect.Effect<void, TerminalHostError>
    readonly adoptDraft: (
      draft: DraftTerminalTarget,
      taskId: TaskId,
      cwd: string,
    ) => Effect.Effect<void, TerminalHostError>
    readonly list: (taskId: TerminalOwner) => Effect.Effect<ReadonlyArray<TerminalSummary>, TerminalHostError>
  }
>()('watchtower/core/TerminalHost') {}
