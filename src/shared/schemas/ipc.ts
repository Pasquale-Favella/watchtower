import { z } from 'zod'
import { scanMetadataSchema, scanProgressSchema } from './scan.js'

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
 * scanned" sentinel when the ledger has no rows at all (map ticket 05). */
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

/** `store:changed` carries the completed scan's metadata (map ticket 05) —
 * the same object `runScan` returns. */
export const storeChangedMessageSchema = scanMetadataSchema
export type StoreChangedMessage = z.infer<typeof storeChangedMessageSchema>
