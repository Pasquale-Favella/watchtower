import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { TerminalHost, TerminalHostError } from '@/core/ports/terminal-host.js'
import { TerminalRpcError, TerminalRpcGroup, terminalRpcMessages } from '@/shared/rpc/terminal.js'
import { TERMINAL_DEFAULT_COLS, TERMINAL_DEFAULT_ROWS, type TerminalId } from '@/shared/schemas/terminal.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

function failure(code: TerminalRpcError['code']): TerminalRpcError {
  return new TerminalRpcError({ code, message: terminalRpcMessages[code] })
}

/** Maps host and resolver failures onto fixed messages; raw causes stay in the operational log, not the wire. */
function sanitize(error: unknown): TerminalRpcError {
  if (Schema.is(TerminalRpcError)(error)) return error
  if (Schema.is(TerminalHostError)(error)) return failure(error.reason)
  return failure('failed')
}

function safe<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, TerminalRpcError, R> {
  return effect.pipe(
    Effect.catchCause(cause => {
      const found = Cause.findError(cause)
      return Effect.fail(found._tag === 'Success' ? sanitize(found.success) : failure('failed'))
    }),
  )
}

export interface TerminalHandlerOptions {
  /** Resolves the Task's checkout on the server. The renderer never supplies a working directory. */
  readonly resolveTaskCwd: (taskId: TaskId) => Effect.Effect<string, TerminalRpcError>
}

/** Built per authenticated app connection; the TerminalHost behind it is application-lifetime. */
export function terminalHandlers(options: TerminalHandlerOptions) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const host = yield* TerminalHost
      const spawnRequest = (request: {
        readonly taskId: TaskId
        readonly terminalId: TerminalId
        readonly cols?: number | undefined
        readonly rows?: number | undefined
      }) =>
        Effect.map(options.resolveTaskCwd(request.taskId), cwd => ({
          taskId: request.taskId,
          terminalId: request.terminalId,
          cwd,
          cols: request.cols ?? TERMINAL_DEFAULT_COLS,
          rows: request.rows ?? TERMINAL_DEFAULT_ROWS,
        }))

      return TerminalRpcGroup.toLayer({
        'terminal:open': request => safe(Effect.flatMap(spawnRequest(request), host.open)),
        'terminal:restart': request => safe(Effect.flatMap(spawnRequest(request), host.restart)),
        'terminal:attach': ({ taskId, terminalId }) => host.attach(taskId, terminalId).pipe(Stream.mapError(sanitize)),
        'terminal:write': ({ taskId, terminalId, data }) => safe(host.write(taskId, terminalId, data)),
        'terminal:resize': ({ taskId, terminalId, cols, rows }) => safe(host.resize(taskId, terminalId, cols, rows)),
        'terminal:close': ({ taskId, terminalId }) => safe(host.close(taskId, terminalId)),
        'terminal:list': ({ taskId }) => safe(Effect.map(host.list(taskId), items => ({ items: [...items] }))),
      })
    }),
  )
}
