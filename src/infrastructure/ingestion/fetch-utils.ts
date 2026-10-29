import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as Layer from 'effect/Layer'
import * as Metric from 'effect/Metric'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'

import { FETCH_TIMEOUT_COUNTER, type OperationalLogCounter } from '@/infrastructure/logging/operational-log.js'

// Default ceiling for outbound HTTP. Every CLI command awaits loadPricingEffect(),
// and the macOS menubar shells out to the CLI and blocks on its exit — so an
// unbounded fetch() on a half-open network (e.g. Wi-Fi/DNS not yet up after
// wake-from-sleep) wedges the menubar on its loading spinner indefinitely.
// 8s is generous for these small JSON endpoints while still failing fast.
export const DEFAULT_FETCH_TIMEOUT_MS = 8000

/** Typed request or response-body failure. HTTP statuses are returned as data —
 * callers check `response.ok` themselves to preserve offline/blocked fallback behavior. */
export class HttpFetchError extends Schema.TaggedError<HttpFetchError>()('HttpFetchError', {
  reason: Schema.Literals(['timeout', 'abort', 'network', 'decode']),
  message: Schema.String,
  url: Schema.String,
}) {}

export const TRANSIENT_RETRY_BASE_MS = 250
export const TRANSIENT_RETRY_CAP_MS = 1_000
export const TRANSIENT_RETRY_RETRIES = 2

const responseJsonSchema = Schema.fromJsonString(Schema.Unknown)

/**
 * `Schedule.jittered`'s default spread: each stepped delay can be drawn up to
 * 20% above nominal, so a worst-case window multiplies by this. Named so the
 * ceiling is one edit if the jitter configuration ever changes.
 */
const JITTER_CEILING = 1.2

/**
 * Bounded transient retry for the four fetch call sites (FX, pricing, updates,
 * gateway). Mirrors `respawnBackoffSchedule`'s shape — `Schedule.exponential`
 * capped by `Schedule.min` with `spaced`, then `Schedule.jittered` — because
 * that is already the in-repo exemplar of "capped exponential with jitter".
 *
 * The no-retry contract this file used to carry was "callers degrade to
 * fallbacks", and the degrade is still true — but its consequence was never
 * examined. One failed refresh left the last cached FX rate in place for
 * `FX_CACHE_TTL_MS` = 24h, so every currency figure in every Section was
 * silently wrong for a day off a two-second blip. The contract becomes:
 * callers degrade to fallbacks AFTER a bounded retry, so a transient blip
 * costs one wasted request instead of a day of wrong numbers.
 *
 * Rationale for the numbers:
 * - 2 retries (`Schedule.upTo({ times })`, the v4 bounded combinator — the
 *   effect is evaluated once before the schedule is stepped, so this is three
 *   attempts total): a blip clears within one or two; a genuinely dead network
 *   is still dead after three, and the caller's existing fallback is the right
 *   answer there. Bounded is the whole point — an unbounded retry would trade
 *   one silent-wrongness bug for a wedged one.
 * - Base 250ms, ×2 exponential, cap 1s: the full envelope is 250ms + 500ms of
 *   waiting (±20% jitter → 0.6–0.9s), a rounding error beside the 8s
 *   single-attempt ceiling it protects — and vastly smaller than the 24h TTL
 *   that one skipped refresh costs. The cap does not bite at two retries; it
 *   is here so raising the count cannot silently produce an unbounded curve.
 * - `Schedule.jittered` (±20%): four call sites in one process that all fail
 *   off the same wake-from-sleep event would otherwise retry in lockstep.
 *
 * `HttpFetch` itself remains single-attempt — this schedule is applied BY the
 * call sites, never inside the client, so the live fetch contract (one
 * attempt, the 8s ceiling, statuses are not failures) is unchanged and
 * `layerWithFetch`/`counters` seams are untouched. Apply it with
 * `retryTransientFetch` below, which is the single call-site spelling of the
 * policy.
 */
const transientRetryBaseSchedule: Schedule.Schedule<Duration.Duration, HttpFetchError> = Schedule.min([
  Schedule.exponential(Duration.millis(TRANSIENT_RETRY_BASE_MS)),
  Schedule.spaced(Duration.millis(TRANSIENT_RETRY_CAP_MS)),
]).pipe(Schedule.upTo({ times: TRANSIENT_RETRY_RETRIES }))

export const transientRetrySchedule: Schedule.Schedule<Duration.Duration, HttpFetchError> =
  transientRetryBaseSchedule.pipe(Schedule.jittered)

/**
 * The abort guard paired with `transientRetrySchedule` — the `while` half of
 * `retryTransientFetch` below.
 *
 * `HttpFetchError.reason` is `'timeout' | 'abort' | 'network' | 'decode'`.
 * `timeout` and `network` are the transient pair a blip produces (DNS not up after
 * wake-from-sleep, a dropped connection, a half-open Wi-Fi), so both retry.
 * A non-2xx status is deliberately absent: statuses are not failures here, so
 * a 500 never reaches this predicate and is handled by the caller's own
 * `response.ok` check exactly as before. Body transport failures also retry;
 * JSON syntax and schema failures are never transient.
 *
 * `abort` is the interruption signal — fiber interruption or a caller
 * `AbortSignal` — and it is what makes the retry honest: retrying it would
 * restart work the caller just cancelled, which is precisely the property the
 * original no-retry design was protecting. An abort therefore costs zero
 * retries, zero extra fetches, and zero extra clock time.
 */
