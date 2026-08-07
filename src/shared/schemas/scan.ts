import { z } from 'zod'
import { cachedFileSchema } from './session-cache.js'
import { fileVerdictSchema } from './port.js'

export const scanOptionsSchema = z.object({
  range: z.object({
    start: z.date(),
    end: z.date(),
  }),
  provider: z.string().optional(),
})
export type ScanOptions = z.infer<typeof scanOptionsSchema>

export const scanStageSchema = z.enum(['pricing', 'parse', 'port-in'])
export type ScanStage = z.infer<typeof scanStageSchema>

export const scanProgressSchema = z.object({
  stage: scanStageSchema,
  provider: z.string().optional(),
  processed: z.number().optional(),
  total: z.number().optional(),
})
export type ScanProgress = z.infer<typeof scanProgressSchema>

export const perProviderPortSchema = z.object({
  provider: z.string(),
  /** Files ported (new/appended/modified deltas forwarded). */
  ported: z.number(),
  /** Files whose content was unchanged (delta forwarded as a no-op). */
  unchanged: z.number(),
  /** Files that failed to parse (counted; their delta is not forwarded). */
  failed: z.number(),
  /** Rows/blobs skipped because a declared field failed its extraction schema
   * (schema-drift signal, never fatal). Surfaced so provider drift is visible. */
  unparsed: z.number(),
})
export type PerProviderPort = z.infer<typeof perProviderPortSchema>

export const scanMetadataSchema = z.object({
  scanId: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  /** Files ported into the ledger (new/appended/modified deltas forwarded). */
  portedFiles: z.number(),
  /** Files whose content was unchanged (delta forwarded as a no-op). */
  unchangedFiles: z.number(),
  /** Files that failed to parse (counted; their delta is not forwarded). */
  failedFiles: z.number(),
  perProvider: z.array(perProviderPortSchema),
  aborted: z.boolean(),
})
export type ScanMetadata = z.infer<typeof scanMetadataSchema>

/** The per-file reconcile verdict, mirrored from the store's `FileVerdict` so
 * the parse pipeline never imports the store (producer → consumer layering). */
export const scanDeltaVerdictSchema = fileVerdictSchema
export type ScanDeltaVerdict = z.infer<typeof scanDeltaVerdictSchema>

export const scanDeltaSchema = z.object({
  provider: z.string(),
  envFingerprint: z.string(),
  filePath: z.string(),
  verdict: scanDeltaVerdictSchema,
  cachedFile: cachedFileSchema,
  durable: z.boolean().optional(),
  project: z.string().optional(),
  workingDirectory: z.string().optional(),
})
export type ScanDelta = z.infer<typeof scanDeltaSchema>
