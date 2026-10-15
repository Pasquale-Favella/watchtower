import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

export class PricingDiagnostics extends Context.Service<
  PricingDiagnostics,
  { reportUnpricedModels: (models: Iterable<string>) => Effect.Effect<void> }
>()('watchtower/application/PricingDiagnostics') {}
