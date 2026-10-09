import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import * as ipc from '../src/shared/schemas/ipc.js'
import * as ledgerMcp from '../src/shared/schemas/ledger-mcp.js'
import * as scan from '../src/shared/schemas/scan.js'

function assertAccepted(current: Schema.ConstraintDecoder<unknown>, input: unknown, expected: unknown): void {
  const result = Schema.decodeUnknownResult(current)(input)
  expect(result._tag).toBe('Success')
  if (result._tag === 'Success') expect(result.success).toStrictEqual(expected)
}

function assertRejected(current: Schema.ConstraintDecoder<unknown>, input: unknown): void {
  expect(Schema.decodeUnknownResult(current)(input)._tag).toBe('Failure')
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
  ['scan options', scan.scanOptionsSchema, scanOptions, null],
  ['scan stage', scan.scanStageSchema, 'port-in', null],
  ['scan progress', scan.scanProgressSchema, progress, ['processed']],
  ['provider port', scan.perProviderPortSchema, providerPort, ['failed']],
  ['scan metadata', scan.scanMetadataSchema, metadata, ['portedFiles']],
  ['scan result', ipc.scanResultSchema, { ok: true, aborted: false }, null],
  ['scan status', ipc.scanStatusSchema, { scanned: true, metadata }, null],
  [
    'settings info',
    ipc.settingsInfoSchema,
    { dataDir: '/data', dbSize: 1, dataDirSize: 2, cacheDir: '/cache', cacheSize: 3, claudeConfigDirs: ['/claude'] },
    ['dbSize'],
  ],
  ['pricing refresh result', ipc.pricingRefreshResultSchema, { ok: false, error: 'offline' }, null],
  ['store changed', ipc.storeChangedMessageSchema, metadata, ['failedFiles']],
  ['renderer notice', ipc.rendererNoticeSchema, { label: 'scan progress', location: 'sessions' }, null],
  ['ledger MCP startup mode', ledgerMcp.ledgerMcpStartupModeSchema, 'at-launch', null],
  ['ledger MCP status', ledgerMcp.ledgerMcpStatusSchema, { startupMode: 'on-demand', running: true, url: null }, null],
  ['ledger MCP connection', ledgerMcp.ledgerMcpConnectionSchema, { url: 'http://localhost:1', config: '{}' }, null],
] as const

describe('scan, IPC, and ledger MCP Effect Schema parity', () => {
  it.each(contracts)(
    '%s decodes the expected value, rejects invalid values, and strips unknown keys',
    (_name, schema, sample, numberPath) => {
      assertAccepted(schema, sample, sample)
      if (typeof sample === 'object' && sample !== null && !Array.isArray(sample)) {
        assertAccepted(schema, { ...sample, unknownExtension: true }, sample)
      }
      assertRejected(schema, { invalid: true })

      if (numberPath) {
        const key = numberPath[0]
        if (key === undefined) return
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          const invalid = { ...(sample as Record<string, unknown>), [key]: value }
          assertRejected(schema, invalid)
        }
      }
    },
  )

  it('preserves optional missing, undefined, and null behavior', () => {
    assertAccepted(scan.scanOptionsSchema, scanOptions, scanOptions)
    assertAccepted(
      scan.scanOptionsSchema,
      {
        ...scanOptions,
        provider: undefined,
      },
      { ...scanOptions, provider: undefined },
    )
    assertRejected(scan.scanOptionsSchema, { ...scanOptions, provider: null })
    assertAccepted(
      scan.scanProgressSchema,
      {
        stage: 'parse',
        total: undefined,
      },
      { stage: 'parse', total: undefined },
    )
    assertAccepted(ipc.scanResultSchema, { ok: true, error: undefined }, { ok: true, error: undefined })
    assertAccepted(
      ipc.scanStatusSchema,
      { scanned: false, metadata: undefined },
      { scanned: false, metadata: undefined },
    )
    assertRejected(ipc.scanStatusSchema, { scanned: false, metadata: null })
    assertAccepted(
      ipc.settingsInfoSchema,
      {
        dataDir: '/data',
        dbSize: 1,
        dataDirSize: 2,
        cacheDir: '/cache',
        cacheSize: 3,
        claudeConfigDirs: undefined,
      },
      {
        dataDir: '/data',
        dbSize: 1,
        dataDirSize: 2,
        cacheDir: '/cache',
        cacheSize: 3,
        claudeConfigDirs: undefined,
      },
    )
    assertRejected(ipc.settingsInfoSchema, {
      dataDir: '/data',
      dbSize: 1,
      dataDirSize: 2,
      cacheDir: '/cache',
      cacheSize: 3,
      claudeConfigDirs: null,
    })
    assertAccepted(
      ipc.pricingRefreshResultSchema,
      {
        ok: true,
        error: undefined,
      },
      { ok: true, error: undefined },
    )
  })

  it('rejects invalid scan and ledger MCP enum values', () => {
    assertRejected(scan.scanStageSchema, 'unknown')
    assertRejected(scan.scanProgressSchema, { ...progress, stage: 'unknown' })
    assertRejected(ledgerMcp.ledgerMcpStartupModeSchema, 'never')
    assertRejected(ledgerMcp.ledgerMcpStatusSchema, {
      startupMode: 'never',
      running: false,
      url: null,
    })
  })

  it('preserves real Date acceptance and invalid Date rejection', () => {
    assertAccepted(scan.scanOptionsSchema, scanOptions, scanOptions)
    assertRejected(scan.scanOptionsSchema, {
      range: { start: new Date(Number.NaN), end: dateEnd },
    })
    assertRejected(scan.scanOptionsSchema, {
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
