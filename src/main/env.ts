import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

/**
 * Env-only Config service (ADR 0032 §5.2, Wave 3 first seam).
 *
 * Startup-immutable snapshot of `process.env` for the gateway seam only:
 * the live layer resolves `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` once per
 * layer provisioning via Effect `Config` and stores the trimmed result as a
 * plain value. Effects read `yield* Env` — they never touch `process.env`
 * directly, so tests substitute the fake layer with no env mutation and the
 * Effect Clock (`TestClock`) governs timeouts downstream without interference.
 *
 * Persisted settings stay in `LedgerRepository` — this service is env-only by
 * design (locked §5.2). No unified `AppConfig`, no `@effect/platform`,
 * no Zod, no renderer/IPC involvement.
 *
 * Extension (next seam): add a field to the `Service` shape, extend the live
 * `Effect.gen` below with another `Config.option(Config.String(...))` read,
 * and thread it through `Env.of`. The fake `layerWithValues` already accepts
 * the full shape so callers/tests pick up the new key with no signature churn;
 * `layerWithGatewayKey` stays as the single-key shortcut for this seam.
 */
export function resolveGatewayKey(primaryRaw: string | undefined, fallbackRaw: string | undefined): string | null {
  const raw = primaryRaw ?? fallbackRaw
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}

const readGatewayKeyLive: Effect.Effect<string | null, never> = Effect.gen(function* () {
  const primary = yield* Config.option(Config.String('AI_GATEWAY_API_KEY'))
  const fallback = yield* Config.option(Config.String('VERCEL_OIDC_TOKEN'))
  return resolveGatewayKey(Option.getOrUndefined(primary), Option.getOrUndefined(fallback))
}).pipe(Effect.orElseSucceed(() => null))

export class Env extends Context.Service<
  Env,
  {
    readonly vercelGatewayApiKey: string | null
  }
>()('watchtower/env/Env') {
  static readonly layer: Layer.Layer<Env> = Layer.effect(
    Env,
    Effect.map(readGatewayKeyLive, vercelGatewayApiKey => Env.of({ vercelGatewayApiKey })),
  )

  static readonly layerWithValues = (values: Env['Service']): Layer.Layer<Env> => Layer.succeed(Env, Env.of(values))

  static readonly layerWithGatewayKey = (vercelGatewayApiKey: string | null): Layer.Layer<Env> =>
    Env.layerWithValues({ vercelGatewayApiKey })
}
