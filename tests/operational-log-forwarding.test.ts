import { describe, expect, it } from 'vitest'

import { buildScanSummaryRecords } from '../src/main/pipeline/scan.js'
import { fileErrorCode, logFileName, queueLogRecord, takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import { logCodeFor } from '../src/main/operational-log.js'
import { parseSidecarLogLine } from '../src/main/agents/ledger-mcp/sidecar.js'
import { rendererNoticeSchema } from '../src/shared/schemas/ipc.js'
import type { ScanMetadata } from '../src/shared/schemas/scan.js'

function metadata(rows: Array<{ provider: string; ported: number; unchanged: number; failed: number; unparsed: number }>): ScanMetadata {
  return {
    scanId: 'test',
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    portedFiles: rows.reduce((sum, row) => sum + row.ported, 0),
    unchangedFiles: rows.reduce((sum, row) => sum + row.unchanged, 0),
    failedFiles: rows.reduce((sum, row) => sum + row.failed, 0),
    perProvider: rows,
    aborted: false,
  }
}

describe('scan summary records (#128)', () => {
  it('emits finish totals first, then one record per provider with issues', () => {
    const records = buildScanSummaryRecords(metadata([
      { provider: 'clean', ported: 10, unchanged: 5, failed: 0, unparsed: 0 },
      { provider: 'messy', ported: 3, unchanged: 0, failed: 2, unparsed: 4 },
    ]))
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({
      logEvent: 'scan.finish',
      level: 'info',
      fields: { op: 'scan', ported: 13, unparsed: 4, failed: 2 },
    })
    expect(records[1]).toEqual({
      logEvent: 'scan.provider',
      level: 'warn',
      fields: { provider: 'messy', unparsed: 4, failed: 2 },
    })
  })

  it('stays silent beyond finish when every provider is clean', () => {
    const records = buildScanSummaryRecords(metadata([
      { provider: 'clean', ported: 10, unchanged: 5, failed: 0, unparsed: 0 },
    ]))
    expect(records).toEqual([
      { logEvent: 'scan.finish', level: 'info', fields: { op: 'scan', ported: 10, unparsed: 0, failed: 0 } },
    ])
  })

  it('handles a scan with no provider rows', () => {
    const records = buildScanSummaryRecords(metadata([]))
    expect(records).toEqual([
      { logEvent: 'scan.finish', level: 'info', fields: { op: 'scan', ported: 0, unparsed: 0, failed: 0 } },
    ])
  })
})

describe('file-error outbox (#128)', () => {
  it('shares error-code shaping while preserving main and worker precedence', () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    expect(logCodeFor(error)).toBe('failed')
    expect(fileErrorCode(error, 'failed')).toBe('EACCES')
  })

  it('drains queued records in order and empties the queue', () => {
    queueLogRecord({ logEvent: 'scan.file-error', level: 'warn', fields: { op: 'scan', provider: 'x', code: 'a' } })
    queueLogRecord({ logEvent: 'scan.file-error', level: 'warn', fields: { op: 'scan', provider: 'y', code: 'b' } })
    const drained = takeQueuedLogRecords()
    expect(drained).toHaveLength(2)
    expect(drained[0]!.fields['provider']).toBe('x')
    expect(takeQueuedLogRecords()).toHaveLength(0)
  })

  it('basenames paths so usernames never leave the worker', () => {
    // Source paths are native to the running OS, so basename always applies.
    expect(logFileName('/Users/alice/data/sessions.json')).toBe('sessions.json')
    if (process.platform === 'win32') {
      expect(logFileName('C:\\Users\\alice\\data\\s.json')).toBe('s.json')
    }
  })
})

describe('sidecar stderr protocol (#129)', () => {
  it('parses a request-failure line to kind + method + route + code', () => {
    expect(parseSidecarLogLine(JSON.stringify({ level: 50, time: 0, kind: 'request', method: 'POST', route: '/mcp', code: 'failed' }))).toEqual({
      kind: 'request',
      method: 'POST',
      route: '/mcp',
      code: 'failed',
    })
  })

  it('parses a boot-failure line to kind + op + code', () => {
    expect(parseSidecarLogLine(JSON.stringify({ level: 50, time: 0, kind: 'boot', op: 'ledger-mcp-boot', code: 'db-open-failed' }))).toEqual({
      kind: 'boot',
      op: 'ledger-mcp-boot',
      code: 'db-open-failed',
    })
  })

  it('defaults a kind-less line to a request record', () => {
    expect(parseSidecarLogLine(JSON.stringify({ method: 'POST', route: '/mcp', code: 'failed' }))).toMatchObject({
      kind: 'request',
      code: 'failed',
    })
  })

  it('drops non-JSON lines, non-objects, and lines without a code', () => {
    expect(parseSidecarLogLine('Node warning: foo')).toBeNull()
    expect(parseSidecarLogLine('')).toBeNull()
    expect(parseSidecarLogLine('[1,2]')).toBeNull()
    expect(parseSidecarLogLine(JSON.stringify({ method: 'POST', route: '/mcp' }))).toBeNull()
    expect(parseSidecarLogLine(JSON.stringify({ method: '', route: '/mcp', code: 'x' }))).toEqual({
      kind: 'request',
      route: '/mcp',
      code: 'x',
    })
  })

  it('ignores sensitive keys even when the sidecar sends them', () => {
    const parsed = parseSidecarLogLine(JSON.stringify({
      method: 'POST',
      route: '/mcp',
      code: 'failed',
      body: 'secret bytes',
      token: 'Bearer sk-secret',
      prompt: 'do evil',
    }))
    expect(parsed).toEqual({ kind: 'request', method: 'POST', route: '/mcp', code: 'failed' })
  })
})

describe('renderer notice schema (#130)', () => {
  it('accepts a label + location notice', () => {
    expect(rendererNoticeSchema.safeParse({ label: 'scan progress', location: 'sessions' }).success).toBe(true)
  })

  it('rejects empty, missing, and oversized notices', () => {
    expect(rendererNoticeSchema.safeParse({ label: '', location: 'x' }).success).toBe(false)
    expect(rendererNoticeSchema.safeParse({ label: 'x' }).success).toBe(false)
    expect(rendererNoticeSchema.safeParse({ label: 'x'.repeat(81), location: 'y' }).success).toBe(false)
    expect(rendererNoticeSchema.safeParse({ label: 'x', location: 'y'.repeat(121) }).success).toBe(false)
    expect(rendererNoticeSchema.safeParse('nope').success).toBe(false)
  })
})
