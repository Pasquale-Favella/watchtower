import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'

import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LedgerMcpSpawnContext } from '../src/platform/mcp/config.js'
import { LedgerMcpSidecar, ledgerMcpSidecarLayer, type LedgerMcpSidecarOptions } from '../src/platform/mcp/sidecar.js'

const CTX: LedgerMcpSpawnContext = { execPath: '/bin/app', entryPath: '/app/ledger-mcp.js', dbPath: '/data/ledger.db' }

class FakeChild extends EventEmitter {
  readonly stdout: PassThrough | null
  readonly stderr: PassThrough | null
  kills = 0
  private closed = false

  constructor(options: { stdout?: boolean; stderr?: boolean } = {}) {
    super()
    this.stdout = options.stdout === false ? null : new PassThrough()
    this.stderr = options.stderr === false ? null : new PassThrough()
  }

  kill(): boolean {
    this.kills++
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.stdout?.end()
    this.stderr?.end()
    this.emit('close', 0, null)
  }
}

const fixtures: Array<{ runtime: ManagedRuntime.ManagedRuntime<never, never>; child: FakeChild }> = []

afterEach(async () => {
  const active = fixtures.splice(0)
  for (const fixture of active) fixture.child.close()
  await Promise.all(
    active.map(async ({ runtime }) => {
      try {
        await runtime.dispose()
      } catch {
        /* keep a failed test from leaking its native Effect scope */
      }
    }),
  )
})

function makeRuntime(
  child: FakeChild,
  options: Pick<LedgerMcpSidecarOptions, 'createStderrReader'> & {
    fetch?: typeof globalThis.fetch
  } = {},
) {
  const fetcher = options.fetch ?? vi.fn(async () => new Response(null, { status: 200 }))
  const spawnChild = vi.fn(() => child) as unknown as typeof spawn
  const runtime = ManagedRuntime.make(ledgerMcpSidecarLayer({ ...options, spawnChild, fetch: fetcher }))
  fixtures.push({ runtime, child })
  const start = () => {
    const pending = runtime.runPromise(Effect.flatMap(LedgerMcpSidecar, service => service.start(CTX)))
    void pending.catch(() => {})
    return pending
  }
  return { runtime, start, spawnChild, fetcher }
}

async function waitForReadyListener(child: FakeChild): Promise<void> {
  await vi.waitFor(() => expect(child.stdout?.listenerCount('data')).toBeGreaterThan(0))
}

