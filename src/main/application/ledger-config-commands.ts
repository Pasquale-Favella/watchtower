import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type LedgerMcpStartupMode, ledgerMcpStartupModeSchema } from '../../shared/schemas/ledger-mcp.js'
import type { SkillsDismissalRequest } from '../../shared/schemas/skills.js'
import { CADENCE_OPTIONS, DEFAULT_CADENCE } from '../cadence.js'
import { LedgerConfig } from '../store/ledger-ports.js'

export class LedgerConfigValidationError extends Schema.TaggedError<LedgerConfigValidationError>()(
  'LedgerConfigValidationError',
  {
    message: Schema.Literals([
      'model and alias target must be non-empty strings',
      'model must be a non-empty string',
      'prices must be non-negative numbers',
    ]),
  },
) {}

const modelNameSchema = Schema.Trim.check(Schema.isNonEmpty())
const aliasSchema = Schema.Struct({ model: modelNameSchema, aliasOf: modelNameSchema })
const priceSchema = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const pricesSchema = Schema.Struct({ inputPricePerMillion: priceSchema, outputPricePerMillion: priceSchema })
const cadenceSchema = Schema.Literals(CADENCE_OPTIONS.map(option => option.value))

const decodeModelName = Effect.fnUntraced(function* (
  model: unknown,
): Effect.fn.Return<string, LedgerConfigValidationError> {
  return yield* Schema.decodeUnknownEffect(modelNameSchema)(model).pipe(
    Effect.mapError(() => new LedgerConfigValidationError({ message: 'model must be a non-empty string' })),
  )
})

export const addModelAlias = Effect.fn('addModelAlias')(function* (
  model: unknown,
  aliasOf: unknown,
): Effect.fn.Return<void, LedgerConfigValidationError | SqlError, LedgerConfig> {
  const alias = yield* Schema.decodeUnknownEffect(aliasSchema)({ model, aliasOf }).pipe(
    Effect.mapError(
      () => new LedgerConfigValidationError({ message: 'model and alias target must be non-empty strings' }),
    ),
  )
  const config = yield* LedgerConfig
  yield* config.setModelAlias(alias.model, alias.aliasOf)
})

export const removeModelAlias = Effect.fn('removeModelAlias')(function* (
  model: unknown,
): Effect.fn.Return<void, LedgerConfigValidationError | SqlError, LedgerConfig> {
  const name = yield* decodeModelName(model)
  const config = yield* LedgerConfig
  yield* config.removeModelAlias(name)
})

export const setModelPrice = Effect.fn('setModelPrice')(function* (
  model: unknown,
  inputPricePerMillion: unknown,
  outputPricePerMillion: unknown,
): Effect.fn.Return<void, LedgerConfigValidationError | SqlError, LedgerConfig> {
  const name = yield* decodeModelName(model)
  const prices = yield* Schema.decodeUnknownEffect(pricesSchema)({ inputPricePerMillion, outputPricePerMillion }).pipe(
    Effect.mapError(() => new LedgerConfigValidationError({ message: 'prices must be non-negative numbers' })),
  )
  const config = yield* LedgerConfig
  yield* config.setPriceOverride(name, prices)
})

export const removeModelPrice = Effect.fn('removeModelPrice')(function* (
  model: unknown,
): Effect.fn.Return<void, LedgerConfigValidationError | SqlError, LedgerConfig> {
  const name = yield* decodeModelName(model)
  const config = yield* LedgerConfig
  yield* config.removePriceOverride(name)
})

export const setRefreshCadence = Effect.fn('setRefreshCadence')(function* (
  value: unknown,
): Effect.fn.Return<void, SqlError, LedgerConfig> {
  const parsed = Schema.decodeUnknownResult(cadenceSchema)(value)
  const config = yield* LedgerConfig
  yield* config.setRefreshCadence(parsed._tag === 'Success' ? parsed.success : DEFAULT_CADENCE)
})

export const setLedgerMcpStartupMode = Effect.fn('setLedgerMcpStartupMode')(function* (
  value: unknown,
): Effect.fn.Return<LedgerMcpStartupMode, SqlError, LedgerConfig> {
  const parsed = Schema.decodeUnknownResult(ledgerMcpStartupModeSchema)(value)
  const startupMode = parsed._tag === 'Success' ? parsed.success : 'on-demand'
  const config = yield* LedgerConfig
  yield* config.setLedgerMcpStartupMode(startupMode)
  return startupMode
})

export const dismissSkill = Effect.fn('dismissSkill')(function* (
  request: SkillsDismissalRequest,
): Effect.fn.Return<void, SqlError, LedgerConfig> {
  const created = DateTime.formatIso(yield* DateTime.now)
  const config = yield* LedgerConfig
  yield* config.dismissSkill(request.source, request.name, request.reason, created)
})
