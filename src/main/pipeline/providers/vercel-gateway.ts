import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { Env } from '../../env.js'
import { HttpFetch, HttpFetchError, retryTransientFetch } from '../fetch-utils.js'
import { fileErrorCode, queueLogRecord } from '../file-errors.js'
import { scanAbortError, ScanAbortedError, throwIfScanAborted } from '../scan-control.js'
import type { DateRange } from '../types.js'
import { gatewayReportSchema, type GatewayReportRow } from './gateway-report.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const REPORT_URL = 'https://ai-gateway.vercel.sh/v1/report'

export type ReportRow = GatewayReportRow

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Legacy failure code for the gateway warn log. The old `fetchWithTimeout`
 * path logged the raw error's name slug (`abort`, `timeout`, else the
 * `unreachable` fallback); `HttpFetchError` carries a `reason` instead, so map
 * it back to preserve the exact codes. */
function gatewayFailureCode(err: unknown): string {
  if (err instanceof HttpFetchError) {
    if (err.reason === 'timeout') return 'timeout'
    if (err.reason === 'abort') return 'abort'
    return 'unreachable'
  }
  return fileErrorCode(err, 'unreachable')
}

function queueGatewayWarn(code: string): void {
  queueLogRecord({
    logEvent: 'scan.file-error',
    level: 'warn',
    fields: { op: 'scan', provider: 'vercel-gateway', code },
  })
}

export const fetchVercelGatewayReportEffect = Effect.fn('fetchVercelGatewayReport')(function* (
  dateRange: DateRange,
  signal?: AbortSignal,
): Effect.fn.Return<ReportRow[], ScanAbortedError, HttpFetch | Env> {
  if (signal?.aborted) return yield* scanAbortError(signal)
  const { vercelGatewayApiKey: key } = yield* Env
  if (!key) return []

  const params = new URLSearchParams({
    start_date: formatUtcDate(dateRange.start),
    end_date: formatUtcDate(dateRange.end),
    date_part: 'day',
    group_by: 'model',
  })

  const http = yield* HttpFetch
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    controller =>
      Effect.gen(function* () {
        // Bounded transient retry (F15/A1) on the fetch only: discovery used to
        // answer "no sessions" (plus one `unreachable` warn) off a single blip,
        // which silently zeroes a whole provider's cost for the scan. The
        // non-2xx arm below stays OUTSIDE the retry — a 401/500 is a real answer,
        // and the warn code it logs is byte-identical to today's.
        const res = yield* http
          .fetch(`${REPORT_URL}?${params}`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${key}`,
              Accept: 'application/json',
            },
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          })
          .pipe(retryTransientFetch)

        if (!res.ok) {
          // The gateway error body can carry request echoes — status only.
          yield* Effect.sync(() => queueGatewayWarn(`http-${res.status}`))
          return []
        }

        // Stop the native response body before joining the actual JSON promise.
        // Interrupting its Effect wrapper alone would leave body work unowned.
        const body = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const promise: Promise<unknown> = Promise.resolve().then(() => res.json())
            return {
              promise,
              drain: promise.then(
                () => undefined,
                () => undefined,
              ),
            }
          }),
          owned => Effect.tryPromise({ try: () => owned.promise, catch: cause => cause }),
          owned =>
            Effect.promise(() => {
              controller.abort()
              return owned.drain
            }),
        )
        if (signal?.aborted) return yield* scanAbortError(signal)
        const report = yield* Schema.decodeUnknownEffect(gatewayReportSchema)(body)
        return report.results ?? []
      }),
    controller => Effect.sync(() => controller.abort()),
  ).pipe(
    Effect.catch(err =>
      signal?.aborted
        ? Effect.fail(scanAbortError(signal))
        : Effect.sync(() => {
            queueGatewayWarn(gatewayFailureCode(err))
            return []
          }),
    ),
  )
})

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dateRange?: DateRange,
  context: ProviderScanContext = {},
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      throwIfScanAborted(context.signal)
      if (!dateRange) return

      // Compatibility for direct parser callers only. The worker injects its
      // one runtime through this Promise boundary. Delete the fallback after
      // all standalone test callers supply the GatewayReports capability.
      const pending = context.fetchGatewayReport
        ? context.fetchGatewayReport(dateRange, context.signal)
        : Effect.runPromise(
            fetchVercelGatewayReportEffect(dateRange, context.signal).pipe(
              Effect.provide(HttpFetch.layerWithFetch(globalThis.fetch)),
              Effect.provide(Env.layer),
            ),
            { signal: context.signal },
          )
      const rows = await pending.catch(error => {
        throwIfScanAborted(context.signal)
        // Promise parser boundary; unexpected failures retain their identity.
        // eslint-disable-next-line no-restricted-syntax
        throw error
      })
      throwIfScanAborted(context.signal)
      for (const row of rows) {
        throwIfScanAborted(context.signal)
        const day = row.day ?? ''
        const model = row.model ?? 'unknown'
        const costUSD = row.total_cost ?? 0
        const inputTokens = row.input_tokens ?? 0
        const outputTokens = row.output_tokens ?? 0
        if (costUSD === 0 && inputTokens === 0 && outputTokens === 0) continue

        const deduplicationKey = `vercel-gateway:${day}:${model}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        yield {
          provider: 'vercel-gateway',
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: row.cached_input_tokens ?? 0,
          cachedInputTokens: 0,
          reasoningTokens: row.reasoning_tokens ?? 0,
          webSearchRequests: 0,
          costUSD,
          tools: [],
          bashCommands: [],
          timestamp: day ? `${day}T12:00:00.000Z` : '',
          speed: 'standard',
          deduplicationKey,
          userMessage: '',
          sessionId: `${day}:${model}`,
          project: source.project,
        }
      }
    },
  }
}

export const discoverVercelGatewaySessionsEffect = Effect.fnUntraced(function* (): Effect.fn.Return<
  SessionSource[],
  never,
  Env
> {
  const { vercelGatewayApiKey: key } = yield* Env
  if (!key) return []
  return [
    {
      path: 'vercel-ai-gateway:report',
      project: 'Vercel AI Gateway',
      provider: 'vercel-gateway',
    },
  ]
})

export const vercelGateway: Provider = {
  name: 'vercel-gateway',
  displayName: 'Vercel AI Gateway',
  network: true,

  modelDisplayName(model: string): string {
    const slash = model.indexOf('/')
    return slash >= 0 ? model.slice(slash + 1) : model
  },

  toolDisplayName(rawTool: string): string {
    return rawTool
  },

  async discoverSessions(context: ProviderScanContext = {}): Promise<SessionSource[]> {
    throwIfScanAborted(context.signal)
    if (context.gatewayEnabled !== undefined) {
      return context.gatewayEnabled
        ? [{ path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' }]
        : []
    }
    return Effect.runPromise(discoverVercelGatewaySessionsEffect().pipe(Effect.provide(Env.layer)))
  },

  createSessionParser(
    source: SessionSource,
    seenKeys: Set<string>,
    dateRange?: DateRange,
    context?: ProviderScanContext,
  ): SessionParser {
    return createParser(source, seenKeys, dateRange, context)
  },
}
