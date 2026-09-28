import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

/**
 * Env-only Config service (ADR 0032 §5.2, Wave 3 first seam + Wave 4 TTL seam).
 *
 * Startup-immutable snapshot of `process.env` for the gateway + pricing-TTL
 * seams: the live layer resolves `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN`
 * and `WATCHTOWER_PRICING_TTL_HOURS` once per layer provisioning via Effect
 * `Config` and stores the result as plain values. Effects read `yield* Env`
 * — they never touch `process.env` directly, so tests substitute the fake
 * layer with no env mutation and the Effect Clock (`TestClock`) governs
 * timeouts downstream without interference.
 *
 * Persisted settings stay in `LedgerRepository` — this service is env-only by
 * design (locked §5.2). No unified `AppConfig`, no `@effect/platform`,
 * no Zod, no renderer/IPC involvement.
 *
 * Extension (next seam): `WATCHTOWER_CACHE_DIR` sync readers stay via
 * `process.env` until the startup-snapshot design lands (later slice —
 * explicitly NOT this one). The fake `layerWithValues` already accepts the
 * full shape so callers/tests pick up new keys with no signature churn;
 * `layerWithGatewayKey` stays as the single-key shortcut for the gateway seam
 * (defaults the TTL to `Infinity`).
 */
export function resolveGatewayKey(primaryRaw: string | undefined, fallbackRaw: string | undefined): string | null {
  const raw = primaryRaw ?? fallbackRaw
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}

const MS_PER_HOUR: number = 60 * 60 * 1000

/**
 * Pure TTL parser preserving `getPricingCacheTtlMs` semantics exactly:
 * absent/unparseable/non-positive → `Infinity` (disables expiry).
 */
export function resolvePricingCacheTtlMs(raw: string | undefined): number {
  if (!raw) return Infinity
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) return Infinity
  return hours * MS_PER_HOUR
}

function readOptionalEnv(name: string): Effect.Effect<string | undefined, never> {
  return Config.option(Config.String(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )
}

const readGatewayKeyLive: Effect.Effect<string | null, never> = Effect.gen(function* () {
  const primary = yield* readOptionalEnv('AI_GATEWAY_API_KEY')
  const fallback = yield* readOptionalEnv('VERCEL_OIDC_TOKEN')
  return resolveGatewayKey(primary, fallback)
})

const readPricingCacheTtlMsLive: Effect.Effect<number, never> = Effect.gen(function* () {
  const raw = yield* readOptionalEnv('WATCHTOWER_PRICING_TTL_HOURS')
  return resolvePricingCacheTtlMs(raw)
})

export class Env extends Context.Service<
  Env,
  {
    readonly vercelGatewayApiKey: string | null
    readonly pricingCacheTtlMs: number
  }
>()('watchtower/env/Env') {
  static readonly layer: Layer.Layer<Env> = Layer.effect(
    Env,
    Effect.gen(function* () {
      const vercelGatewayApiKey = yield* readGatewayKeyLive
      const pricingCacheTtlMs = yield* readPricingCacheTtlMsLive
      return Env.of({ vercelGatewayApiKey, pricingCacheTtlMs })
    }),
  )

  static readonly layerWithValues = (values: Env['Service']): Layer.Layer<Env> => Layer.succeed(Env, Env.of(values))

  static readonly layerWithGatewayKey = (vercelGatewayApiKey: string | null): Layer.Layer<Env> =>
    Env.layerWithValues({ vercelGatewayApiKey, pricingCacheTtlMs: Infinity })
}
