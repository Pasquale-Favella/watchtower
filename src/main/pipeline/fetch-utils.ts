import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientError from 'effect/unstable/http/HttpClientError'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import type { HttpMethod } from 'effect/unstable/http/HttpMethod'

import { FETCH_TIMEOUT_COUNTER, type OperationalLogCounter } from '../operational-log.js'

// Default ceiling for outbound HTTP. Every CLI command awaits loadPricingEffect(),
// and the macOS menubar shells out to the CLI and blocks on its exit — so an
// unbounded fetch() on a half-open network (e.g. Wi-Fi/DNS not yet up after
// wake-from-sleep) wedges the menubar on its loading spinner indefinitely.
// 8s is generous for these small JSON endpoints while still failing fast.
export const DEFAULT_FETCH_TIMEOUT_MS = 8000

/** Typed fetch failure: timeout, caller abort, or network. HTTP statuses are
 * not failures here — callers check `response.ok` themselves to preserve the
 * existing offline/blocked/non-2xx fallback behavior. */
export class HttpFetchError extends Schema.TaggedError<HttpFetchError>()('HttpFetchError', {
  reason: Schema.Literals(['timeout', 'abort', 'network']),
  message: Schema.String,
  url: Schema.String,
}) {}

export const TRANSIENT_RETRY_BASE_MS = 250
export const TRANSIENT_RETRY_CAP_MS = 1_000
export const TRANSIENT_RETRY_RETRIES = 2

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
export const transientRetrySchedule: Schedule.Schedule<Duration.Duration, HttpFetchError> = Schedule.min([
  Schedule.exponential(Duration.millis(TRANSIENT_RETRY_BASE_MS)),
  Schedule.spaced(Duration.millis(TRANSIENT_RETRY_CAP_MS)),
]).pipe(Schedule.upTo({ times: TRANSIENT_RETRY_RETRIES }), Schedule.jittered)

/**
 * The abort guard paired with `transientRetrySchedule` — the `while` half of
 * `retryTransientFetch` below.
 *
 * `HttpFetchError.reason` is `'timeout' | 'abort' | 'network'`. `timeout` and
 * `network` are the transient pair a blip produces (DNS not up after
 * wake-from-sleep, a dropped connection, a half-open Wi-Fi), so both retry.
 * A non-2xx status is deliberately absent: statuses are not failures here, so
 * a 500 never reaches this predicate and is handled by the caller's own
 * `response.ok` check exactly as before.
 *
 * `abort` is the interruption signal — fiber interruption or a caller
 * `AbortSignal` — and it is what makes the retry honest: retrying it would
 * restart work the caller just cancelled, which is precisely the property the
 * original no-retry design was protecting. An abort therefore costs zero
 * retries, zero extra fetches, and zero extra clock time.
 */
export function isTransientFetchError(error: HttpFetchError): boolean {
  return error.reason !== 'abort'
}

/**
 * How the four call sites (FX, pricing, updates, gateway) apply the bounded
 * retry: `http.fetch(url, {}, timeout).pipe(retryTransientFetch,
 * Effect.mapError(...))`.
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
 * the real `min`/exponential/`jittered` pipeline has no such blind spot: it is
 * the schedule's own worst case by construction.
 *
 * Jitter is ±20% (`Schedule.jittered`'s default), so each stepped delay is
 * scaled by `JITTER_CEILING` to take the ceiling. Over-shooting is free — virtual
 * time costs no wall clock — while under-shooting is the only failure mode.
 */
export const worstCaseRetryWindowMs = (perAttemptTimeoutMs: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(transientRetrySchedule)
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

function isAbortError(cause: unknown): boolean {
  if (cause instanceof DOMException) return cause.name === 'AbortError'
  if (cause instanceof Error) return cause.name === 'AbortError'
  return false
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Optional counter sink for fetch timeouts (value-seam, not `R`-channel):
 *  defaults to the live singleton delegation below so every existing
 *  `layerWithFetch(fake)` call site keeps compiling with zero edits and prod
 *  files counters with no second sink. Tests inject a fake recording
 *  `incrementCounter` calls. Mirrors `HarnessSnapshotCounters` (Wave 4). */
export interface HttpFetchCounters {
  incrementCounter: (
    name: OperationalLogCounter,
    amount?: number,
    fields?: Record<string, unknown>,
  ) => Effect.Effect<void>
}

/**
 * Live counter delegation for the fetch-timeout slice (Wave 5, issue #148):
 * files `FETCH_TIMEOUT_COUNTER` through the main-owned writer via
 * `Effect.log*` + `annotateLogs` — same sink, same allowlist, same `main`
 * context, never a second sink, never OTLP. `event` and `context` ride the
 * annotation bag because they are not Effect concepts. The never-throw guard
 * lives in ONE place (inside the `Logger`) rather than being re-declared here,
 * so every call site that omits `counters` files counters with zero edits and
 * no duplicated try/`catch`.
 */
const liveFetchCounters: HttpFetchCounters = {
  incrementCounter: (name, amount = 1, fields = {}) =>
    Effect.logInfo(name).pipe(Effect.annotateLogs({ event: name, context: 'main', ...fields, count: amount })),
}

// Timeout-only counter: filed AFTER the deadline race resolves (the race
// width is unchanged — `timeoutOption` already settled to `None` before this
// runs), alongside the error mapping, never inside it. `catchCause` (which,
// unlike `ignore`, also swallows defects and interruptions) covers every sink
// defect — so the `HttpFetchError{timeout}` contract stays byte-identical.
// Abort and network paths never file. Filed fields are reason-only — never
// the URL, which is untrusted input and is on no list. `reason: 'timeout'` is
// the single value allowlisted for this key (`ALLOWED_ENUM_FIELDS.reason`), so
// the record breaks down by reason while every other `reason` string in the app
// stays droppable; `sanitizeOperationalRecord` remains the enforcement point.
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
      message: `fetch timed out after ${timeoutMs}ms`,
      url,
    })
  })
}

