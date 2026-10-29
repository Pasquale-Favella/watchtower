import * as Schema from 'effect/Schema'

import { fileVerdictSchema } from '@/shared/schemas/port.js'
import { cachedFileSchema } from '@/shared/schemas/session-cache.js'

const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))
const finiteNumber = Schema.Finite

export const scanOptionsSchema = Schema.Struct({
  range: writable(
    Schema.Struct({
      start: writable(Schema.Date),
      end: writable(Schema.Date),
    }),
  ),
  provider: writable(Schema.optional(Schema.String)),
})
export type ScanOptions = Schema.Schema.Type<typeof scanOptionsSchema>

export const scanStageSchema = Schema.Literals(['pricing', 'parse', 'port-in'])
export type ScanStage = Schema.Schema.Type<typeof scanStageSchema>

/** Pipeline order of the scan stages, for "has the scan reached stage X". */
export const SCAN_STAGE_ORDER: Record<ScanStage, number> = { pricing: 0, parse: 1, 'port-in': 2 }

export const scanProgressSchema = Schema.Struct({
  stage: writable(scanStageSchema),
  provider: writable(Schema.optional(Schema.String)),
  processed: writable(Schema.optional(finiteNumber)),
  total: writable(Schema.optional(finiteNumber)),
})
export type ScanProgress = Schema.Schema.Type<typeof scanProgressSchema>

export const perProviderPortSchema = Schema.Struct({
  provider: writable(Schema.String),
  /** Files ported (new/appended/modified deltas forwarded). */
  ported: writable(finiteNumber),
  /** Files whose content was unchanged (delta forwarded as a no-op). */
  unchanged: writable(finiteNumber),
  /** Files that failed to parse (counted; their delta is not forwarded). */
  failed: writable(finiteNumber),
  /** Rows/blobs skipped because a declared field failed its extraction schema
   * (schema-drift signal, never fatal). Surfaced so provider drift is visible. */
  unparsed: writable(finiteNumber),
})
export type PerProviderPort = Schema.Schema.Type<typeof perProviderPortSchema>

export const scanMetadataSchema = Schema.Struct({
  scanId: writable(Schema.String),
  startedAt: writable(Schema.String),
  completedAt: writable(Schema.String),
  /** Files ported into the ledger (new/appended/modified deltas forwarded). */
  portedFiles: writable(finiteNumber),
  /** Files whose content was unchanged (delta forwarded as a no-op). */
  unchangedFiles: writable(finiteNumber),
  /** Files that failed to parse (counted; their delta is not forwarded). */
  failedFiles: writable(finiteNumber),
  perProvider: writable(mutableArray(perProviderPortSchema)),
  aborted: writable(Schema.Boolean),
})
export type ScanMetadata = Schema.Schema.Type<typeof scanMetadataSchema>

/** The per-file reconcile verdict, mirrored from the store's `FileVerdict` so
 * the parse pipeline never imports the store (producer → consumer layering). */
export const scanDeltaVerdictSchema = fileVerdictSchema
export type ScanDeltaVerdict = Schema.Schema.Type<typeof scanDeltaVerdictSchema>

export const scanDeltaSchema = Schema.Struct({
  provider: writable(Schema.String),
  envFingerprint: writable(Schema.String),
  filePath: writable(Schema.String),
  verdict: writable(scanDeltaVerdictSchema),
  cachedFile: writable(cachedFileSchema),
  durable: writable(Schema.optional(Schema.Boolean)),
  project: writable(Schema.optional(Schema.String)),
  workingDirectory: writable(Schema.optional(Schema.String)),
})
export type ScanDelta = Schema.Schema.Type<typeof scanDeltaSchema>
