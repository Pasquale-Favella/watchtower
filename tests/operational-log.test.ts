import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildOperationalLogRecord, isOperationalLogRecord } from '../src/shared/operational-log.js'
import {
  closeOperationalLog,
  initOperationalLog,
  recordOperationalLog,
} from '../src/main/operational-log.js'
import { DbWorkerContext } from '../src/main/db-worker/context.js'
import type { DbWorkerEvent } from '../src/main/db-worker/protocol.js'
import { ScanAbortedError } from '../src/main/pipeline/scan.js'
import { parseSidecarStderrLine, reportLedgerRequestFailure } from '../src/shared/operational-log.js'
import { readReadyPort } from '../src/main/agents/ledger-mcp/sidecar.js'
import { parseEvent } from '../src/renderer/src/shared/lib/api.js'
import { createCoachRunner } from '../src/main/agents/ipc.js'
import { createUpdateChecker } from '../src/main/updates.js'
import { createSidecarPool } from '../src/main/agents/ledger-mcp/pool.js'

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

  function readLines(logDir: string): string[] {
    const text = readFileSync(join(logDir, 'operational.log'), 'utf8')
    return text.split('\n').filter(line => line.trim().length > 0)
  }

  it('writes parseable JSON lines carrying timestamp, level, context, event and allowlisted fields', () => {
    const logDir = tempLogDir()
    initOperationalLog({ logDir, isPackaged: true })
    recordOperationalLog('main', 'scan.finish', { count: 2 })
    closeOperationalLog()
    const lines = readLines(logDir)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed['context']).toBe('main')
    expect(parsed['event']).toBe('scan.finish')
    expect(parsed['timestamp'] ?? parsed['time']).toBeDefined()
  })

  it('never persists forbidden values to the bytes on disk', () => {
    const logDir = tempLogDir()
    initOperationalLog({ logDir, isPackaged: true })
    recordOperationalLog('main', 'ipc.error', {
      op: 'overview:query',
      code: 'failed',
      // @ts-expect-error hostile fields are never part of the allowlist
      prompt: 'secret prompt body',
      // @ts-expect-error hostile fields are never part of the allowlist
      token: 'Bearer sk-secret',
    })
    closeOperationalLog()
    const raw = readFileSync(join(logDir, 'operational.log'), 'utf8')
    expect(raw).not.toContain('secret prompt body')
    expect(raw).not.toContain('sk-secret')
    expect(raw).toContain('overview:query')
  })

  it('writes debug in development and drops debug in packaged builds', () => {
    const devDir = tempLogDir()
    initOperationalLog({ logDir: devDir, isPackaged: false })
    recordOperationalLog('main', 'scan.start', {}, { level: 'debug' })
    closeOperationalLog()
    expect(readLines(devDir)).toHaveLength(1)

    const prodParent = mkdtempSync(join(tmpdir(), 'watchtower-oplog-prod-'))
    const prodDir = join(prodParent, 'logs')
    try {
      initOperationalLog({ logDir: prodDir, isPackaged: true })
      recordOperationalLog('main', 'scan.start', {}, { level: 'debug' })
      closeOperationalLog()
      const text = readFileSync(join(prodDir, 'operational.log'), 'utf8')
      expect(text.trim()).toBe('')
    } finally {
      rmSync(prodParent, { recursive: true, force: true })
    }
  })

  it('caps rotation across generations and prunes stale generations on boot', () => {
    const logDir = tempLogDir()
    initOperationalLog({ logDir, isPackaged: true, maxFileBytes: 300, maxGenerations: 2 })
    for (let i = 0; i < 20; i++) {
      recordOperationalLog('main', 'scan.finish', { count: i, message: `note-${i}-padding-to-force-rotation-xxxxxxxx` })
    }
    closeOperationalLog()
    const files = readdirSync(logDir).filter(f => f.startsWith('operational.log'))
    expect(files.length).toBeLessThanOrEqual(3)
    let total = 0
    for (const f of files) total += statSync(join(logDir, f)).size
    expect(total).toBeLessThanOrEqual(3 * 1024)

    writeFileSync(join(logDir, 'operational.log.99'), 'stale')
    initOperationalLog({ logDir, isPackaged: true, maxFileBytes: 300, maxGenerations: 2 })
    closeOperationalLog()
    expect(readdirSync(logDir).some((f: string) => f === 'operational.log.99')).toBe(false)
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

  it('keeps the worker free of Electron APIs', async () => {
    const { readFileSync } = await import('node:fs')
    const { join: joinPath, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const root = joinPath(here, '..', 'src', 'main', 'db-worker')
    for (const file of ['entry.ts', 'context.ts', 'protocol.ts', 'client.ts']) {
      const text = readFileSync(joinPath(root, file), 'utf8')
      expect(text).not.toMatch(/from ['"]electron['"]/)
    }
    const shared = readFileSync(joinPath(here, '..', 'src', 'shared', 'operational-log.ts'), 'utf8')
    expect(shared).not.toMatch(/from ['"]electron['"]/)
    expect(shared).not.toMatch(/from ['"]node:/)
    expect(shared).not.toMatch(/require\(['"]node:/)
  })
})

describe('Sidecar forwarding with readiness protection (ticket #129)', () => {
  it('parses structured stderr lines into method-and-route-only fields', () => {
    const parsed = parseSidecarStderrLine(
      'WATCHTOWER_LEDGER_LOG {"event":"ledger-mcp.request-error","method":"POST","route":"/mcp","code":"internal"}',
    )
    expect(parsed).toMatchObject({ event: 'ledger-mcp.request-error', method: 'POST', route: '/mcp' })
  })

  it('drops bodies, tokens and ledger facts from stderr lines and ignores preamble', () => {
    const parsed = parseSidecarStderrLine(
      'WATCHTOWER_LEDGER_LOG {"event":"ledger-mcp.request-error","method":"POST","route":"/mcp","body":{"prompt":"secret"},"token":"Bearer sk-secret"}',
    )
    const text = JSON.stringify(parsed)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('sk-secret')
    expect(parseSidecarStderrLine('(node:123) ExperimentalWarning: foo')).toBeNull()
    expect(parseSidecarStderrLine('watchtower-ledger(http): some plain line')).toBeNull()
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
    const { EventEmitter } = await import('node:events')
    const { PassThrough } = await import('node:stream')
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
    expect(stderrBytes.join('')).toContain('WATCHTOWER_LEDGER_LOG')
    expect(stderrBytes.join('')).toContain('/mcp')

    const child = new EventEmitter() as unknown as import('node:child_process').ChildProcess
    const stdout = new PassThrough()
    const pending = readReadyPort(child, stdout)
    for (let i = 0; i < 50; i++) stdout.write(`(node:${i}) ExperimentalWarning: logging load ${i}\n`)
    stdout.write('READY {"port":4567}\n')
    await expect(pending).resolves.toBe(4567)
  })
})

describe('Renderer tripwire + Harness and update lifecycle (ticket #130)', () => {
  it('forwards tripwire rejections with label and location only — no payload contents', async () => {
    const { z } = await import('zod')
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

  it('keeps the renderer free of direct log-file writes', async () => {
    const { readFileSync } = await import('node:fs')
    const { join: joinPath, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const text = readFileSync(joinPath(here, '..', 'src', 'renderer', 'src', 'shared', 'lib', 'api.ts'), 'utf8')
    expect(text).not.toMatch(/node:fs/)
    expect(text).not.toMatch(/writeFile/)
  })
})

describe('Ad-hoc write sweep + single-file integrate-and-verify (ticket #131)', () => {
  it('keeps zero console.* writes in app code', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join: joinPath, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const root = joinPath(here, '..', 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = joinPath(dir, entry.name)
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

  it('redaction sweep: hostile values through every public entry point never reach the record or disk', () => {
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
      initOperationalLog({ logDir, isPackaged: true })
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
        `WATCHTOWER_LEDGER_LOG ${JSON.stringify({ event: 'ledger-mcp.request-error', method: 'POST', route: '/mcp', body: secrets.requestBody, token: secrets.token })}`,
      )
      expect(JSON.stringify(parsedSidecar)).not.toContain(secrets.requestBody)
      expect(JSON.stringify(parsedSidecar)).not.toContain(secrets.token)
      closeOperationalLog()
      const raw = readFileSync(join(logDir, 'operational.log'), 'utf8')
      for (const secret of [secrets.prompt, secrets.token, secrets.fileContent, secrets.requestBody, secrets.ledgerFact]) {
        expect(raw).not.toContain(secret)
      }
      expect(raw).not.toContain('sweepsecret')
    } finally {
      try { closeOperationalLog() } catch { /* already closed */ }
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('interleaved worker and sidecar records across a forced rotation stay complete, parseable and within quota', () => {
    const parent = mkdtempSync(join(tmpdir(), 'watchtower-oplog-interleave-'))
    const logDir = join(parent, 'logs')
    try {
      initOperationalLog({ logDir, isPackaged: true, maxFileBytes: 500, maxGenerations: 2 })
      for (let i = 0; i < 30; i++) {
        if (i % 3 === 0) recordOperationalLog('worker', 'scan.finish', { manual: false, count: i, unparsed: [{ provider: 'claude', unparsed: i }] })
        else if (i % 3 === 1) recordOperationalLog('sidecar', 'ledger-mcp.request-error', { method: 'POST', route: '/mcp', code: 'internal' })
        else recordOperationalLog('renderer', 'renderer.tripwire', { label: 'scan status', location: 'broadcast' })
      }
      closeOperationalLog()
      const files = readdirSync(logDir).filter((f: string) => f.startsWith('operational.log'))
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
          expect(parsed['timestamp'] ?? parsed['time']).toBeDefined()
          expect(typeof parsed['context']).toBe('string')
          expect(typeof parsed['event']).toBe('string')
          contexts.add(parsed['context'] as string)
        }
      }
      expect(total).toBeLessThanOrEqual(3 * 1024)
      expect(contexts.has('worker')).toBe(true)
      expect(contexts.has('sidecar')).toBe(true)
    } finally {
      try { closeOperationalLog() } catch { /* already closed */ }
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