function makeFetch(
  fetchImpl: typeof fetch,
  counters: HttpFetchCounters = liveFetchCounters,
): (url: string, init?: RequestInit, timeoutMs?: number) => Effect.Effect<Response, HttpFetchError> {
  return Effect.fn('HttpFetch.fetch')(function* (
    url: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  ): Effect.fn.Return<Response, HttpFetchError> {
    const attempt = Effect.tryPromise({
      try: signal => {
        const combined = init.signal ? AbortSignal.any([init.signal, signal]) : signal
        return fetchImpl(url, { ...init, signal: combined })
      },
      catch: cause => {
        const message = errorMessage(cause)
        return new HttpFetchError({
          reason: isAbortError(cause) ? 'abort' : 'network',
          message,
          url,
        })
      },
    })
    const outcome = yield* attempt.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)))
    if (Option.isNone(outcome)) {
      return yield* fileFetchTimeout(counters, timeoutMs, url)
    }
    return outcome.value
  })
}

function normalizeHeaderValue(value: string | readonly string[]): string {
  return typeof value === 'string' ? value : value.join(', ')
}

function toHeaderRecord(headers: NonNullable<RequestInit['headers']> | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) out[name] = normalizeHeaderValue(value)
  return out
}

function findContentType(headers: Record<string, string>): string | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
}

function toClientBody(
  url: string,
  body: RequestInit['body'],
  contentType: string | undefined,
): Effect.Effect<HttpBody.HttpBody | null, HttpFetchError> {
  if (body === null || body === undefined) return Effect.succeed(null)
  if (typeof body === 'string') return Effect.succeed(HttpBody.text(body, contentType))
  if (body instanceof URLSearchParams) {
    return Effect.succeed(HttpBody.text(body.toString(), contentType ?? 'application/x-www-form-urlencoded'))
  }
  if (body instanceof FormData) return Effect.succeed(HttpBody.formData(body))
  if (body instanceof Blob) {
    return Effect.tryPromise({
      try: () => body.arrayBuffer(),
      catch: cause =>
        new HttpFetchError({
          reason: 'network',
          message: errorMessage(cause),
          url,
        }),
    }).pipe(Effect.map(bytes => HttpBody.uint8Array(new Uint8Array(bytes), contentType || body.type || undefined)))
  }
  if (body instanceof ArrayBuffer) return Effect.succeed(HttpBody.uint8Array(new Uint8Array(body), contentType))
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
    return Effect.succeed(HttpBody.uint8Array(bytes, contentType))
  }
  if (body instanceof ReadableStream) {
    return Effect.succeed(HttpBody.raw(body, contentType === undefined ? undefined : { contentType }))
  }
  return Effect.fail(new HttpFetchError({ reason: 'network', message: `unsupported request body for ${url}`, url }))
}

function buildClientRequest(
  url: string,
  init: RequestInit,
): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpFetchError> {
  return Effect.gen(function* () {
    const headers = toHeaderRecord(init.headers)
    const body = yield* toClientBody(url, init.body ?? null, findContentType(headers))
    const method = (init.method ?? 'GET') as HttpMethod
    return body === null
      ? HttpClientRequest.make(method)(url, { headers })
      : HttpClientRequest.make(method)(url, { headers, body })
  })
}

function toHttpFetchError(url: string, error: HttpClientError.HttpClientError): HttpFetchError {
  const cause = error.reason.cause
  return new HttpFetchError({
    reason: error.reason._tag === 'TransportError' && isAbortError(cause) ? 'abort' : 'network',
    message: cause instanceof Error ? cause.message : error.message,
    url,
  })
}

