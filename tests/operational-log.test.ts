import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  closeOperationalLog,
  initOperationalLog,
  logIpcError,
  logOperationalEvent,
  safeLogOperationalEvent,
} from '../src/main/operational-log.js'

let dir = ''

afterEach(() => {
  try { closeOperationalLog() } catch { /* not initialised */ }
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