describe('native ledger MCP sidecar lifetime', () => {
  it('starts lazily, reads READY, confirms health, and closes only after release', async () => {
    const child = new FakeChild()
    const { runtime, start, spawnChild, fetcher } = makeRuntime(child)
    expect(spawnChild).not.toHaveBeenCalled()

    const pendingStart = start()
    await waitForReadyListener(child)
    child.stdout?.write('READY {"port":45123}\n')
    const started = await pendingStart

    expect(started.server).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:45123/mcp',
      headers: [{ name: 'Authorization', value: expect.stringMatching(/^Bearer /) }],
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(spawnChild).toHaveBeenCalledWith(
      CTX.execPath,
      [CTX.entryPath, '--ledger-mcp-http'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )

    runtime.runSync(started.release)
    runtime.runSync(started.release)
    expect(child.kills).toBe(1)
    let disposed = false
    const disposing = runtime.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    child.close()
    await disposing
    expect(disposed).toBe(true)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('cancels the health response body after checking its status', async () => {
    const child = new FakeChild()
    let bodyCanceled = false
    const body = new ReadableStream({
      cancel() {
        bodyCanceled = true
      },
    })
    const fetch = vi.fn(async () => new Response(body, { status: 200 }))
    const { runtime, start } = makeRuntime(child, { fetch })
    const pendingStart = start()
    await waitForReadyListener(child)
    child.stdout?.write('READY {"port":45123}\n')
    const started = await pendingStart

    expect(bodyCanceled).toBe(true)
    runtime.runSync(started.release)
    child.close()
    await runtime.dispose()
  })

  it('kills and closes a child with no stdout', async () => {
    const child = new FakeChild({ stdout: false })
    const { runtime, start } = makeRuntime(child)
    const pending = expect(start()).rejects.toThrow('has no stdout')
    await vi.waitFor(() => expect(child.kills).toBe(1))
    child.close()
    await pending
    await runtime.dispose()
    expect(child.kills).toBe(1)
  })

  it('cleans up when the child exits before READY', async () => {
    const child = new FakeChild()
    const { runtime, start } = makeRuntime(child)
    const pending = expect(start()).rejects.toThrow('exited early')
    await waitForReadyListener(child)
    child.emit('exit', 9)
    await vi.waitFor(() => expect(child.kills).toBe(1))
    child.close()
    await pending
    await runtime.dispose()
    expect(child.kills).toBe(1)
    expect(child.stdout?.listenerCount('data')).toBe(0)
  })

  it('observes spawn error and close events emitted on the next tick', async () => {
    const child = new FakeChild()
    const spawnChild = vi.fn(() => {
      process.nextTick(() => {
        child.emit('error', new Error('async spawn failed'))
        child.close()
      })
      return child
    }) as unknown as typeof spawn
    const runtime = ManagedRuntime.make(ledgerMcpSidecarLayer({ spawnChild }))
    fixtures.push({ runtime, child })

    await expect(runtime.runPromise(Effect.flatMap(LedgerMcpSidecar, service => service.start(CTX)))).rejects.toThrow(
      'async spawn failed',
    )
    expect(child.kills).toBe(1)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('cleans up when READY startup is interrupted', async () => {
    const child = new FakeChild()
    const { runtime } = makeRuntime(child)
    const controller = new AbortController()
    const pending = runtime.runPromise(
      Effect.flatMap(LedgerMcpSidecar, service => service.start(CTX)),
      { signal: controller.signal },
    )
    await waitForReadyListener(child)
    const result = pending.then(
      () => false,
      () => true,
    )
    controller.abort()
    await vi.waitFor(() => expect(child.kills).toBe(1))
    child.close()
    await expect(result).resolves.toBe(true)
    await runtime.dispose()
    expect(child.stdout?.listenerCount('data')).toBe(0)
  })

  it('owns pending READY startup through runtime disposal and waits for close', async () => {
    const child = new FakeChild()
    const { runtime, start, fetcher } = makeRuntime(child)
    const pendingStart = start()
    const rejected = expect(pendingStart).rejects.toBeDefined()
    await waitForReadyListener(child)

    let disposed = false
    const disposing = runtime.dispose().then(() => {
      disposed = true
    })
    await vi.waitFor(() => expect(child.kills).toBe(1))
    await Promise.resolve()
    expect(disposed).toBe(false)
    child.close()
    await Promise.all([disposing, rejected])

    expect(disposed).toBe(true)
    expect(child.stdout?.listenerCount('data')).toBe(0)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('closes the spawned child when stderr reader setup fails', async () => {
    const child = new FakeChild()
    const createStderrReader = vi.fn(() => {
      throw new Error('reader setup failed')
    }) as unknown as typeof createInterface
    const { runtime, start } = makeRuntime(child, { createStderrReader })
    const pending = expect(start()).rejects.toThrow('reader setup failed')
    await vi.waitFor(() => expect(child.kills).toBe(1))
    child.close()
    await pending
    await runtime.dispose()
    expect(child.kills).toBe(1)
  })

  it('maps synchronous spawn failure through the start error channel', async () => {
    const spawnChild = vi.fn(() => {
      throw new Error('spawn failed')
    }) as unknown as typeof spawn
    const runtime = ManagedRuntime.make(ledgerMcpSidecarLayer({ spawnChild }))
    await expect(runtime.runPromise(Effect.flatMap(LedgerMcpSidecar, service => service.start(CTX)))).rejects.toThrow(
      'spawn failed',
    )
    await runtime.dispose()
  })
})