export function isTransientFetchError(error: HttpFetchError): boolean {
  return error.reason === 'timeout' || error.reason === 'network'
}

/**
 * How the four call sites (FX, pricing, updates, gateway) apply the bounded
 * retry. `fetchJsonWithRetry` includes the successful response body in each
 * attempt, before callers map transport errors to their domain errors.
 *
 * Bundling the schedule and its abort guard into one point-free step is what
 * keeps the policy uniform: the guard is the half that makes a retry honest, so
 * a call site cannot reach for the schedule without it, and the `E =
 * HttpFetchError` slot enforces that the retry lands BEFORE an error-mapping
 * step — once `mapError` has erased `reason` there is nothing left to guard on.
 * A 5th call site gets the whole policy from one import.
 */
export function retryTransientFetch<A, R>(
  effect: Effect.Effect<A, HttpFetchError, R>,
): Effect.Effect<A, HttpFetchError, R> {
  return effect.pipe(Effect.retry({ schedule: transientRetrySchedule, while: isTransientFetchError }))
}

/**
 * The MOST virtual time the bounded retry can consume, for a given per-attempt
 * fetch timeout: every attempt times out, and the schedule contributes its
 * longest possible delay sequence.
 *
 * This exists because three test windows were sized for a SINGLE attempt and
 * then hung to the 120s `testTimeout` rather than failing on their assertion
 * when the retry landed — an under-counted virtual clock is indistinguishable
 * from a hang, which is the worst way for a timing test to go wrong. The
 * in-repo precedent is `respawnBackoffDelayForAttempt` (`db-worker/client.ts`):
 * step the schedule rather than re-derive its closed form, so nothing encodes a
 * second copy of the policy.
 *
 * That is the whole point, and it is why this is not a geometric series. A
 * closed form like `BASE * (2^RETRIES - 1)` silently ignores
 * `TRANSIENT_RETRY_CAP_MS`: correct while the cap does not bite, and safely
 * over-estimating if `RETRIES` is raised — but if someone LOWERED the cap below
 * `BASE * 2^n` it would under-count and the suite would hang again. Stepping
 * the shared base schedule preserves the real cap and retry count.
 *
 * Jitter is ±20% (`Schedule.jittered`'s default). The base delays are scaled
 * by the upper factor to take a true ceiling; scaling a random sample from the
 * already-jittered schedule can still under-count when that sample is low.
 */
export const worstCaseRetryWindowMs = Effect.fnUntraced(function* (
  perAttemptTimeoutMs: number,
): Effect.fn.Return<number> {
  const step = yield* Schedule.toStep(transientRetryBaseSchedule)
  // The schedule is attempt-driven, not input-driven: a capped exponential
  // bounded by `upTo` never reads the value it is stepped with, so any
  // `HttpFetchError` advances it identically. Only the delay matters here.
  const probe = new HttpFetchError({ reason: 'network', message: 'worst-case window probe', url: 'https://x.test' })
  let scheduleMs = 0
  for (let i = 0; i < TRANSIENT_RETRY_RETRIES; i++) {
    // `orDie`: the schedule only completes after the final step, and that
    // `Done` is never read here — a completion mid-loop would be a bug, so
    // fail loud rather than silently return a short window.
    const duration: Duration.Duration = (yield* Effect.orDie(step(0, probe)))[1]
    scheduleMs += Duration.toMillis(duration) * JITTER_CEILING
  }
  return (TRANSIENT_RETRY_RETRIES + 1) * perAttemptTimeoutMs + scheduleMs
})

/** Optional counter sink for timeout tests; production delegates to the shared
 * metric and operational log. */
export interface HttpFetchCounters {
  incrementCounter: (
    name: OperationalLogCounter,
    amount?: number,
    fields?: Record<string, unknown>,
  ) => Effect.Effect<void>
}

/** Updates the runtime metric and forwards one delta through the operational sink. */
const liveFetchCounters: HttpFetchCounters = {
  incrementCounter: Effect.fnUntraced(function* (
    name: OperationalLogCounter,
    amount = 1,
    fields: Record<string, unknown> = {},
  ) {
    yield* Metric.update(Metric.counter(name), amount)
    yield* Effect.logInfo(name).pipe(Effect.annotateLogs({ event: name, context: 'main', ...fields, count: amount }))
  }),
}

