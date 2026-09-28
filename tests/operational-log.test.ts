import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  closeOperationalLog,
  FETCH_TIMEOUT_COUNTER,
  initOperationalLog,
  logIpcError,
  logOperationalEvent,
  OperationalLog,
  OperationalLogLoggerLayer,
  type OperationalLogSink,
  PROBE_OUTCOME_COUNTER,
  safeLogOperationalEvent,
  SCAN_DURATION_COUNTER,
} from '../src/main/operational-log.js'
import { sanitizeOperationalRecord } from '../src/shared/logging.js'

let dir = ''

afterEach(() => {
  try {
    closeOperationalLog()
  } catch {
    /* not initialised */
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function tempLogDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'watchtower-oplog-'))
  return join(dir, 'logs')
}

function readLines(logDir: string): string[] {
  const files = readdirSync(logDir).filter(f => f.startsWith('operational'))
  const lines: string[] = []
  for (const file of files) {
    const text = readFileSync(join(logDir, file), 'utf8')
    lines.push(...text.split('\n').filter(l => l.trim().length > 0))
  }
  return lines
}

describe('Operational log main sink (pino, slice 1)', () => {
  it('writes parseable JSON lines with level, context, event and fields', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    logOperationalEvent('info', 'boot.ready', { op: 'test' })
    closeOperationalLog()
    const lines = readLines(logDir)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed['level']).toBe('info')
    expect(parsed['context']).toBe('main')
    expect(parsed['event']).toBe('boot.ready')
    expect(parsed['op']).toBe('test')
    expect(parsed['time']).toBeDefined()
  })

  it('drops non-allowlisted fields before emission (prompts, paths, facts, tokens)', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    logOperationalEvent('info', 'test', {
      op: 'test',
      prompt: 'secret prompt body',
      filePath: '/Users/alice/secret.txt',
      ledgerFact: 'total spend $456.78',
      token: 'Bearer sk-secret',
      body: { prompt: 'nested bytes' },
    })
    closeOperationalLog()
    const lines = readLines(logDir)
    expect(lines).toHaveLength(1)
    const text = lines[0]!
    expect(text).not.toContain('secret prompt body')
    expect(text).not.toContain('alice')
    expect(text).not.toContain('456.78')
    expect(text).not.toContain('sk-secret')
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(parsed['op']).toBe('test')
    expect(parsed).not.toHaveProperty('prompt')
    expect(parsed).not.toHaveProperty('filePath')
    expect(parsed).not.toHaveProperty('ledgerFact')
  })

  it('drops debug in packaged builds but keeps it in development', async () => {
    const prodDir = tempLogDir()
    await initOperationalLog({ logDir: prodDir, isPackaged: true })
    logOperationalEvent('debug', 'debug.note', {})
    logOperationalEvent('info', 'boot.ready', {})
    closeOperationalLog()
    expect(readLines(prodDir)).toHaveLength(1)

    rmSync(dir, { recursive: true, force: true })
    const devDir = tempLogDir()
    await initOperationalLog({ logDir: devDir, isPackaged: false })
    logOperationalEvent('debug', 'debug.note', {})
    closeOperationalLog()
    expect(readLines(devDir)).toHaveLength(1)
  })

  it('records IPC failures with op and code only', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    logIpcError('overview:query', new TypeError('boom'))
    closeOperationalLog()
    const lines = readLines(logDir)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed['context']).toBe('main')
    expect(parsed['event']).toBe('ipc.error')
    expect(parsed['op']).toBe('overview:query')
    expect(parsed['code']).toBe('type')
    expect(JSON.stringify(parsed)).not.toContain('boom')
  })

  it('stamps the forwarder context and falls back to main for unknown values', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    safeLogOperationalEvent('info', 'scan.start', { op: 'scan' }, 'worker')
    safeLogOperationalEvent('error', 'sidecar.request', { method: 'POST', route: '/mcp', code: 'failed' }, 'sidecar')
    safeLogOperationalEvent('warn', 'renderer.notice', { label: 'scan progress', location: 'sessions' }, 'renderer')
    logOperationalEvent('info', 'x', {}, 'kernel' as 'main')
    closeOperationalLog()
    const parsed = readLines(logDir).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(parsed.map(record => record['context'])).toEqual(['worker', 'sidecar', 'renderer', 'main'])
    expect(parsed[1]).toMatchObject({ event: 'sidecar.request', method: 'POST', route: '/mcp', code: 'failed' })
  })

  it('passes finite counts and caps hostile string lengths', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    logOperationalEvent('info', 'scan.finish', { op: 'scan', ported: 12, unparsed: 3, failed: 0 })
    logOperationalEvent('info', 'scan.finish', { op: 'scan', ported: Number.NaN, unparsed: -1 })
    logOperationalEvent('info', 'test', { op: 'test', label: `x${'y'.repeat(500)}` })
    closeOperationalLog()
    const parsed = readLines(logDir).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(parsed[0]).toMatchObject({ ported: 12, unparsed: 3, failed: 0 })
    expect(parsed[1]).not.toHaveProperty('ported')
    expect(parsed[1]).not.toHaveProperty('unparsed')
    expect(String(parsed[2]!['label'])).toHaveLength(200)
  })

  it('reduces allowlisted file fields to basenames', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    logOperationalEvent('warn', 'scan.file-error', { file: 'C:\\Users\\alice\\sessions.json' })
    logOperationalEvent('warn', 'scan.file-error', { file: '/Users/alice/sessions.json' })
    closeOperationalLog()
    const parsed = readLines(logDir).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(parsed.map(record => record['file'])).toEqual(['sessions.json', 'sessions.json'])
    expect(readLines(logDir).join('\n')).not.toContain('alice')
  })

  it('files closed-vocabulary counter dimensions and drops non-members (prompts, paths, facts)', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    // The three counter dimensions as their call sites actually emit them.
    logOperationalEvent('info', SCAN_DURATION_COUNTER, { op: 'scan', outcome: 'success', count: 12 })
    logOperationalEvent('info', PROBE_OUTCOME_COUNTER, { kind: 'claude', status: 'warning', count: 1 })
    logOperationalEvent('info', FETCH_TIMEOUT_COUNTER, { reason: 'timeout', count: 1 })
    // Same keys, values outside the vocabulary: each dimension is dropped
    // whole — a closed vocabulary is not a wider door, it is a shorter list.
    logOperationalEvent('info', SCAN_DURATION_COUNTER, { op: 'scan', outcome: 'skipped, user pressed stop', count: 1 })
    logOperationalEvent('info', PROBE_OUTCOME_COUNTER, { kind: 'claude', status: 'ready — total spend $456.78' })
    logOperationalEvent('info', FETCH_TIMEOUT_COUNTER, {
      reason: 'timeout reading C:\\Users\\alice\\.claude\\token.json',
    })
    closeOperationalLog()
    const lines = readLines(logDir)
    const text = lines.join('\n')
    const parsed = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(parsed).toHaveLength(6)
    expect(parsed[0]).toMatchObject({ event: SCAN_DURATION_COUNTER, op: 'scan', outcome: 'success', count: 12 })
    expect(parsed[1]).toMatchObject({ event: PROBE_OUTCOME_COUNTER, kind: 'claude', status: 'warning', count: 1 })
    expect(parsed[2]).toMatchObject({ event: FETCH_TIMEOUT_COUNTER, reason: 'timeout', count: 1 })
    for (const record of parsed.slice(3)) {
      expect(record).not.toHaveProperty('outcome')
      expect(record).not.toHaveProperty('status')
      expect(record).not.toHaveProperty('reason')
    }
    expect(text).not.toContain('skipped')
    expect(text).not.toContain('456.78')
    expect(text).not.toContain('alice')
  })

  it('keeps interleaved forwarder records parseable across a forced rotation (#131)', async () => {
    const logDir = tempLogDir()
    // pino-roll parses bare numbers as megabytes — test sizes need a unit.
    // Rotation itself is async (write → drain → flush → reopen), so the burst
    // settles before close, mirroring pino-roll's own tests.
    await initOperationalLog({ logDir, isPackaged: true, size: '2k', count: 2 })
    const contexts = ['worker', 'sidecar', 'renderer', 'main'] as const
    for (let i = 0; i < 120; i += 1) {
      const context = contexts[i % contexts.length]!
      safeLogOperationalEvent('info', `event.${i}`, { op: `op-${i}`, count: i }, context)
      if (i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 20))
    }
    await new Promise(resolve => setTimeout(resolve, 500))
    closeOperationalLog()
    const files = readdirSync(logDir).filter(f => f.startsWith('operational'))
    // Rotation fired (more than the active file) but the quota holds.
    expect(files.length).toBeGreaterThan(1)
    expect(files.length).toBeLessThanOrEqual(3)
    const lines = readLines(logDir)
    expect(lines.length).toBeGreaterThan(0)
    const events = new Set<string>()
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(typeof parsed['level']).toBe('string')
      expect(typeof parsed['context']).toBe('string')
      expect(typeof parsed['event']).toBe('string')
      expect(typeof parsed['time']).toBe('string')
      events.add(String(parsed['event']))
    }
    // No truncation: every surviving line is complete JSON — and rotation
    // kept the newest generations (early events rotated out, late ones kept).
    expect(events.has('event.119')).toBe(true)
  })
})

