import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientError from 'effect/unstable/http/HttpClientError'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import type { HttpMethod } from 'effect/unstable/http/HttpMethod'

import { FETCH_TIMEOUT_COUNTER, type OperationalLogCounter, safeLogOperationalEvent } from '../operational-log.js'

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
 * files `FETCH_TIMEOUT_COUNTER` through the main-owned pino singleton via
 * `safeLogOperationalEvent` — same sink, same allowlist, same `main`
 * context, never a second sink, never OTLP. Mirrors
 * `OperationalLog.layer`'s `liveEmit` + never-throw guard so every call site
 * that omits `counters` files counters with zero edits.
 */
const liveFetchCounters: HttpFetchCounters = {
  incrementCounter: (name, amount = 1, fields = {}) =>
    Effect.sync(() => {
      try {
        safeLogOperationalEvent('info', name, { ...fields, count: amount }, 'main')
      } catch {
        /* logging must never break callers, including inside fibers */
      }
    }),
}

// Timeout-only counter: filed AFTER the deadline race resolves (the race
// width is unchanged — `timeoutOption` already settled to `None` before this
// runs), alongside the error mapping, never inside it. `catchCause` (which,
// unlike `ignore`, also swallows defects and interruptions) covers every sink
// defect — so the `HttpFetchError{timeout}` contract stays byte-identical.
// Abort and network paths never file. Filed fields are reason-only — never
// the URL (untrusted input for the allowlist; `sanitizeOperationalRecord` is
// the enforcement point and is NOT widened here).
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
// Deliberately NOT applied: `retryTransient`/`filterStatusOk` — the no-retry
// contract stands because callers degrade to fallbacks. The Clock timeout
// covers request completion (headers), matching the previous `fetch()`
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
 * AbortSignal plumbing at call sites. No retry schedule: callers already
 * degrade to cached/snapshot fallbacks, and retries would change that
 * contract. */
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
