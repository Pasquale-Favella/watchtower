import * as Schema from 'effect/Schema'

import {
  type LedgerMcpConnection,
  ledgerMcpConnectionSchema,
  type LedgerMcpStatus,
  ledgerMcpStatusSchema,
} from './ledger-mcp.js'
import { scanMetadataSchema, scanProgressSchema } from './scan.js'

const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))
const finiteNumber = Schema.Finite

export { ledgerMcpConnectionSchema, ledgerMcpStatusSchema }
export type { LedgerMcpConnection, LedgerMcpStatus }

/** The preload's `scan:progress` message — the same `ScanProgress` the scan
 * emits (its `stage` is the shared enum, not a free string). */
export const scanProgressMessageSchema = scanProgressSchema
export type ScanProgressMessage = Schema.Schema.Type<typeof scanProgressMessageSchema>

/** The preload's scan-result envelope over `scan:start`. A scan already
 * running is not a failure — its own progress/store:changed events land on
 * their own. */
export const scanResultSchema = Schema.Struct({
  ok: writable(Schema.Boolean),
  aborted: writable(Schema.optional(Schema.Boolean)),
  alreadyRunning: writable(Schema.optional(Schema.Boolean)),
  error: writable(Schema.optional(Schema.String)),
})
export type ScanResult = Schema.Schema.Type<typeof scanResultSchema>

/** `getScanStatus()` — the latest completed scan's metadata, or a "never
 * scanned" sentinel when the ledger has no rows at all (ADR 0004). */
export const scanStatusSchema = Schema.Struct({
  scanned: writable(Schema.Boolean),
  metadata: writable(Schema.optional(scanMetadataSchema)),
})
export type ScanStatus = Schema.Schema.Type<typeof scanStatusSchema>

export const settingsInfoSchema = Schema.Struct({
  dataDir: writable(Schema.String),
  dbSize: writable(finiteNumber),
  dataDirSize: writable(finiteNumber),
  cacheDir: writable(Schema.String),
  cacheSize: writable(finiteNumber),
  /** Claude config dirs the scanner aggregates; absent when unresolvable, in
   * which case the General pane hides the Claude-config row entirely. */
  claudeConfigDirs: writable(Schema.optional(mutableArray(Schema.String))),
})
export type SettingsInfo = Schema.Schema.Type<typeof settingsInfoSchema>

export const pricingRefreshResultSchema = Schema.Struct({
  ok: writable(Schema.Boolean),
  error: writable(Schema.optional(Schema.String)),
})
export type PricingRefreshResult = Schema.Schema.Type<typeof pricingRefreshResultSchema>

/** `store:changed` carries the completed scan's metadata (ADR 0004) —
 * the same object `runScan` returns. */
export const storeChangedMessageSchema = scanMetadataSchema
export type StoreChangedMessage = Schema.Schema.Type<typeof storeChangedMessageSchema>

const noticeLabelSchema = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(80)))
const noticeLocationSchema = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(120)))

/** Renderer tripwire forward (#130): a dropped subscription payload. Label
 * names the channel, location the failing field path — short static strings
 * only, never payload contents. Length-capped so a hostile shape can't flood
 * the log through a long path. */
export const rendererNoticeSchema = Schema.Struct({
  label: writable(noticeLabelSchema),
  location: writable(noticeLocationSchema),
})
export type RendererNotice = Schema.Schema.Type<typeof rendererNoticeSchema>
