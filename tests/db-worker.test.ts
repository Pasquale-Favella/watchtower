import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DbWorkerClient, type DbWorkerPort } from '../src/main/db-worker/client.js'
import { DbWorkerContext } from '../src/main/db-worker/context.js'
import type { DbWorkerEvent } from '../src/main/db-worker/protocol.js'

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'watchtower-dbworker-'))
}

describe('DbWorkerContext ops (ADR 0023)', () => {
  let dir = ''
  let ctx: DbWorkerContext | null = null
  const events: DbWorkerEvent[] = []

  function open(): DbWorkerContext {
    dir = tempDataDir()
    ctx = new DbWorkerContext(
      { dbPath: join(dir, 'ledger.db'), dataDir: dir, cacheDir: join(dir, 'cache') },
      event => { events.push(event) },
    )
    return ctx
  }

  afterEach(() => {
    events.length = 0
    try { ctx?.close() } catch { /* already closed */ }
    ctx = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('reports an unscanned status on a fresh ledger', async () => {
    const status = await open().dispatch('store:status', []) as { scanned: boolean }
    expect(status.scanned).toBe(false)
  })

  it('round-trips the refresh cadence and reschedules without throwing', async () => {
    const c = open()
    expect(await c.dispatch('cadence:get', [])).toBe('1m')
    expect(await c.dispatch('cadence:set', ['5m'])).toBe('5m')
    expect(await c.dispatch('cadence:get', [])).toBe('5m')
  })

  it('writes model aliases with a config:changed event and validates input', async () => {
    const c = open()
    expect(await c.dispatch('models:addAlias', ['foo-model', 'gpt-4'])).toEqual({ ok: true })
    expect(events).toContainEqual({ event: 'config:changed' })
    expect(await c.dispatch('models:getAliases', [])).toEqual([{ model: 'foo-model', aliasOf: 'gpt-4' }])
    await expect(c.dispatch('models:addAlias', ['', 'gpt-4'])).rejects.toThrow(/non-empty/)
    expect(await c.dispatch('models:removeAlias', ['foo-model'])).toEqual({ ok: true })
    expect(await c.dispatch('models:getAliases', [])).toEqual([])
  })

  it('writes price overrides and validates input', async () => {
    const c = open()
    expect(await c.dispatch('models:setPrice', ['foo-model', 1, 2])).toEqual({ ok: true })
    expect(await c.dispatch('models:getPriceOverrides', [])).toEqual([
      { model: 'foo-model', inputPricePerMillion: 1, outputPricePerMillion: 2 },
    ])
    await expect(c.dispatch('models:setPrice', ['foo-model', -1, 2])).rejects.toThrow(/non-negative/)
    expect(await c.dispatch('models:removePriceOverride', ['foo-model'])).toEqual({ ok: true })
  })

  it('records skill dismissals', async () => {
    const c = open()
    expect(await c.dispatch('skills:dismiss', [{ source: 'bash', name: 'git commit', reason: 'one-off' }]))
      .toEqual({ ok: true })
  })

  it('answers an empty overview with a null dataStart', async () => {
    const payload = await open().dispatch('overview:query', [{ period: 'today' }]) as { dataStart: null }
    expect(payload.dataStart).toBeNull()
  })

  it('serves currency reads locally and rejects bogus codes', async () => {
    const c = open()
    expect(await c.dispatch('currency:get', [])).toMatchObject({ code: 'USD', rate: 1 })
    expect(Array.isArray(await c.dispatch('currency:list', []))).toBe(true)
    await expect(c.dispatch('currency:set', ['ZZZ'])).rejects.toThrow(/ISO 4217/)
  })

  it('persists the local ledger MCP startup mode and defaults to on-demand', async () => {
    const c = open()
    expect(await c.dispatch('ledger-mcp:startup:get', [])).toBe('on-demand')
    expect(await c.dispatch('ledger-mcp:startup:set', ['at-launch'])).toBe('at-launch')
    expect(await c.dispatch('ledger-mcp:startup:get', [])).toBe('at-launch')
    expect(await c.dispatch('ledger-mcp:startup:set', ['invalid'])).toBe('on-demand')
  })

  it('reports settings sizes for the temp data dir', async () => {
    const info = await open().dispatch('settings:info', []) as { dataDir: string; dbSize: number }
    expect(info.dataDir).toBe(dir)
    expect(info.dbSize).toBeGreaterThan(0)
  })

  it('scan:abort is a no-op without a running scan and unknown ops throw', async () => {
    const c = open()
    await expect(c.dispatch('scan:abort', [])).resolves.toBeNull()
    await expect(c.dispatch('unknown:op', [])).rejects.toThrow(/unknown db-worker op/)
  })

  it('shuts down idempotently for the quit path', async () => {
    const c = open()
    await expect(c.dispatch('shutdown', [])).resolves.toBeNull()
    await expect(c.dispatch('shutdown', [])).resolves.toBeNull()
  })
})

/** In-memory stand-in for a worker thread: echoes requests back on demand. */
class FakeWorker {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  posted: unknown[] = []

  constructor(private behavior: (req: { id: number; op: string; args: unknown[] }) => void) {}

  postMessage(message: unknown): void {
    this.posted.push(message)
    // Async like a real thread hop: the request stays pending until the test
    // drives the fake's next step (response, error, or exit).
    queueMicrotask(() => this.behavior(message as { id: number; op: string; args: unknown[] }))
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

type Responder = (fake: FakeWorker, req: { id: number; op: string; args: unknown[] }) => void

const echoResponder: Responder = (fake, req) => {
  fake.emit('message', { id: req.id, ok: true, data: { op: req.op, args: req.args } })
}

function makeClient(responder: Responder = echoResponder, onFake?: (fake: FakeWorker) => void): { client: DbWorkerClient; fakes: FakeWorker[] } {
  const fakes: FakeWorker[] = []
  const client = new DbWorkerClient(
    { dbPath: ':memory:', dataDir: ':memory:', cacheDir: ':memory:' },
    'fake-worker.js',
    () => {
      const fake = new FakeWorker(req => responder(fake, req))
      fakes.push(fake)
      onFake?.(fake)
      return fake as unknown as DbWorkerPort
    },
  )
  return { client, fakes }
}

describe('DbWorkerClient request/response correlation', () => {
  it('resolves concurrent requests to the right caller', async () => {
    const { client } = makeClient()
    const [a, b] = await Promise.all([
      client.request('overview:query', { period: 'today' }),
      client.request('currency:get'),
    ])
    expect(a).toEqual({ op: 'overview:query', args: [{ period: 'today' }] })
    expect(b).toEqual({ op: 'currency:get', args: [] })
    await client.terminate()
  })

  it('rejects when the worker reports an op error', async () => {
    const { client } = makeClient((fake, req) => {
      fake.emit('message', { id: req.id, ok: false, error: 'boom' })
    })
    await expect(client.request('models:addAlias', ['', ''])).rejects.toThrow('boom')
    await client.terminate()
  })

  it('routes worker broadcasts to event listeners', async () => {
    const { client, fakes } = makeClient()
    const seen: DbWorkerEvent[] = []
    client.onEvent(event => { seen.push(event) })
    fakes[0]!.emit('message', { event: 'store:changed', metadata: { portedFiles: 1 } })
    expect(seen).toEqual([{ event: 'store:changed', metadata: { portedFiles: 1 } }])
    await client.terminate()
  })

  it('rejects in-flight requests and respawns after a live worker exits', async () => {
    const spawn = vi.fn()
    const { client, fakes } = makeClient(echoResponder, () => { spawn() })
    expect(spawn).toHaveBeenCalledTimes(1)
    fakes[0]!.emit('message', { event: 'ready' })
    await expect(client.ready).resolves.toBeUndefined()
    const pending = client.request('overview:query', {})
    fakes[0]!.emit('exit', 1)
    await expect(pending).rejects.toThrow(/exited unexpectedly/)
    expect(spawn).toHaveBeenCalledTimes(2)
    // The respawned worker serves new requests once it is ready.
    fakes[1]!.emit('message', { event: 'ready' })
    await expect(client.request('currency:get')).resolves.toEqual({ op: 'currency:get', args: [] })
    await client.terminate()
  })

  it('resolves ready on the boot handshake', async () => {
    const { client, fakes } = makeClient()
    fakes[0]!.emit('message', { event: 'ready' })
    await expect(client.ready).resolves.toBeUndefined()
    await client.terminate()
  })

  it('never respawns a worker that failed to boot and rejects with its error', async () => {
    const spawn = vi.fn()
    const { client, fakes } = makeClient(echoResponder, () => { spawn() })
    fakes[0]!.emit('message', { event: 'init-error', error: 'cannot open ledger.db' })
    await expect(client.ready).rejects.toThrow('cannot open ledger.db')
    const pending = client.request('overview:query', {})
    fakes[0]!.emit('exit', 1)
    await expect(pending).rejects.toThrow('cannot open ledger.db')
    // No hot loop: a worker that never lived is not recreated.
    expect(spawn).toHaveBeenCalledTimes(1)
    await client.terminate()
  })

  it('settles ready on a pre-boot thread error without respawning', async () => {
    const spawn = vi.fn()
    const { client, fakes } = makeClient(echoResponder, () => { spawn() })
    fakes[0]!.emit('error', new Error('thread blew up during init'))
    await expect(client.ready).rejects.toThrow('thread blew up during init')
    fakes[0]!.emit('exit', 1)
    // The exit that follows a failed boot must not recreate the worker.
    expect(spawn).toHaveBeenCalledTimes(1)
    await client.terminate()
  })

  it('coalesces identical concurrent reads into one execution', async () => {
    const { client, fakes } = makeClient()
    const [a, b] = await Promise.all([
      client.request('overview:query', { period: 'today' }),
      client.request('overview:query', { period: 'today' }),
    ])
    expect(fakes[0]!.posted).toHaveLength(1)
    expect(a).toEqual(b)
    await client.terminate()
  })

  it('does not coalesce distinct args or writes', async () => {
    const { client, fakes } = makeClient()
    await Promise.all([
      client.request('overview:query', { period: 'today' }),
      client.request('overview:query', { period: 'week' }),
      client.request('scan:start'),
      client.request('scan:start'),
    ])
    expect(fakes[0]!.posted).toHaveLength(4)
    await client.terminate()
  })

  it('shutdown asks the worker to close and terminates the thread', async () => {
    const { client, fakes } = makeClient()
    fakes[0]!.emit('message', { event: 'ready' })
    await client.shutdown()
    // The first post is the graceful close op; the thread is then gone.
    expect(fakes[0]!.posted[0]).toMatchObject({ op: 'shutdown', args: [] })
    await expect(client.request('currency:get')).rejects.toThrow(/shut down|unavailable/)
  })
})
