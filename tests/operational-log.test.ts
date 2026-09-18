import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildOperationalLogRecord, isOperationalLogRecord } from '../src/shared/operational-log.js'
import {
  closeOperationalLog,
  initOperationalLog,
  recordOperationalLog,
} from '../src/main/operational-log.js'
import { DbWorkerContext } from '../src/main/db-worker/context.js'
import type { DbWorkerEvent } from '../src/main/db-worker/protocol.js'
import { ScanAbortedError } from '../src/main/pipeline/scan.js'
import { parseSidecarStderrLine } from '../src/shared/operational-log.js'
import { reportLedgerRequestFailure } from '../src/main/agents/ledger-mcp/http-server.js'
import { readReadyPort } from '../src/main/agents/ledger-mcp/sidecar.js'
import { parseEvent } from '../src/renderer/src/shared/lib/api.js'
import { createCoachRunner } from '../src/main/agents/ipc.js'
import { createUpdateChecker } from '../src/main/updates.js'
import { createSidecarPool } from '../src/main/agents/ledger-mcp/pool.js'

/** Rotation and retention settle asynchronously inside pino-roll: wait for two
 * consecutive identical listings so assertions observe the final state. */
async function settleLogDir(logDir: string): Promise<void> {
  const deadline = Date.now() + 5000
  let last = ''
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 50))
    const now = readdirSync(logDir).sort().join('\n')
    if (now === last) return
    last = now
    if (Date.now() > deadline) throw new Error('log dir did not settle')
  }
}

describe('Operational log record seam (spec #126, ticket #127)', () => {
  it('builds a parseable record carrying timestamp, level, context, event and allowlisted fields only', () => {
    const record = buildOperationalLogRecord('main', 'scan.finish', {
      provider: 'claude',
      count: 3,
    })
    expect(record.context).toBe('main')
    expect(record.event).toBe('scan.finish')
    expect(typeof record.timestamp).toBe('string')
    expect(typeof record.level).toBe('string')
    expect(record.provider).toBe('claude')
  })

  it('drops forbidden fields by construction (prompts, tokens, contents, paths, bodies, ledger facts)', () => {
    const record = buildOperationalLogRecord('main', 'harness.error', {
      harnessKind: 'claude',
      code: 'spawn-failed',
      // @ts-expect-error hostile fields are never part of the allowlist
      prompt: 'secret prompt body',
      // @ts-expect-error hostile fields are never part of the allowlist
      token: 'Bearer sk-secret',
      // @ts-expect-error hostile fields are never part of the allowlist
      fileContent: 'file bytes',
      // @ts-expect-error hostile fields are never part of the allowlist
      requestBody: { prompt: 'x' },
    })
    const text = JSON.stringify(record)
    expect(text).not.toContain('secret prompt body')
    expect(text).not.toContain('sk-secret')
    expect(text).not.toContain('file bytes')
    expect(record.harnessKind).toBe('claude')
    expect(record.code).toBe('spawn-failed')
  })

  it('records only the file basename, never the full absolute path', () => {
    const record = buildOperationalLogRecord('worker', 'file.error', {
      provider: 'claude',
      file: '/Users/alice/.config/app/sessions/secret.jsonl',
      code: 'read-failed',
    })
    expect(record.file).toBe('secret.jsonl')
    expect(JSON.stringify(record)).not.toContain('alice')
  })
})

