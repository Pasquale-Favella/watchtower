import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { TerminalHost, TerminalHostError } from '@/core/ports/terminal-host.js'
import { TerminalRpcError, TerminalRpcGroup, terminalRpcMessages } from '@/shared/rpc/terminal.js'
import {
  type DraftTerminalTarget,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  type TerminalId,
  type TerminalOwnerRequest,
  terminalRequestTarget,
  terminalTargetPayload,
} from '@/shared/schemas/terminal.js'
import type { TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

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

export interface TerminalHandlerOptions<R = never> {
  /** Resolves the Task's checkout on the server. The renderer never supplies a working directory. */
  readonly resolveDraftCwd?: ((target: DraftTerminalTarget) => Effect.Effect<string, TerminalRpcError, R>) | undefined
  readonly resolveTaskCwd: (
    taskId: TaskId,
    checkoutId?: WorkspaceCheckoutId,
  ) => Effect.Effect<string, TerminalRpcError, R>
}

/** Built per authenticated app connection; the TerminalHost behind it is application-lifetime. */
export function terminalHandlers<R = never>(options: TerminalHandlerOptions<R>) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const host = yield* TerminalHost
      const resolveCwd = (request: TerminalOwnerRequest) => {
        const target = terminalRequestTarget(request)
        if (target.kind === 'task') return options.resolveTaskCwd(target.taskId)
        return options.resolveDraftCwd ? options.resolveDraftCwd(target) : Effect.fail(failure('cwd-unavailable'))
      }
      const spawnRequest = (
        request: TerminalOwnerRequest & {
          readonly terminalId: TerminalId
          readonly cols?: number | undefined
          readonly rows?: number | undefined
        },
      ) =>
        Effect.map(resolveCwd(request), cwd => ({
          ...terminalTargetPayload(terminalRequestTarget(request)),
          terminalId: request.terminalId,
          cwd,
          cols: request.cols ?? TERMINAL_DEFAULT_COLS,
          rows: request.rows ?? TERMINAL_DEFAULT_ROWS,
        }))

      return TerminalRpcGroup.toLayer({
        'terminal:open': request => safe(Effect.flatMap(spawnRequest(request), host.open)),
        'terminal:restart': request => safe(Effect.flatMap(spawnRequest(request), host.restart)),
        'terminal:attach': request =>
          host.attach(terminalRequestTarget(request), request.terminalId).pipe(Stream.mapError(sanitize)),
        'terminal:write': request => safe(host.write(terminalRequestTarget(request), request.terminalId, request.data)),
        'terminal:resize': request =>
          safe(host.resize(terminalRequestTarget(request), request.terminalId, request.cols, request.rows)),
        'terminal:close': request => safe(host.close(terminalRequestTarget(request), request.terminalId)),
        'terminal:list': request =>
          safe(Effect.map(host.list(terminalRequestTarget(request)), items => ({ items: [...items] }))),
        'terminal:adoptDraft': ({ draft, taskId, checkoutId }) =>
          safe(Effect.flatMap(options.resolveTaskCwd(taskId, checkoutId), cwd => host.adoptDraft(draft, taskId, cwd))),
      })
    }),
  )
}