// The platform client has no `toWeb` accessor (`WebHttpClientResponse.source`
// is private), so the response is rebuilt from the preserved surface — status,
// headers, and body bytes. Lossy by construction and documented here: `url`,
// `redirected`, `type`, and `statusText` reset to their defaults; multi-valued
// headers collapse (`set-cookie` included — no caller reads it); the body is
// buffered once up front, so the returned Response stays single-use exactly
// like a fetch Response. Statuses are never failures: callers keep checking
// `response.ok` themselves.
function toWebResponse(
  url: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Response, HttpFetchError> {
  return Effect.gen(function* () {
    const buffer = yield* response.arrayBuffer.pipe(
      Effect.mapError(cause => new HttpFetchError({ reason: 'network', message: cause.message, url })),
    )
    const headers = new Headers()
    for (const [name, value] of Object.entries(response.headers)) headers.set(name, value)
    return new Response(buffer.byteLength === 0 ? null : buffer, { status: response.status, headers })
  })
}

// Live fetch over the in-package platform client (`FetchHttpClient.layer` +
// `HttpClient`): the platform executor passes its abort signal to fetch, so
// fiber interruption still aborts the underlying request, and transport
// failures still collapse to `TransportError{cause}`, which keeps the
// `{timeout|abort|network}` mapping via the same abort-cause inspection.
// Deliberately NOT applied: `retryTransient`/`filterStatusOk` — this CLIENT
// stays single-attempt on purpose. The bounded retry that closes F15 lives at
// the four call sites (`retryTransientFetch` above), not in here, so one
// `HttpFetch.fetch` is still exactly one wire request with one 8s ceiling and
// a status is still not a failure. The old comment here said the no-retry
// contract stood "because callers degrade to fallbacks"; the degrade is real
// but a blip used to cost 24h of stale FX, so the retry moved up a level
// instead of disappearing. The Clock timeout covers request completion
// (headers), matching the previous `fetch()`
// resolution window; body bytes are consumed after it, exactly where callers
// already read `response.json()` themselves. Requests carrying a caller
// `AbortSignal` cannot be expressed in the platform request model, so they
// keep the bespoke `AbortSignal.any` combining executor over the same `Fetch`
// transport — same seam, same semantics.
function makeClientFetch(
  client: HttpClient.HttpClient,
  counters: HttpFetchCounters = liveFetchCounters,
): (url: string, init?: RequestInit, timeoutMs?: number) => Effect.Effect<Response, HttpFetchError> {
  return Effect.fn('HttpFetch.fetch')(function* (
    url: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  ): Effect.fn.Return<Response, HttpFetchError> {
    if (init.signal?.aborted === true) {
      return yield* new HttpFetchError({ reason: 'abort', message: 'fetch aborted before start', url })
    }
    if (init.signal !== undefined && init.signal !== null) {
      return yield* makeFetch(yield* FetchHttpClient.Fetch, counters)(url, init, timeoutMs)
    }
    const request = yield* buildClientRequest(url, init)
    const outcome = yield* client.execute(request).pipe(
      Effect.mapError(error => toHttpFetchError(url, error)),
      Effect.timeoutOption(Duration.millis(timeoutMs)),
    )
    if (Option.isNone(outcome)) {
      // Same timeout-only filing as `makeFetch` (see `fileFetchTimeout`).
      return yield* fileFetchTimeout(counters, timeoutMs, url)
    }
    return yield* toWebResponse(url, outcome.value)
  })
}

/** Effect-native fetch with explicit timeout and typed failures. Timeout uses
 * the Effect Clock (TestClock-controllable); fiber interruption aborts the
 * underlying fetch via the platform client's abort signal (bespoke
 * `AbortSignal.any` combining for caller-signal requests) — no manual
 * AbortSignal plumbing at call sites. `fetch` itself is single-attempt and
 * stays that way: the bounded `retryTransientFetch` is applied by the FX /
 * pricing / updates / gateway call sites, not here, so this service is
 * unchanged and callers still degrade to cached/snapshot fallbacks — just
 * after a bounded retry instead of after one attempt. */
export class HttpFetch extends Context.Service<
  HttpFetch,
  {
    readonly fetch: (url: string, init?: RequestInit, timeoutMs?: number) => Effect.Effect<Response, HttpFetchError>
  }
>()('watchtower/pipeline/HttpFetch') {
  static readonly layer = Layer.effect(
    HttpFetch,
    Effect.map(HttpClient.HttpClient, client => HttpFetch.of({ fetch: makeClientFetch(client) })),
  ).pipe(Layer.provide(FetchHttpClient.layer))

  static readonly layerWithFetch = (fetchImpl: typeof fetch, counters?: HttpFetchCounters) =>
    Layer.succeed(HttpFetch, HttpFetch.of({ fetch: makeFetch(fetchImpl, counters ?? liveFetchCounters) }))
}