describe('sanitizeOperationalRecord closed-vocabulary dimensions (#148 Wave 9 Slice E)', () => {
  function clean(fields: Record<string, unknown>): Record<string, unknown> {
    return sanitizeOperationalRecord('scan.duration', fields, 'main')
  }

  it('keeps a dimension value that is a member of its set', () => {
    expect(clean({ op: 'scan', outcome: 'success', count: 12 })).toEqual({
      context: 'main',
      event: 'scan.duration',
      op: 'scan',
      outcome: 'success',
      count: 12,
    })
    expect(clean({ outcome: 'aborted' })).toMatchObject({ outcome: 'aborted' })
    expect(clean({ outcome: 'failed' })).toMatchObject({ outcome: 'failed' })
    expect(clean({ status: 'ready' })).toMatchObject({ status: 'ready' })
    expect(clean({ status: 'warning' })).toMatchObject({ status: 'warning' })
    expect(clean({ status: 'error' })).toMatchObject({ status: 'error' })
    expect(clean({ status: 'disabled' })).toMatchObject({ status: 'disabled' })
    expect(clean({ reason: 'timeout' })).toMatchObject({ reason: 'timeout' })
  })

  it('drops a value outside the set, including near-misses and wrong-set members', () => {
    // No trim, no case-fold, no cap-then-keep: `' success '` is as foreign as
    // a prompt, because the set is the entire allowlist.
    for (const value of ['SUCCESS', ' success ', 'success ', 'succeeded', '', ' pending ', 'timeout ']) {
      expect(clean({ outcome: value })).not.toHaveProperty('outcome')
    }
    // `pending` is a `ProbeStatus` but never a settled `ProbeResult['status']`.
    expect(clean({ status: 'pending' })).not.toHaveProperty('status')
    // A member of one set is not a member of another: the sets are per field.
    expect(clean({ outcome: 'timeout' })).not.toHaveProperty('outcome')
    expect(clean({ status: 'success' })).not.toHaveProperty('status')
    expect(clean({ reason: 'abort' })).not.toHaveProperty('reason')
    expect(clean({ reason: 'network' })).not.toHaveProperty('reason')
  })

  it('drops non-string dimension values without coercing them', () => {
    const hostile: unknown[] = [1, 0, -1, Number.NaN, true, false, null, undefined, {}, [], ['ready'], new Date(0)]
    for (const value of hostile) {
      // Not `String(value)`-ed, not counted: only context + event survive.
      expect(clean({ outcome: value, status: value, reason: value })).toEqual({
        context: 'main',
        event: 'scan.duration',
      })
    }
  })

  it('never leaks a long, path-shaped, prompt-shaped, or odd-control value', () => {
    const hostile = [
      'x'.repeat(500),
      'C:\\Users\\alice\\sessions.json',
      '/Users/alice/.config/token.json',
      'user asked: what did I spend on gpt-5?',
      'Bearer sk-secret',
      '\u202E',
      'success\nskipped',
    ]
    for (const value of hostile) {
      const record = clean({ outcome: value, status: value, reason: value })
      expect(record).toEqual({ context: 'main', event: 'scan.duration' })
      expect(JSON.stringify(record)).not.toContain('alice')
      expect(JSON.stringify(record)).not.toContain('sk-secret')
    }
  })

  it('leaves `kind` a free-form allowlisted string (capped, not enumerated)', () => {
    // Deliberate: `kind` is allowlisted by name today, so it keeps the string
    // rules (trim + 200-char cap, no basename rewrite) instead of joining the
    // closed vocabulary. Pinned here so the decision cannot drift silently.
    expect(clean({ kind: 'claude' })).toMatchObject({ kind: 'claude' })
    expect(clean({ kind: '  opencode  ' })).toMatchObject({ kind: 'opencode' })
    expect(String(clean({ kind: 'y'.repeat(500) })['kind'])).toHaveLength(200)
  })
})

