import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  closeOperationalLog,
  initOperationalLog,
  logIpcError,
  logOperationalEvent,
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
})