describe('Operational log file sink (ticket #127)', () => {
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

  /** pino-roll names size-rotated files extension-last (`operational.1.log`). */
  function logFiles(logDir: string): string[] {
    return readdirSync(logDir).filter(f => /^operational\.\d+\.log$/.test(f))
  }

  function readLines(logDir: string): string[] {
    const lines: string[] = []
    for (const file of logFiles(logDir)) {
      const text = readFileSync(join(logDir, file), 'utf8')
      lines.push(...text.split('\n').filter(line => line.trim().length > 0))
    }
    return lines
  }

  it('writes parseable JSON lines carrying timestamp, level, context, event and allowlisted fields', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    recordOperationalLog('main', 'scan.finish', { count: 2 })
    closeOperationalLog()
    const lines = readLines(logDir)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed['context']).toBe('main')
    expect(parsed['event']).toBe('scan.finish')
    expect(parsed['timestamp']).toBeDefined()
    // Trimmed pino line shape: string level from formatters, no epoch time,
    // no pid/hostname constants.
    expect(parsed['level']).toBe('info')
    expect(parsed).not.toHaveProperty('time')
    expect(parsed).not.toHaveProperty('pid')
    expect(parsed).not.toHaveProperty('hostname')
  })

  it('never persists forbidden values to the bytes on disk', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true })
    recordOperationalLog('main', 'ipc.error', {
      op: 'overview:query',
      code: 'failed',
      // @ts-expect-error hostile fields are never part of the allowlist
      prompt: 'secret prompt body',
      // @ts-expect-error hostile fields are never part of the allowlist
      token: 'Bearer sk-secret',
    })
    closeOperationalLog()
    const raw = readLines(logDir).join('\n')
    expect(raw).not.toContain('secret prompt body')
    expect(raw).not.toContain('sk-secret')
    expect(raw).toContain('overview:query')
  })

  it('writes debug in development and drops debug in packaged builds', async () => {
    const devDir = tempLogDir()
    await initOperationalLog({ logDir: devDir, isPackaged: false })
    recordOperationalLog('main', 'scan.start', {}, { level: 'debug' })
    closeOperationalLog()
    expect(readLines(devDir)).toHaveLength(1)

    const prodParent = mkdtempSync(join(tmpdir(), 'watchtower-oplog-prod-'))
    const prodDir = join(prodParent, 'logs')
    try {
      await initOperationalLog({ logDir: prodDir, isPackaged: true })
      recordOperationalLog('main', 'scan.start', {}, { level: 'debug' })
      closeOperationalLog()
      expect(readLines(prodDir)).toHaveLength(0)
    } finally {
      rmSync(prodParent, { recursive: true, force: true })
    }
  })

  it('caps rotation across generations within quota', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true, size: '1k', count: 1 })
    for (let i = 0; i < 30; i++) {
      recordOperationalLog('main', 'scan.finish', { count: i, message: `note-${i}-padding-to-force-rotation-xxxxxxxx` })
    }
    await settleLogDir(logDir)
    closeOperationalLog()
    const files = logFiles(logDir)
    expect(files.length).toBeLessThanOrEqual(2)
    let total = 0
    for (const f of files) total += statSync(join(logDir, f)).size
    expect(total).toBeLessThanOrEqual(2 * (1024 + 1024))
    for (const line of readLines(logDir)) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(parsed['context']).toBe('main')
    }
  })

  it('retention spans reboot: pre-existing generations are trimmed, foreign files survive', async () => {
    const logDir = tempLogDir()
    await initOperationalLog({ logDir, isPackaged: true, size: '1k', count: 1 })
    for (let i = 0; i < 30; i++) {
      recordOperationalLog('main', 'scan.finish', { count: i, message: `note-${i}-padding-to-force-rotation-xxxxxxxx` })
    }
    await settleLogDir(logDir)
    closeOperationalLog()
    // A foreign file shares the dir but not the roll family: only matching
    // generations are ever managed.
    writeFileSync(join(logDir, 'notes.txt'), 'not a log')
    await initOperationalLog({ logDir, isPackaged: true, size: '1k', count: 1 })
    for (let i = 0; i < 30; i++) {
      recordOperationalLog('main', 'scan.finish', { count: i, message: `reboot-${i}-padding-to-force-rotation-xxxxxx` })
    }
    await settleLogDir(logDir)
    closeOperationalLog()
    expect(logFiles(logDir).length).toBeLessThanOrEqual(2)
    expect(readFileSync(join(logDir, 'notes.txt'), 'utf8')).toBe('not a log')
  })
})

