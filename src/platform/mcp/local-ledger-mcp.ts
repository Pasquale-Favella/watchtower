import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import { acquireLedgerMcp, type LedgerMcpEndpoint } from '@/platform/mcp/ledger-endpoint.js'
import type { LedgerMcpQueries } from '@/platform/mcp/query-api.js'

/** App-owned endpoint for Settings and the legacy HTTP Coach attachment. */
export class LocalLedgerMcp extends Context.Service<
  LocalLedgerMcp,
  {
    readonly connection: (queries: LedgerMcpQueries) => Effect.Effect<LedgerMcpEndpoint | null>
    readonly status: () => Effect.Effect<LedgerMcpEndpoint | null>
    readonly regenerate: (queries: LedgerMcpQueries) => Effect.Effect<LedgerMcpEndpoint | null>
    readonly shutdown: () => Effect.Effect<void>
  }
>()('watchtower/agents/ledger-mcp/Local') {}

export function localLedgerMcpLayer(
  runRequest: (request: Effect.Effect<void>) => Promise<void>,
): Layer.Layer<LocalLedgerMcp> {
  return Layer.effect(
    LocalLedgerMcp,
    Effect.gen(function* () {
      const gate = yield* Semaphore.make(1)
      let current: { readonly endpoint: LedgerMcpEndpoint; readonly scope: Scope.Closeable } | null = null
      let closed = false

      const stop = Effect.gen(function* () {
        const previous = current
        current = null
        if (previous) yield* Scope.close(previous.scope, Exit.void)
      })

      const connect = Effect.fnUntraced(function* (queries: LedgerMcpQueries) {
        if (closed) return null
        if (current) return current.endpoint
        const scope = yield* Scope.make()
        const result = yield* Effect.result(Scope.provide(scope)(acquireLedgerMcp(queries, runRequest)))
        if (result._tag === 'Failure') {
          yield* Scope.close(scope, Exit.fail(result.failure))
          yield* Effect.logError('mcp.start.failed').pipe(
            Effect.annotateLogs({ event: 'mcp.start.failed', op: 'ledger-mcp', code: result.failure.code }),
          )
          return null
        }
        current = { endpoint: result.success, scope }
        return current.endpoint
      })

      const shutdown = gate.withPermit(
        Effect.uninterruptible(
          Effect.sync(() => {
            closed = true
          }).pipe(Effect.andThen(stop)),
        ),
      )
      yield* Effect.addFinalizer(() => shutdown)

      return LocalLedgerMcp.of({
        connection: queries => gate.withPermit(Effect.uninterruptible(connect(queries))),
        status: () => gate.withPermit(Effect.sync(() => current?.endpoint ?? null)),
        regenerate: queries => gate.withPermit(Effect.uninterruptible(stop.pipe(Effect.andThen(connect(queries))))),
        shutdown: () => shutdown,
      })
    }),
  )
}
