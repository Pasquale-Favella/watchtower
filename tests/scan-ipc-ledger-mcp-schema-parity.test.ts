import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import * as ipc from '../src/shared/schemas/ipc.js'
import * as ledgerMcp from '../src/shared/schemas/ledger-mcp.js'
import * as scan from '../src/shared/schemas/scan.js'
import {
  preEffectIpcContracts,
  preEffectLedgerMcpContracts,
  preEffectScanContracts,
} from './fixtures/pre-effect-scan-ipc-ledger-mcp-schemas.js'

type LegacySchema = { safeParse: (input: unknown) => { success: boolean; data?: unknown } }

function assertParity(legacy: LegacySchema, current: Schema.ConstraintDecoder<unknown>, input: unknown): void {
  const before = legacy.safeParse(input)
  const after = Schema.decodeUnknownResult(current)(input)
  expect(after._tag === 'Success').toBe(before.success)
  if (before.success && after._tag === 'Success') expect(after.success).toStrictEqual(before.data)
}

const dateStart = new Date('2026-01-01T00:00:00.000Z')
const dateEnd = new Date('2026-01-02T00:00:00.000Z')
const scanOptions = { range: { start: dateStart, end: dateEnd } }
const progress = { stage: 'parse', provider: 'claude', processed: 2, total: 5 }
const providerPort = { provider: 'claude', ported: 1, unchanged: 2, failed: 3, unparsed: 4 }
const metadata = {
  scanId: 'scan-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:01:00.000Z',
  portedFiles: 1,
  unchangedFiles: 2,
  failedFiles: 3,
  perProvider: [providerPort],
  aborted: false,
}

const contracts = [
  ['scan options', preEffectScanContracts.scanOptionsSchema, scan.scanOptionsSchema, scanOptions, null],
  ['scan stage', preEffectScanContracts.scanStageSchema, scan.scanStageSchema, 'port-in', null],
  ['scan progress', preEffectScanContracts.scanProgressSchema, scan.scanProgressSchema, progress, ['processed']],
  ['provider port', preEffectScanContracts.perProviderPortSchema, scan.perProviderPortSchema, providerPort, ['failed']],
  ['scan metadata', preEffectScanContracts.scanMetadataSchema, scan.scanMetadataSchema, metadata, ['portedFiles']],
  ['scan result', preEffectIpcContracts.scanResultSchema, ipc.scanResultSchema, { ok: true, aborted: false }, null],
  ['scan status', preEffectIpcContracts.scanStatusSchema, ipc.scanStatusSchema, { scanned: true, metadata }, null],
  [
    'settings info',
    preEffectIpcContracts.settingsInfoSchema,
    ipc.settingsInfoSchema,
    { dataDir: '/data', dbSize: 1, dataDirSize: 2, cacheDir: '/cache', cacheSize: 3, claudeConfigDirs: ['/claude'] },
    ['dbSize'],
  ],
  [
    'pricing refresh result',
    preEffectIpcContracts.pricingRefreshResultSchema,
    ipc.pricingRefreshResultSchema,
    { ok: false, error: 'offline' },
    null,
  ],
  [
    'store changed',
    preEffectIpcContracts.storeChangedMessageSchema,
    ipc.storeChangedMessageSchema,
    metadata,
    ['failedFiles'],
  ],
  [
    'renderer notice',
    preEffectIpcContracts.rendererNoticeSchema,
    ipc.rendererNoticeSchema,
    { label: 'scan progress', location: 'sessions' },
    null,
  ],
  [
    'ledger MCP startup mode',
    preEffectLedgerMcpContracts.ledgerMcpStartupModeSchema,
    ledgerMcp.ledgerMcpStartupModeSchema,
    'at-launch',
    null,
  ],
  [
    'ledger MCP status',
    preEffectLedgerMcpContracts.ledgerMcpStatusSchema,
    ledgerMcp.ledgerMcpStatusSchema,
    { startupMode: 'on-demand', running: true, url: null },
    null,
  ],
  [
    'ledger MCP connection',
    preEffectLedgerMcpContracts.ledgerMcpConnectionSchema,
    ledgerMcp.ledgerMcpConnectionSchema,
    { url: 'http://localhost:1', config: '{}' },
    null,
  ],
] as const

