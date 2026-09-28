import * as Effect from 'effect/Effect'

import { Env } from '../../env.js'
import { HttpFetch, HttpFetchError } from '../fetch-utils.js'
import { fileErrorCode, queueLogRecord } from '../file-errors.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, SessionParser, SessionSource } from './types.js'

const REPORT_URL = 'https://ai-gateway.vercel.sh/v1/report'

export type ReportRow = {
  day?: string
  model?: string
  total_cost?: number
  input_tokens?: number
  output_tokens?: number
  cached_input_tokens?: number
  cache_creation_input_tokens?: number
  reasoning_tokens?: number
  request_count?: number
}

// Wave-3 named condition #2 done this slice: `getVercelGatewayApiKey` deleted.
// Discovery runs through the env layer (`Env.layer` provided at this
// composition root, mirroring the parser seam below); `resolveGatewayKey`
// stays in `Env` (read-only here).

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

export const fetchVercelGatewayReportEffect = Effect.fnUntraced(function* (
  dateRange: DateRange,
): Effect.fn.Return<ReportRow[], never, HttpFetch | Env> {
  const { vercelGatewayApiKey: key } = yield* Env
  if (!key) return []

  const params = new URLSearchParams({
    start_date: formatUtcDate(dateRange.start),
    end_date: formatUtcDate(dateRange.end),
    date_part: 'day',
    group_by: 'model',
  })

  const http = yield* HttpFetch
  return yield* Effect.gen(function* () {
    const res = yield* http.fetch(`${REPORT_URL}?${params}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    })

    if (!res.ok) {
      // The gateway error body can carry request echoes — status only.
      yield* Effect.sync(() => queueGatewayWarn(`http-${res.status}`))
      return []
    }

    const body = yield* Effect.tryPromise({
      try: () => res.json() as Promise<{ results?: ReportRow[] }>,
      catch: cause => cause,
    })
    return body.results ?? []
  }).pipe(
    Effect.catch(err =>
      Effect.sync(() => {
        queueGatewayWarn(gatewayFailureCode(err))
        return []
      }),
    ),
  )
})

function createParser(source: SessionSource, seenKeys: Set<string>, dateRange?: DateRange): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!dateRange) return

      const rows = await Effect.runPromise(
        fetchVercelGatewayReportEffect(dateRange).pipe(
          Effect.provide(HttpFetch.layerWithFetch(globalThis.fetch)),
          Effect.provide(Env.layer),
        ),
      )
      for (const row of rows) {
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

  async discoverSessions(): Promise<SessionSource[]> {
    return Effect.runPromise(discoverVercelGatewaySessionsEffect().pipe(Effect.provide(Env.layer)))
  },

  createSessionParser(source: SessionSource, seenKeys: Set<string>, dateRange?: DateRange): SessionParser {
    return createParser(source, seenKeys, dateRange)
  },
}
