import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { PricingDiagnostics } from '../application/pricing-diagnostics.js'
import { type AppPaths, overrideFor } from '../env.js'
import { queueLogRecord } from './file-errors.js'
import { looksLikeLocalModel } from './pricing-calculation.js'

/** Compatibility re-export; the model-name predicate is pure pricing logic. */
export { looksLikeLocalModel }

const warnedUnknownModels = new Set<string>()

function shouldWarnAboutUnknownModel(name: string, paths?: AppPaths): boolean {
  if (!name || name === '<synthetic>' || warnedUnknownModels.has(name)) return false
  if (looksLikeLocalModel(name)) return false
  return overrideFor(paths, 'WATCHTOWER_VERBOSE') === '1'
}

export function warnAboutUnknownModel(name: string, paths?: AppPaths): void {
  if (!shouldWarnAboutUnknownModel(name, paths)) return
  warnedUnknownModels.add(name)
  const safeName = name.replace(/[\x00-\x1F\x7F-\x9F]/g, '?').slice(0, 200)
  queueLogRecord({
    logEvent: 'pricing.unpriced',
    level: 'warn',
    fields: { op: 'pricing', model: safeName, code: 'unpriced' },
  })
}

/** Compatibility entry point for synchronous callers until their query migration. */
export function reportUnpricedModels(models: Iterable<string>): void {
  for (const model of new Set(models)) warnAboutUnknownModel(model)
}

export const PricingDiagnosticsLive = Layer.succeed(PricingDiagnostics, {
  reportUnpricedModels: models => Effect.sync(() => reportUnpricedModels(models)),
})
