import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'

import {
  type CurrencyRate,
  currencyRateRowSchema,
  modelAliasRowSchema,
  type PriceOverride,
  priceOverrideRowSchema,
} from '../../shared/schemas/ledger.js'
import { type LedgerMcpStartupMode, ledgerMcpStartupModeSchema } from '../../shared/schemas/ledger-mcp.js'
import type { SkillsDismissal } from '../../shared/schemas/skills.js'
import { DEFAULT_CADENCE } from '../cadence.js'
import { LedgerConfig } from './ledger-ports.js'
import { decodeRows } from './ledger-repository-codec.js'

export const SELECT_MODEL_ALIASES = 'SELECT model, alias_of FROM model_alias'

export const SELECT_PRICE_OVERRIDES = `
  SELECT model, input_price_per_million, output_price_per_million FROM price_override
`

export const LedgerConfigLive = Layer.effect(
  LedgerConfig,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const setModelAlias = Effect.fn('LedgerConfig.setModelAlias')(function* (model: string, aliasOf: string) {
      yield* sql.unsafe(
        'INSERT INTO model_alias (model, alias_of) VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET alias_of = excluded.alias_of',
        [model, aliasOf],
      )
    })

    const removeModelAlias = Effect.fn('LedgerConfig.removeModelAlias')(function* (model: string) {
      yield* sql.unsafe('DELETE FROM model_alias WHERE model = ?', [model])
    })

    const getModelAliases = Effect.fn('LedgerConfig.getModelAliases')(function* () {
      const rows = yield* sql.unsafe(SELECT_MODEL_ALIASES)
      return yield* decodeRows(modelAliasRowSchema)(rows)
    })

    const setPriceOverride = Effect.fn('LedgerConfig.setPriceOverride')(function* (
      model: string,
      override: Omit<PriceOverride, 'model'>,
    ) {
      yield* sql.unsafe(
        `
        INSERT INTO price_override (model, input_price_per_million, output_price_per_million) VALUES (?, ?, ?)
        ON CONFLICT(model) DO UPDATE SET input_price_per_million = excluded.input_price_per_million, output_price_per_million = excluded.output_price_per_million
      `,
        [model, override.inputPricePerMillion, override.outputPricePerMillion],
      )
    })

    const removePriceOverride = Effect.fn('LedgerConfig.removePriceOverride')(function* (model: string) {
      yield* sql.unsafe('DELETE FROM price_override WHERE model = ?', [model])
    })

    const getPriceOverrides = Effect.fn('LedgerConfig.getPriceOverrides')(function* () {
      const rows = yield* sql.unsafe(SELECT_PRICE_OVERRIDES)
      return yield* decodeRows(priceOverrideRowSchema)(rows)
    })

    const getCurrencyRate = Effect.fn('LedgerConfig.getCurrencyRate')(function* (code: string) {
      const rows = yield* sql.unsafe('SELECT code, symbol, rate, updated_at FROM currency_rate WHERE code = ?', [code])
      const row = rows[0]
      return row ? yield* Schema.decodeUnknownEffect(currencyRateRowSchema)(row) : null
    })

    const getDisplayCurrency = Effect.fn('LedgerConfig.getDisplayCurrency')(function* () {
      const rows = yield* sql.unsafe('SELECT code FROM display_currency_config WHERE id = 1')
      const row = rows[0] as { code: string } | undefined
      return row?.code ?? 'USD'
    })

    const getRefreshCadence = Effect.fn('LedgerConfig.getRefreshCadence')(function* () {
      const rows = yield* sql.unsafe('SELECT value FROM refresh_cadence_config WHERE id = 1')
      const row = rows[0] as { value: string } | undefined
      return row?.value ?? DEFAULT_CADENCE
    })

    const getLedgerMcpStartupMode = Effect.fn('LedgerConfig.getLedgerMcpStartupMode')(function* () {
      const rows = yield* sql.unsafe('SELECT startup_mode FROM ledger_mcp_config WHERE id = 1')
      const row = rows[0] as { startup_mode: unknown } | undefined
      const parsed = Schema.decodeUnknownResult(ledgerMcpStartupModeSchema)(row?.startup_mode)
      return parsed._tag === 'Success' ? parsed.success : 'on-demand'
    })

    const getSkillDismissals = Effect.fn('LedgerConfig.getSkillDismissals')(function* () {
      const rows = yield* sql.unsafe('SELECT source, name, reason, created FROM skills_dismissal_config')
      return [...rows] as SkillsDismissal[]
    })

    const setCurrencyRate = Effect.fn('LedgerConfig.setCurrencyRate')(function* (rate: CurrencyRate) {
      yield* sql.unsafe(
        `
        INSERT INTO currency_rate (code, symbol, rate, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET symbol = excluded.symbol, rate = excluded.rate, updated_at = excluded.updated_at
      `,
        [rate.code, rate.symbol, rate.rate, rate.updatedAt],
      )
    })

    const setDisplayCurrency = Effect.fn('LedgerConfig.setDisplayCurrency')(function* (code: string) {
      yield* sql.unsafe(
        `
        INSERT INTO display_currency_config (id, code) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET code = excluded.code
      `,
        [code],
      )
    })

    const setRefreshCadence = Effect.fn('LedgerConfig.setRefreshCadence')(function* (value: string) {
      yield* sql.unsafe(
        `
        INSERT INTO refresh_cadence_config (id, value) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET value = excluded.value
      `,
        [value],
      )
    })

    const setLedgerMcpStartupMode = Effect.fn('LedgerConfig.setLedgerMcpStartupMode')(function* (
      mode: LedgerMcpStartupMode,
    ) {
      yield* sql.unsafe(
        `
        INSERT INTO ledger_mcp_config (id, startup_mode) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET startup_mode = excluded.startup_mode
      `,
        [mode],
      )
    })

    const dismissSkill = Effect.fn('LedgerConfig.dismissSkill')(function* (
      source: SkillsDismissal['source'],
      name: string,
      reason: string,
      created: string,
    ) {
      yield* sql.unsafe(
        `
        INSERT INTO skills_dismissal_config (source, name, reason, created)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source, name) DO UPDATE SET reason = excluded.reason, created = excluded.created
      `,
        [source, name, reason, created],
      )
    })
    return LedgerConfig.of({
      getModelAliases,
      setModelAlias,
      removeModelAlias,
      getPriceOverrides,
      setPriceOverride,
      removePriceOverride,
      getCurrencyRate,
      setCurrencyRate,
      getDisplayCurrency,
      setDisplayCurrency,
      getRefreshCadence,
      setRefreshCadence,
      getLedgerMcpStartupMode,
      setLedgerMcpStartupMode,
      getSkillDismissals,
      dismissSkill,
    })
  }),
)