describe('Worker scan-lifecycle forwarding (ticket #128)', () => {
  let dir = ''
  let ctx: DbWorkerContext | null = null

  afterEach(() => {
    try { ctx?.close() } catch { /* already closed */ }
    ctx = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  function openWithScan(fakeScan: (options: unknown, onProgress?: unknown, abort?: unknown, onDelta?: unknown) => Promise<unknown>): { events: DbWorkerEvent[] } {
    dir = mkdtempSync(join(tmpdir(), 'watchtower-oplog-worker-'))
    const events: DbWorkerEvent[] = []
    ctx = new DbWorkerContext(
      { dbPath: join(dir, 'ledger.db'), dataDir: dir, cacheDir: join(dir, 'cache') },
      event => { events.push(event) },
      // @ts-expect-error injected fake scan runner for the forwarding seam
      { runScan: fakeScan },
    )
    return { events }
  }

  function opLogRecords(events: DbWorkerEvent[]): Array<{ event: string; [key: string]: unknown }> {
    return events
      .filter((e): e is Extract<DbWorkerEvent, { event: 'operational-log' }> => e.event === 'operational-log')
      .map(e => ({ event: e.record.event, ...(e.record as unknown as Record<string, unknown>) }))
  }

  it('emits scan start and finish with per-provider unparsed counts', async () => {
    const { events } = openWithScan(async () => ({
      scanId: 's1',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      portedFiles: 2,
      unchangedFiles: 1,
      failedFiles: 0,
      perProvider: [{ provider: 'claude', ported: 2, unchanged: 1, failed: 0, unparsed: 4 }],
      aborted: false,
    }))
    const result = await ctx!.dispatch('scan:start', [{ provider: 'claude' }])
    expect(result).toEqual({ ok: true })
    const records = opLogRecords(events)
    expect(records.map(r => r['event'])).toEqual(['scan.start', 'scan.finish'])
    const finish = records.find(r => r['event'] === 'scan.finish')!
    expect(finish['unparsed']).toEqual([{ provider: 'claude', unparsed: 4 }])
    for (const r of records) {
      expect(isOperationalLogRecord({ timestamp: new Date().toISOString(), level: 'info', context: 'worker', ...r })).toBe(true)
    }
  })

  it('emits scan abort when the scan is aborted', async () => {
    const { events } = openWithScan(async () => { throw new ScanAbortedError() })
    const result = await ctx!.dispatch('scan:start', []) as { ok: boolean; aborted: boolean }
    expect(result.ok).toBe(false)
    expect(result.aborted).toBe(true)
    expect(opLogRecords(events).map(r => r['event'])).toEqual(['scan.start', 'scan.abort'])
  })

  it('emits file errors with basename and code only — no contents or full paths', async () => {    const { events } = openWithScan(async (_options: unknown, _onProgress: unknown, _abort: unknown, onDelta: unknown) => {
      const delta = onDelta as (d: unknown) => Promise<void>
      await delta({
        provider: 'claude',
        filePath: '/Users/alice/.config/app/sessions/secret.jsonl',
        verdict: 'ported',
        cachedFile: { failed: true },
      })
      return {
        scanId: 's2',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        portedFiles: 0,
        unchangedFiles: 0,
        failedFiles: 1,
        perProvider: [{ provider: 'claude', ported: 0, unchanged: 0, failed: 1, unparsed: 0 }],
        aborted: false,
      }
    })
    await ctx!.dispatch('scan:start', [])
    const records = opLogRecords(events)
    const fileError = records.find(r => r['event'] === 'file.error')!
    expect(fileError['file']).toBe('secret.jsonl')
    expect(fileError['provider']).toBe('claude')
    expect(JSON.stringify(records)).not.toContain('alice')
  })

  it('keeps the worker free of Electron APIs', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const root = join(here, '..', 'src', 'main', 'db-worker')
    for (const file of ['entry.ts', 'context.ts', 'protocol.ts', 'client.ts']) {
      const text = readFileSync(join(root, file), 'utf8')
      expect(text).not.toMatch(/from ['"]electron['"]/)
    }
    const shared = readFileSync(join(here, '..', 'src', 'shared', 'operational-log.ts'), 'utf8')
    expect(shared).not.toMatch(/from ['"]electron['"]/)
    expect(shared).not.toMatch(/from ['"]node:/)
    expect(shared).not.toMatch(/require\(['"]node:/)
  })
})

describe('Sidecar forwarding with readiness protection (ticket #129)', () => {
  it('parses pino stderr lines into method-and-route-only fields', () => {
    const parsed = parseSidecarStderrLine(
      '{"level":40,"method":"POST","route":"/mcp","code":"internal"}',
    )
    expect(parsed).toMatchObject({ event: 'ledger-mcp.request-error', method: 'POST', route: '/mcp' })
  })

  it('drops bodies, tokens and ledger facts from stderr lines and ignores preamble', () => {
    const parsed = parseSidecarStderrLine(
      '{"level":40,"method":"POST","route":"/mcp","body":{"prompt":"secret"},"token":"Bearer sk-secret"}',
    )
    const text = JSON.stringify(parsed)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('sk-secret')
    expect(parseSidecarStderrLine('(node:123) ExperimentalWarning: foo')).toBeNull()
    expect(parseSidecarStderrLine('watchtower-ledger(http): some plain line')).toBeNull()
    expect(parseSidecarStderrLine('{"level":30,"msg":"a pino line without method or route"}')).toBeNull()
  })

  it('logs a sidecar boot failure once when the spawn throws', async () => {
    const seen: Array<{ event: string; fields: Record<string, unknown> }> = []
    const pool = createSidecarPool({
      spawn: async () => { throw new Error('no binary') },
      onOperationalLog: (event, fields) => { seen.push({ event, fields }) },
    })
    const ctx = { execPath: '/bin/app', entryPath: '/app/ledger-mcp.js', dbPath: '/data/ledger.db' }
    expect(await pool.acquire(ctx)).toBeNull()
    expect(seen.filter(s => s.event === 'sidecar.boot-error')).toHaveLength(1)
  })

  it('logs a health failure once when the pooled sidecar dies between turns', async () => {
    let alive = true
    const seen: Array<{ event: string }> = []
    const pool = createSidecarPool({
      spawn: async () => ({
        server: { type: 'http', name: 'watchtower-ledger', url: 'http://127.0.0.1:9999/mcp', headers: [] } as never,
        release: () => {},
        checkHealth: async () => alive,
      }),
      onOperationalLog: (event) => { seen.push({ event: event as string }) },
    })
    const ctx = { execPath: '/bin/app', entryPath: '/app/ledger-mcp.js', dbPath: '/data/ledger.db' }
    await pool.acquire(ctx)
    alive = false
    await pool.acquire(ctx)
    expect(seen.filter(s => s.event === 'sidecar.health-failure')).toHaveLength(1)
  })

  it('keeps request-failure logging off stdout and the READY announcement parseable under load', async () => {
    const stderrBytes: string[] = []
    const stdoutBytes: string[] = []
    const origStderrWrite = process.stderr.write.bind(process.stderr)
    const origStdoutWrite = process.stdout.write.bind(process.stdout)
    // @ts-expect-error capture writes without a full stream mock
    process.stderr.write = (chunk: unknown) => { stderrBytes.push(String(chunk)); return true }
    // @ts-expect-error capture writes without a full stream mock
    process.stdout.write = (chunk: unknown) => { stdoutBytes.push(String(chunk)); return true }
    try {
      reportLedgerRequestFailure('POST', '/mcp', 'internal')
    } finally {
      process.stderr.write = origStderrWrite
      process.stdout.write = origStdoutWrite
    }
    expect(stdoutBytes.join('')).toBe('')
    const logged = JSON.parse(stderrBytes.join('')) as Record<string, unknown>
    expect(logged['method']).toBe('POST')
    expect(logged['route']).toBe('/mcp')

    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new PassThrough()
    const pending = readReadyPort(child, stdout)
    for (let i = 0; i < 50; i++) stdout.write(`(node:${i}) ExperimentalWarning: logging load ${i}\n`)
    stdout.write('READY {"port":4567}\n')
    await expect(pending).resolves.toBe(4567)
  })
})

describe('Renderer tripwire + Harness and update lifecycle (ticket #130)', () => {
  it('forwards tripwire rejections with label and location only — no payload contents', async () => {
    const forwarded: unknown[] = []
    ;(globalThis as { window?: unknown }).window = {
      api: { reportTripwire: (label: string, location: string) => { forwarded.push({ label, location }) } },
    }
    try {
      const schema = z.object({ scanned: z.boolean() })
      const secretPayload = { scanned: 'nope', prompt: 'secret prompt body' }
      expect(parseEvent(schema, 'scan status', secretPayload)).toBeNull()
      expect(forwarded).toHaveLength(1)
      expect(JSON.stringify(forwarded)).not.toContain('secret prompt body')
      expect(JSON.stringify(forwarded)).toContain('scan status')
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  it('records Harness runs by kind only — no prompts', async () => {
    const seen: Array<{ event: string; fields: Record<string, unknown> }> = []
    const runner = createCoachRunner({
      getRuntime: async () => ({
        async *run() { yield { kind: 'text', delta: 'hi' } as never },
        async inspect() { return {} },
      }),
      detect: async () => [{ kind: 'claude', displayName: 'Claude', bin: '/bin/claude', scrubEnv: [], authStatus: 'unknown' }],
      ledgerMcpServer: async () => null,
      onOperationalLog: (event, fields) => { seen.push({ event: event as string, fields: (fields ?? {}) as Record<string, unknown> }) },
    })
    const ack = await runner.start({ harnessKind: 'claude', prompt: 'secret prompt body' }, () => {})
    expect(ack.ok).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    const events = seen.map(s => s.event)
    expect(events).toContain('harness.start')
    expect(events).toContain('harness.finish')
    expect(JSON.stringify(seen)).not.toContain('secret prompt body')
    expect(JSON.stringify(seen)).toContain('claude')
    await runner.reset()
  })

  it('records offline update checks as info, never errors', async () => {
    const seen: Array<{ event: string; fields: Record<string, unknown> }> = []
    const checker = createUpdateChecker({
      currentVersion: '0.1.0',
      fetchReleasesImpl: async () => { throw new Error('offline') },
      onOperationalLog: (event, fields) => { seen.push({ event: event as string, fields: (fields ?? {}) as Record<string, unknown> }) },
    })
    await checker.check()
    expect(seen.map(s => s.event)).toEqual(['updates.offline'])
    const record = buildOperationalLogRecord('main', 'updates.offline', seen[0]!.fields)
    expect(record.level).toBe('info')
  })

  it('keeps the renderer free of direct log-file writes', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const text = readFileSync(join(here, '..', 'src', 'renderer', 'src', 'shared', 'lib', 'api.ts'), 'utf8')
    expect(text).not.toMatch(/node:fs/)
    expect(text).not.toMatch(/writeFile/)
  })
})

describe('Ad-hoc write sweep + single-file integrate-and-verify (ticket #131)', () => {
  it('keeps zero console.* writes in app code', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const root = join(here, '..', 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) files.push(full)
      }
    }
    walk(root)
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (/console\.(error|warn|log|info|debug)/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('redaction sweep: hostile values through every public entry point never reach the record or disk', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'watchtower-oplog-sweep-'))
    const logDir = join(parent, 'logs')
    const secrets = {
      prompt: 'sweep-secret-prompt-body',
      token: 'Bearer sweep-secret-token',
      fileContent: 'sweep-secret-file-bytes',
      requestBody: 'sweep-secret-request-body',
      ledgerFact: 'sweep-secret-ledger-fact',
      fullPath: '/Users/sweepsecret/.config/app/sessions/hidden.jsonl',
    }
    try {
      await initOperationalLog({ logDir, isPackaged: true })
      const entries: Array<[Parameters<typeof buildOperationalLogRecord>[0], Parameters<typeof buildOperationalLogRecord>[1], Record<string, unknown>]> = [
        ['main', 'scan.finish', { count: 1, ...secrets }],
        ['worker', 'file.error', { provider: 'claude', file: secrets.fullPath, code: 'read-failed', ...secrets }],
        ['main', 'ipc.error', { op: 'overview:query', code: 'failed', ...secrets }],
        ['sidecar', 'ledger-mcp.request-error', { method: 'POST', route: '/mcp', code: 'internal', ...secrets }],
        ['main', 'harness.error', { harnessKind: 'claude', code: 'failed', ...secrets }],
        ['main', 'updates.offline', { code: 'unavailable', ...secrets }],
        ['renderer', 'renderer.tripwire', { label: 'scan status', location: 'broadcast', ...secrets }],
      ]
      for (const [context, event, fields] of entries) {
        const record = buildOperationalLogRecord(context, event, fields as never)
        const text = JSON.stringify(record)
        for (const secret of Object.values(secrets)) {
          if (secret === secrets.fullPath) continue
          expect(text).not.toContain(secret)
        }
        recordOperationalLog(context, event, fields as never)
      }
      const parsedSidecar = parseSidecarStderrLine(
        JSON.stringify({ level: 40, method: 'POST', route: '/mcp', body: secrets.requestBody, token: secrets.token }),
      )
      expect(JSON.stringify(parsedSidecar)).not.toContain(secrets.requestBody)
      expect(JSON.stringify(parsedSidecar)).not.toContain(secrets.token)
      closeOperationalLog()
      const raw = readdirSync(logDir)
        .filter(f => /^operational\.\d+\.log$/.test(f))
        .map(f => readFileSync(join(logDir, f), 'utf8'))
        .join('\n')
      for (const secret of [secrets.prompt, secrets.token, secrets.fileContent, secrets.requestBody, secrets.ledgerFact]) {
        expect(raw).not.toContain(secret)
      }
      expect(raw).not.toContain('sweepsecret')
    } finally {
      try { closeOperationalLog() } catch { /* already closed */ }
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('interleaved worker and sidecar records across a forced rotation stay complete, parseable and within quota', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'watchtower-oplog-interleave-'))
    const logDir = join(parent, 'logs')
    try {
      await initOperationalLog({ logDir, isPackaged: true, size: '1k', count: 2 })
      for (let i = 0; i < 30; i++) {
        if (i % 3 === 0) recordOperationalLog('worker', 'scan.finish', { manual: false, count: i, unparsed: [{ provider: 'claude', unparsed: i }] })
        else if (i % 3 === 1) recordOperationalLog('sidecar', 'ledger-mcp.request-error', { method: 'POST', route: '/mcp', code: 'internal' })
        else recordOperationalLog('renderer', 'renderer.tripwire', { label: 'scan status', location: 'broadcast' })
      }
      await settleLogDir(logDir)
      closeOperationalLog()
      const files = readdirSync(logDir).filter((f: string) => /^operational\.\d+\.log$/.test(f))
      expect(files.length).toBeLessThanOrEqual(3)
      let total = 0
      const contexts = new Set<string>()
      for (const file of files) {
        const full = join(logDir, file)
        total += statSync(full).size
        const text: string = readFileSync(full, 'utf8')
        if (text.length > 0) expect(text.endsWith('\n')).toBe(true)
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          const parsed = JSON.parse(line) as Record<string, unknown>
          expect(parsed['timestamp']).toBeDefined()
          expect(typeof parsed['context']).toBe('string')
          expect(typeof parsed['event']).toBe('string')
          contexts.add(parsed['context'] as string)
        }
      }
      expect(total).toBeLessThanOrEqual(3 * (1024 + 1024))
      expect(contexts.has('worker')).toBe(true)
      expect(contexts.has('sidecar')).toBe(true)
    } finally {
      try { closeOperationalLog() } catch { /* already closed */ }
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
