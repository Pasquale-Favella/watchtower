import { z } from 'zod'
import { scanMetadataSchema, scanProgressSchema } from './scan.js'
import { ledgerMcpConnectionSchema, ledgerMcpStatusSchema, type LedgerMcpConnection, type LedgerMcpStatus } from './ledger-mcp.js'

export { ledgerMcpConnectionSchema, ledgerMcpStatusSchema }
export type { LedgerMcpConnection, LedgerMcpStatus }

/** The preload's `scan:progress` message — the same `ScanProgress` the scan
 * emits (its `stage` is the shared enum, not a free string). */
export const scanProgressMessageSchema = scanProgressSchema
export type ScanProgressMessage = z.infer<typeof scanProgressMessageSchema>

/** The preload's scan-result envelope over `scan:start`. A scan already
 * running is not a failure — its own progress/store:changed events land on
 * their own. */
export const scanResultSchema = z.object({
  ok: z.boolean(),
  aborted: z.boolean().optional(),
  alreadyRunning: z.boolean().optional(),
  error: z.string().optional(),
})
export type ScanResult = z.infer<typeof scanResultSchema>

/** `getScanStatus()` — the latest completed scan's metadata, or a "never
 * scanned" sentinel when the ledger has no rows at all (ADR 0004). */
export const scanStatusSchema = z.object({
  scanned: z.boolean(),
  metadata: scanMetadataSchema.optional(),
})
export type ScanStatus = z.infer<typeof scanStatusSchema>

export const settingsInfoSchema = z.object({
  dataDir: z.string(),
  dbSize: z.number(),
  dataDirSize: z.number(),
  cacheDir: z.string(),
  cacheSize: z.number(),
  /** Claude config dirs the scanner aggregates; absent when unresolvable, in
   * which case the General pane hides the Claude-config row entirely. */
  claudeConfigDirs: z.array(z.string()).optional(),
})
export type SettingsInfo = z.infer<typeof settingsInfoSchema>

export const pricingRefreshResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
})
export type PricingRefreshResult = z.infer<typeof pricingRefreshResultSchema>

/** `store:changed` carries the completed scan's metadata (ADR 0004) —
 * the same object `runScan` returns. */
export const storeChangedMessageSchema = scanMetadataSchema
export type StoreChangedMessage = z.infer<typeof storeChangedMessageSchema>

/** Renderer tripwire forward (#130): a dropped subscription payload. Label
 * names the channel, location the failing field path — short static strings
 * only, never payload contents. Length-capped so a hostile shape can't flood
 * the log through a long path. */
export const rendererNoticeSchema = z.object({
  label: z.string().trim().min(1).max(80),
  location: z.string().trim().min(1).max(120),
})
export type RendererNotice = z.infer<typeof rendererNoticeSchema>
