import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type {
  CurrencyRate,
  LedgerCallRow,
  LedgerSessionRow,
  LedgerSourceRow,
  LedgerTurnRow,
  ModelAlias,
  PortResult,
  PriceOverride,
} from '../../shared/schemas/ledger.js'
import type { LedgerMcpStartupMode } from '../../shared/schemas/ledger-mcp.js'
import type { PortInput } from '../../shared/schemas/port.js'
import type { SkillsDismissal } from '../../shared/schemas/skills.js'
import type { ScanPricing } from '../pipeline/scan-pricing.js'
import type { LedgerCallFactsRow } from './read-projections.js'

/** Scan-derived fact writes and source removal. */
export interface LedgerIngestPort {
  portIn(input: PortInput, pricing?: ScanPricing): Effect.Effect<PortResult, SqlError>
  deleteSource(provider: string, envFingerprint: string, filePath: string): Effect.Effect<void, SqlError>
  clear(): Effect.Effect<void, SqlError>
}

/** Decoded ledger facts and one consistent request snapshot. */
export type LedgerRequestSnapshotData = {
  sources: LedgerSourceRow[]
  sessions: LedgerSessionRow[]
  turns: LedgerTurnRow[]
  calls: LedgerCallFactsRow[]
  aliases: ModelAlias[]
  overrides: PriceOverride[]
}

export interface LedgerQueriesPort {
  hasSources(): Effect.Effect<boolean, SqlError>
  getSources(): Effect.Effect<LedgerSourceRow[], SqlError | Schema.SchemaError>
  getSessions(): Effect.Effect<LedgerSessionRow[], SqlError | Schema.SchemaError>
  getTurns(): Effect.Effect<LedgerTurnRow[], SqlError | Schema.SchemaError>
  getCalls(): Effect.Effect<LedgerCallRow[], SqlError | Schema.SchemaError>
  getCallFacts(): Effect.Effect<LedgerCallFactsRow[], SqlError | Schema.SchemaError>
  getRequestSnapshotData(): Effect.Effect<LedgerRequestSnapshotData, SqlError | Schema.SchemaError>
}

/** User settings that survive ledger clearing. */
export interface LedgerConfigPort {
  getModelAliases(): Effect.Effect<ModelAlias[], SqlError | Schema.SchemaError>
  setModelAlias(model: string, aliasOf: string): Effect.Effect<void, SqlError>
  removeModelAlias(model: string): Effect.Effect<void, SqlError>
  getPriceOverrides(): Effect.Effect<PriceOverride[], SqlError | Schema.SchemaError>
  setPriceOverride(model: string, override: Omit<PriceOverride, 'model'>): Effect.Effect<void, SqlError>
  removePriceOverride(model: string): Effect.Effect<void, SqlError>
  getCurrencyRate(code: string): Effect.Effect<CurrencyRate | null, SqlError | Schema.SchemaError>
  setCurrencyRate(rate: CurrencyRate): Effect.Effect<void, SqlError>
  getDisplayCurrency(): Effect.Effect<string, SqlError>
  setDisplayCurrency(code: string): Effect.Effect<void, SqlError>
  getRefreshCadence(): Effect.Effect<string, SqlError>
  setRefreshCadence(value: string): Effect.Effect<void, SqlError>
  getLedgerMcpStartupMode(): Effect.Effect<LedgerMcpStartupMode, SqlError>
  setLedgerMcpStartupMode(mode: LedgerMcpStartupMode): Effect.Effect<void, SqlError>
  getSkillDismissals(): Effect.Effect<SkillsDismissal[], SqlError>
  dismissSkill(
    source: SkillsDismissal['source'],
    name: string,
    reason: string,
    created: string,
  ): Effect.Effect<void, SqlError>
}

export class LedgerIngest extends Context.Service<LedgerIngest, LedgerIngestPort>()('watchtower/store/LedgerIngest') {}

export class LedgerQueries extends Context.Service<LedgerQueries, LedgerQueriesPort>()(
  'watchtower/store/LedgerQueries',
) {}

export class LedgerConfig extends Context.Service<LedgerConfig, LedgerConfigPort>()('watchtower/store/LedgerConfig') {}