function fileFetchTimeout(
  counters: HttpFetchCounters,
  timeoutMs: number,
  url: string,
): Effect.Effect<never, HttpFetchError> {
  return Effect.gen(function* () {
    yield* counters
      .incrementCounter(FETCH_TIMEOUT_COUNTER, 1, { reason: 'timeout' })
      .pipe(Effect.catchCause(() => Effect.void))
    return yield* new HttpFetchError({
      reason: 'timeout',
      message: 'fetch timed out after ' + timeoutMs + 'ms',
      url,
    })
  })
}

export interface HttpFetchResponse {
  readonly ok: boolean
  readonly status: number
  readonly json: Effect.Effect<unknown, HttpFetchError>
}

export interface HttpFetchOptions {
  readonly headers?: HttpClientRequest.Options['headers']
  readonly signal?: AbortSignal
}

function isAbortError(cause: unknown): boolean {
  return (cause instanceof DOMException || cause instanceof Error) && cause.name === 'AbortError'
}

function toHttpFetchError(url: string, error: HttpClientError.HttpClientError): HttpFetchError {
  const cause = error.reason.cause
  return new HttpFetchError({
    reason: isAbortError(cause) ? 'abort' : 'network',
    message: cause instanceof Error ? cause.message : error.message,
    url,
  })
}

function callerAbort(signal: AbortSignal, url: string): Effect.Effect<never, HttpFetchError> {
  return Effect.callback(resume => {
    const fail = () =>
      resume(Effect.fail(new HttpFetchError({ reason: 'abort', message: 'fetch aborted by caller', url })))
    signal.addEventListener('abort', fail, { once: true })
    if (signal.aborted) fail()
    return Effect.sync(() => signal.removeEventListener('abort', fail))
  })
}

function makeHttpFetchLayer(counters: HttpFetchCounters = liveFetchCounters) {
  return Layer.effect(
    HttpFetch,
    Effect.map(HttpClient.HttpClient, client =>
      HttpFetch.of({
        fetch: Effect.fn('HttpFetch.fetch')(function* (
          url: string,
          options: HttpFetchOptions = {},
          timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
        ): Effect.fn.Return<HttpFetchResponse, HttpFetchError> {
          if (options.signal?.aborted) {
            return yield* new HttpFetchError({ reason: 'abort', message: 'fetch aborted before start', url })
          }
          const request = HttpClientRequest.get(url, {
            headers: options.headers,
          })
          const requestEffect = client.execute(request).pipe(
            Effect.mapError(error => toHttpFetchError(url, error)),
            Effect.timeoutOption(Duration.millis(timeoutMs)),
          )
          const outcome = options.signal
            ? yield* Effect.raceFirst(requestEffect, callerAbort(options.signal, url))
            : yield* requestEffect
          if (Option.isNone(outcome)) return yield* fileFetchTimeout(counters, timeoutMs, url)

          const response = outcome.value
          return {
            status: response.status,
            ok: response.status >= 200 && response.status < 300,
            json: response.text.pipe(
              Effect.mapError(error => toHttpFetchError(url, error)),
              Effect.flatMap(text =>
                text === ''
                  ? Effect.succeed(null)
                  : Schema.decodeUnknownEffect(responseJsonSchema)(text).pipe(
                      Effect.mapError(cause => new HttpFetchError({ reason: 'decode', message: cause.message, url })),
                    ),
              ),
              body => (options.signal ? Effect.raceFirst(body, callerAbort(options.signal, url)) : body),
            ),
          }
        }),
      }),
    ),
  )
}

/** HttpClient-backed JSON request. The timeout covers response headers, matching
 * the established contract; body decoding remains separate so non-2xx
 * fallbacks never read their bodies. Use `fetchJsonWithRetry` to retry a
 * successful response's body transport together with its request. */
export class HttpFetch extends Context.Service<
  HttpFetch,
  {
    readonly fetch: (
      url: string,
      options?: HttpFetchOptions,
      timeoutMs?: number,
    ) => Effect.Effect<HttpFetchResponse, HttpFetchError>
  }
>()('watchtower/pipeline/HttpFetch') {
  /** Requires an HttpClient supplied by the application composition root. */
  static get layer() {
    return makeHttpFetchLayer()
  }

  /** Test seam using the same FetchHttpClient and request pipeline as production. */
  static get layerWithFetch() {
    return (fetchImpl: typeof fetch, counters: HttpFetchCounters = liveFetchCounters) =>
      makeHttpFetchLayer(counters).pipe(
        Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)))),
      )
  }
}

export interface HttpJsonResponse {
  readonly ok: boolean
  readonly status: number
  readonly body: unknown
}

/** Retry request and body transport as one attempt. Non-2xx bodies stay unread. */
export const fetchJsonWithRetry = Effect.fnUntraced(function* (
  url: string,
  options: HttpFetchOptions = {},
  timeoutMs?: number,
): Effect.fn.Return<HttpJsonResponse, HttpFetchError, HttpFetch> {
  const http = yield* HttpFetch
  return yield* Effect.gen(function* () {
    const response = yield* http.fetch(url, options, timeoutMs)
    const body = response.ok ? yield* response.json : undefined
    return { ok: response.ok, status: response.status, body }
  }).pipe(retryTransientFetch)
})