describe('scan, IPC, and ledger MCP Effect Schema parity', () => {
  it.each(contracts)(
    '%s preserves decoded output, verdicts, and unknown-key stripping',
    (_name, before, after, sample, numberPath) => {
      assertParity(before, after, sample)
      if (typeof sample === 'object' && sample !== null && !Array.isArray(sample)) {
        assertParity(before, after, { ...sample, unknownExtension: true })
      }
      assertParity(before, after, { invalid: true })

      if (numberPath) {
        const key = numberPath[0]
        if (key === undefined) return
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          const invalid = { ...(sample as Record<string, unknown>), [key]: value }
          assertParity(before, after, invalid)
        }
      }
    },
  )

  it('preserves optional missing, undefined, and null behavior', () => {
    assertParity(preEffectScanContracts.scanOptionsSchema, scan.scanOptionsSchema, scanOptions)
    assertParity(preEffectScanContracts.scanOptionsSchema, scan.scanOptionsSchema, {
      ...scanOptions,
      provider: undefined,
    })
    assertParity(preEffectScanContracts.scanOptionsSchema, scan.scanOptionsSchema, { ...scanOptions, provider: null })
    assertParity(preEffectScanContracts.scanProgressSchema, scan.scanProgressSchema, {
      stage: 'parse',
      total: undefined,
    })
    assertParity(preEffectIpcContracts.scanResultSchema, ipc.scanResultSchema, { ok: true, error: undefined })
    assertParity(preEffectIpcContracts.scanStatusSchema, ipc.scanStatusSchema, { scanned: false, metadata: undefined })
    assertParity(preEffectIpcContracts.scanStatusSchema, ipc.scanStatusSchema, { scanned: false, metadata: null })
    assertParity(preEffectIpcContracts.settingsInfoSchema, ipc.settingsInfoSchema, {
      dataDir: '/data',
      dbSize: 1,
      dataDirSize: 2,
      cacheDir: '/cache',
      cacheSize: 3,
      claudeConfigDirs: undefined,
    })
    assertParity(preEffectIpcContracts.settingsInfoSchema, ipc.settingsInfoSchema, {
      dataDir: '/data',
      dbSize: 1,
      dataDirSize: 2,
      cacheDir: '/cache',
      cacheSize: 3,
      claudeConfigDirs: null,
    })
    assertParity(preEffectIpcContracts.pricingRefreshResultSchema, ipc.pricingRefreshResultSchema, {
      ok: true,
      error: undefined,
    })
  })

  it('rejects invalid scan and ledger MCP enum values', () => {
    assertParity(preEffectScanContracts.scanStageSchema, scan.scanStageSchema, 'unknown')
    assertParity(preEffectScanContracts.scanProgressSchema, scan.scanProgressSchema, { ...progress, stage: 'unknown' })
    assertParity(preEffectLedgerMcpContracts.ledgerMcpStartupModeSchema, ledgerMcp.ledgerMcpStartupModeSchema, 'never')
    assertParity(preEffectLedgerMcpContracts.ledgerMcpStatusSchema, ledgerMcp.ledgerMcpStatusSchema, {
      startupMode: 'never',
      running: false,
      url: null,
    })
  })

  it('preserves real Date acceptance and invalid Date rejection', () => {
    assertParity(preEffectScanContracts.scanOptionsSchema, scan.scanOptionsSchema, scanOptions)
    assertParity(preEffectScanContracts.scanOptionsSchema, scan.scanOptionsSchema, {
      range: { start: new Date(Number.NaN), end: dateEnd },
    })
    assertParity(preEffectScanContracts.scanOptionsSchema, scan.scanOptionsSchema, {
      range: { start: dateStart.toISOString(), end: dateEnd },
    })
  })

  it('trims renderer notices and keeps decoded arrays and fields writable', () => {
    const notice = Schema.decodeUnknownSync(ipc.rendererNoticeSchema)({
      label: '  scan progress ',
      location: ' sessions  ',
    })
    expect(notice).toEqual({ label: 'scan progress', location: 'sessions' })
    notice.label = 'changed'

    const decoded = Schema.decodeUnknownSync(scan.scanMetadataSchema)(metadata)
    decoded.perProvider.push({ provider: 'codex', ported: 0, unchanged: 0, failed: 0, unparsed: 0 })
    decoded.aborted = true
    expect(decoded.perProvider).toHaveLength(2)
    expect(decoded.aborted).toBe(true)
  })
})
