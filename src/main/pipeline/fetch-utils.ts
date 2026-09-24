import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

// Default ceiling for outbound HTTP. Every CLI command awaits loadPricingEffect(),
// and the macOS menubar shells out to the CLI and blocks on its exit — so an
// unbounded fetch() on a half-open network (e.g. Wi-Fi/DNS not yet up after
// wake-from-sleep) wedges the menubar on its loading spinner indefinitely.
// 8s is generous for these small JSON endpoints while still failing fast.
export const DEFAULT_FETCH_TIMEOUT_MS = 8000

/// fetch() with a hard timeout. On timeout the returned promise rejects with a
/// TimeoutError (an AbortError subtype), which callers already handle via their
/// existing try/catch + bundled-snapshot fallback. A caller-supplied signal is
/// combined with the timeout so either can abort the request.
///
/// Compatibility adapter (ADR 0032 slice): stays until fx, pricing, and updates
/// consume HttpFetch directly. Removal condition: no imports of
/// fetchWithTimeout remain.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
  return fetchImpl(url, { ...init, signal })
}

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

function makeFetch(
  fetchImpl: typeof fetch,
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
        const message = cause instanceof Error ? cause.message : String(cause)
        return new HttpFetchError({
          reason: isAbortError(cause) ? 'abort' : 'network',
          message,
          url,
        })
      },
    })
    const outcome = yield* attempt.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)))
    if (Option.isNone(outcome)) {
      return yield* new HttpFetchError({
        reason: 'timeout',
        message: `fetch timed out after ${timeoutMs}ms`,
        url,
      })
    }
    return outcome.value
  })
}

/** Effect-native fetch with explicit timeout and typed failures. Timeout uses
 * the Effect Clock (TestClock-controllable); fiber interruption aborts the
 * underlying fetch via the tryPromise signal — no manual AbortSignal plumbing
 * at call sites. No retry schedule: callers already degrade to cached/snapshot
 * fallbacks, and retries would change that contract. */
export class HttpFetch extends Context.Service<
  HttpFetch,
  {
    readonly fetch: (url: string, init?: RequestInit, timeoutMs?: number) => Effect.Effect<Response, HttpFetchError>
  }
>()('watchtower/pipeline/HttpFetch') {
  static readonly layer = Layer.succeed(HttpFetch, HttpFetch.of({ fetch: makeFetch(fetch) }))

  static readonly layerWithFetch = (fetchImpl: typeof fetch) =>
    Layer.succeed(HttpFetch, HttpFetch.of({ fetch: makeFetch(fetchImpl) }))
}
