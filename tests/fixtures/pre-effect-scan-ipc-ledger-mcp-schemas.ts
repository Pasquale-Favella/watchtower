import { z } from 'zod'

const scanStageSchema = z.enum(['pricing', 'parse', 'port-in'])
const perProviderPortSchema = z.object({
  provider: z.string(),
  ported: z.number(),
  unchanged: z.number(),
  failed: z.number(),
  unparsed: z.number(),
})
const scanMetadataSchema = z.object({
  scanId: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  portedFiles: z.number(),
  unchangedFiles: z.number(),
  failedFiles: z.number(),
  perProvider: z.array(perProviderPortSchema),
  aborted: z.boolean(),
})

export const preEffectScanContracts = {
  scanOptionsSchema: z.object({
    range: z.object({ start: z.date(), end: z.date() }),
    provider: z.string().optional(),
  }),
  scanStageSchema,
  scanProgressSchema: z.object({
    stage: scanStageSchema,
    provider: z.string().optional(),
    processed: z.number().optional(),
    total: z.number().optional(),
  }),
  perProviderPortSchema,
  scanMetadataSchema,
}

export const preEffectIpcContracts = {
  scanResultSchema: z.object({
    ok: z.boolean(),
    aborted: z.boolean().optional(),
    alreadyRunning: z.boolean().optional(),
    error: z.string().optional(),
  }),
  scanStatusSchema: z.object({ scanned: z.boolean(), metadata: scanMetadataSchema.optional() }),
  settingsInfoSchema: z.object({
    dataDir: z.string(),
    dbSize: z.number(),
    dataDirSize: z.number(),
    cacheDir: z.string(),
    cacheSize: z.number(),
    claudeConfigDirs: z.array(z.string()).optional(),
  }),
  pricingRefreshResultSchema: z.object({ ok: z.boolean(), error: z.string().optional() }),
  storeChangedMessageSchema: scanMetadataSchema,
  rendererNoticeSchema: z.object({
    label: z.string().trim().min(1).max(80),
    location: z.string().trim().min(1).max(120),
  }),
}

export const preEffectLedgerMcpContracts = {
  ledgerMcpStartupModeSchema: z.enum(['on-demand', 'at-launch']),
  ledgerMcpStatusSchema: z.object({
    startupMode: z.enum(['on-demand', 'at-launch']),
    running: z.boolean(),
    url: z.string().nullable(),
  }),
  ledgerMcpConnectionSchema: z.object({ url: z.string(), config: z.string() }),
}