describe('OperationalLog Effect bridge (Wave 2 §4.4/§5.4)', () => {
  type SinkRecord = { level: string; event: string; fields: Record<string, unknown>; context: string }

  function makeFakeSink(): { sink: OperationalLogSink; records: SinkRecord[] } {
    const records: SinkRecord[] = []
    const sink: OperationalLogSink = {
      emit: (level, event, fields, context) => {
        records.push({ level, event, fields: { ...fields }, context })
      },
    }
    return { sink, records }
  }

  it('defines the three counter keys for the later call-site wiring slice', () => {
    expect(SCAN_DURATION_COUNTER).toBe('scan.duration')
    expect(FETCH_TIMEOUT_COUNTER).toBe('fetch.timeout')
    expect(PROBE_OUTCOME_COUNTER).toBe('probe.outcome')
    expect(new Set([SCAN_DURATION_COUNTER, FETCH_TIMEOUT_COUNTER, PROBE_OUTCOME_COUNTER]).size).toBe(3)
  })

  it('service log forwards level/event/fields/context through the fake sink layer', async () => {
    const { sink, records } = makeFakeSink()
    await Effect.runPromise(
      Effect.gen(function* () {
        const oplog = yield* OperationalLog
        yield* oplog.log('warn', 'test.event', { op: 'scan' }, 'worker')
      }).pipe(Effect.provide(OperationalLog.layerWithSink(sink))),
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({ level: 'warn', event: 'test.event', fields: { op: 'scan' }, context: 'worker' })
  })

  it('service counters file records with the counter key as event and count field', async () => {
    const { sink, records } = makeFakeSink()
    await Effect.runPromise(
      Effect.gen(function* () {
        const oplog = yield* OperationalLog
        yield* oplog.incrementCounter(SCAN_DURATION_COUNTER, 123, { op: 'scan' })
        yield* oplog.incrementCounter(FETCH_TIMEOUT_COUNTER)
        yield* oplog.recordGauge(PROBE_OUTCOME_COUNTER, 2, { op: 'probe' })
      }).pipe(Effect.provide(OperationalLog.layerWithSink(sink))),
    )
    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({ level: 'info', event: SCAN_DURATION_COUNTER, context: 'main' })
    expect(records[0]!.fields).toMatchObject({ op: 'scan', count: 123 })
    expect(records[1]).toMatchObject({ level: 'info', event: FETCH_TIMEOUT_COUNTER })
    expect(records[1]!.fields).toMatchObject({ count: 1 })
    expect(records[2]).toMatchObject({ level: 'info', event: PROBE_OUTCOME_COUNTER })
    expect(records[2]!.fields).toMatchObject({ op: 'probe', count: 2 })
  })

  it('service never throws when the sink throws (never-throws preserved)', async () => {
    const throwing: OperationalLogSink = {
      emit: () => {
        throw new Error('sink boom')
      },
    }
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const oplog = yield* OperationalLog
          yield* oplog.log('info', 'test', { op: 'x' })
          yield* oplog.incrementCounter(SCAN_DURATION_COUNTER, 1)
          yield* oplog.recordGauge('gauge.x', 1)
        }).pipe(Effect.provide(OperationalLog.layerWithSink(throwing))),
      ),
    ).resolves.toBeUndefined()
  })

  it('service live layer drops non-allowlisted fields through the file sink', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const oplog = yield* OperationalLog
        yield* oplog.log('info', 'test', {
          op: 'test',
          prompt: 'secret prompt body',
          filePath: '/Users/alice/secret.txt',
          ledgerFact: 'total spend $456.78',
        })
      }).pipe(Effect.provide(OperationalLog.layer)),
    )
    closeOperationalLog()
    const lines = readLines(logDir)
    expect(lines).toHaveLength(1)
    const text = lines[0]!
    expect(text).not.toContain('secret prompt body')
    expect(text).not.toContain('alice')
    expect(text).not.toContain('456.78')
  })

  it('Logger maps Effect levels into the file sink', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: false })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logDebug('debug message')
        yield* Effect.logInfo('info message')
        yield* Effect.logWarning('warn message')
        yield* Effect.logError('error message')
      }).pipe(Effect.provide(OperationalLogLoggerLayer)),
    )
    closeOperationalLog()
    const parsed = readLines(logDir).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(parsed).toHaveLength(4)
    expect(parsed.map(record => record['level'])).toEqual(['debug', 'info', 'warn', 'error'])
    for (const record of parsed) expect(record['event']).toBe('effect.log')
    expect(parsed[0]!['label']).toContain('debug message')
    expect(parsed[3]!['label']).toContain('error message')
  })

  it('Logger drops non-allowlisted annotation fields but keeps allowlisted ones', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    await Effect.runPromise(
      Effect.logInfo('hello').pipe(
        Effect.annotateLogs({ op: 'scan', prompt: 'secret-body', ledgerFact: 'spend $1' }),
        Effect.provide(OperationalLogLoggerLayer),
      ),
    )
    closeOperationalLog()
    const lines = readLines(logDir)
    expect(lines).toHaveLength(1)
    const text = lines[0]!
    expect(text).not.toContain('secret-body')
    expect(text).not.toContain('spend $1')
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(parsed['op']).toBe('scan')
    expect(parsed['label']).toContain('hello')
    expect(parsed).not.toHaveProperty('prompt')
    expect(parsed).not.toHaveProperty('ledgerFact')
  })

  it('Logger never throws without init (mirrors if (!active) return)', async () => {
    closeOperationalLog()
    await expect(
      Effect.runPromise(Effect.logInfo('no sink yet').pipe(Effect.provide(OperationalLogLoggerLayer))),
    ).resolves.toBeUndefined()
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const oplog = yield* OperationalLog
          yield* oplog.log('info', 'test', { op: 'x' })
        }).pipe(Effect.provide(OperationalLog.layer)),
      ),
    ).resolves.toBeUndefined()
  })
})
