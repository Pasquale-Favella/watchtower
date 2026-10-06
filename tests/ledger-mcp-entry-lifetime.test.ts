import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { serveHttp, serveStdio } from '../src/main/agents/ledger-mcp/entry.js'
import type { LedgerMcpQueries } from '../src/main/agents/ledger-mcp/query-api.js'
import { createLedgerMcpQueryRuntime } from '../src/main/agents/ledger-mcp/query-runtime.js'
import { LedgerStore } from '../src/main/store/ledger.js'

const TOKEN = 'entry-lifetime-test-token'

function makeDatabase(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-ledger-mcp-entry-'))
  const dbPath = join(dir, 'ledger.db')
  new LedgerStore(dbPath).close()
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function fakeRuntime(dispose: () => Promise<void>) {
  return {
    queries: {} as LedgerMcpQueries,
    run: <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect),
    dispose,
  }
}

function waitForReady(): { ready: Promise<number>; restore: () => void } {
  const originalWrite = process.stdout.write
  let resolveReady!: (port: number) => void
  const ready = new Promise<number>(resolve => {
    resolveReady = resolve
  })
  process.stdout.write = function (chunk: string | Uint8Array, ...args: unknown[]): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const match = /^READY (.+)$/m.exec(text)
    if (match?.[1]) resolveReady(JSON.parse(match[1]).port as number)
    return originalWrite.call(process.stdout, chunk, ...(args as [never]))
  } as typeof process.stdout.write
  return {
    ready,
    restore: () => {
      process.stdout.write = originalWrite
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ledger MCP scoped process lifetime', () => {
  it('serves HTTP until SIGTERM, then drains the listener and disposes its owner once', async () => {
    let disposals = 0
    const dir = mkdtempSync(join(tmpdir(), 'watchtower-ledger-mcp-entry-'))
    const dbPath = join(dir, 'ledger.db')
    new LedgerStore(dbPath).close()
    let queryOwner: Awaited<ReturnType<typeof createLedgerMcpQueryRuntime>> | undefined
    const output = waitForReady()
    const serving = serveHttp({ dbPath, token: TOKEN }, async path => {
      const owner = await createLedgerMcpQueryRuntime(path)
      queryOwner = owner
      return {
        ...owner,
        dispose: async () => {
          disposals += 1
          await owner.dispose()
        },
      }
    })

    try {
      const port = await output.ready
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(disposals).toBe(0)
      if (!queryOwner) throw new Error('query runtime did not start')
      await expect(queryOwner.queries.scope({ period: 'lifetime' })).resolves.toMatchObject({
        calls: 0,
        sessions: 0,
      })

      process.emit('SIGTERM')
      await serving
      expect(disposals).toBe(1)
    } finally {
      output.restore()
      if (disposals === 0) process.emit('SIGTERM')
      await serving
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('releases the owner after a native listen failure and never announces READY', async () => {
    let disposals = 0
    const output = waitForReady()
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function () {
      throw Object.assign(new Error('listen failed'), { code: 'EADDRINUSE' })
    })

    await expect(
      serveHttp({ dbPath: 'unused', token: TOKEN }, async () => fakeRuntime(async () => void (disposals += 1))),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })

    expect(disposals).toBe(1)
    expect(listen).toHaveBeenCalledOnce()
    output.restore()
    await expect(Promise.race([output.ready, Promise.resolve('not-ready')])).resolves.toBe('not-ready')
  })

  it('waits for a pending native listen after shutdown and never publishes a late READY', async () => {
    let disposals = 0
    const output = waitForReady()
    const originalListen = Server.prototype.listen
    let nativeListenStarted = false
    let startNativeListen!: () => void
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
      startNativeListen = () => {
        if (nativeListenStarted) return
        nativeListenStarted = true
        Reflect.apply(originalListen, this, [0, '127.0.0.1'])
      }
      return this
    })
    const serving = serveHttp({ dbPath: 'unused', token: TOKEN }, async () =>
      fakeRuntime(async () => void (disposals += 1)),
    )

    try {
      await vi.waitFor(() => expect(startNativeListen).toBeTypeOf('function'))
      process.emit('SIGTERM')
      expect(disposals).toBe(0)
      startNativeListen()
      await serving
      expect(disposals).toBe(1)
      await expect(Promise.race([output.ready, Promise.resolve('not-ready')])).resolves.toBe('not-ready')
    } finally {
      output.restore()
      if (disposals === 0) process.emit('SIGTERM')
      startNativeListen?.()
      await serving
    }
  })

  it('closes an HTTP client stalled on a partial authenticated request during SIGTERM', async () => {
    const database = makeDatabase()
    let disposals = 0
    const output = waitForReady()
    const serving = serveHttp({ dbPath: database.dbPath, token: TOKEN }, async path => {
      const owner = await createLedgerMcpQueryRuntime(path)
      return {
        ...owner,
        dispose: async () => {
          disposals += 1
          await owner.dispose()
        },
      }
    })
    let client: ReturnType<typeof httpRequest> | undefined

    try {
      const port = await output.ready
      const pendingRequest = httpRequest(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'content-length': '1000',
        },
      })
      client = pendingRequest
      pendingRequest.on('error', () => {})
      await new Promise<void>(resolve => {
        pendingRequest.once('socket', socket => socket.once('connect', resolve))
      })
      pendingRequest.write('{"jsonrpc":')
      await new Promise<void>(resolve => setImmediate(resolve))

      process.emit('SIGTERM')
      await serving
      expect(disposals).toBe(1)
    } finally {
      output.restore()
      client?.destroy()
      if (disposals === 0) process.emit('SIGTERM')
      await serving
      database.cleanup()
    }
  })

  it('stops when the parent disappears and removes its process handlers and poll timer', async () => {
    let disposals = 0
    const output = waitForReady()
    const signalListeners = {
      sigint: process.listeners('SIGINT'),
      sigterm: process.listeners('SIGTERM'),
    }
    const interval = vi.spyOn(globalThis, 'setInterval')
    const clearTimer = vi.spyOn(globalThis, 'clearInterval')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('parent is gone'), { code: 'ESRCH' })
    })
    const serving = serveHttp({ dbPath: 'unused', token: TOKEN }, async () =>
      fakeRuntime(async () => void (disposals += 1)),
    )

    try {
      await output.ready
      const checkParent = interval.mock.calls.at(-1)?.[0] as (() => void) | undefined
      expect(checkParent).toBeDefined()
      checkParent?.()
      await serving
      expect(disposals).toBe(1)
      expect(process.listeners('SIGINT')).toEqual(signalListeners.sigint)
      expect(process.listeners('SIGTERM')).toEqual(signalListeners.sigterm)
      expect(clearTimer).toHaveBeenCalledWith(interval.mock.results.at(-1)?.value)
    } finally {
      output.restore()
      if (disposals === 0) process.emit('SIGTERM')
      await serving
    }
  })

  it('waits for stdio connect to settle after EOF before disposing the real query owner', async () => {
    const database = makeDatabase()
    const signalListeners = {
      sigint: process.listeners('SIGINT'),
      sigterm: process.listeners('SIGTERM'),
    }
    const stdinListeners = process.stdin.listeners('end')
    let disposals = 0
    let finishConnect!: () => void
    let allowTransportClose!: () => void
    let onTransportCloseStarted!: () => void
    const connectStarted = new Promise<void>(resolve => {
      onTransportCloseStarted = resolve
    })
    const closeGate = new Promise<void>(resolve => {
      allowTransportClose = resolve
    })
    let closed = false
    const protocol = {
      server: {
        connect: () => new Promise<void>(resolve => (finishConnect = resolve)),
        close: async () => {},
        onclose: undefined as (() => void) | undefined,
      },
      transport: {
        close: async () => {
          if (closed) return
          onTransportCloseStarted()
          await closeGate
          closed = true
          finishConnect()
          protocol.server.onclose?.()
        },
      } as unknown as StdioServerTransport,
    }
    const serving = serveStdio(
      database.dbPath,
      async path => {
        const owner = await createLedgerMcpQueryRuntime(path)
        return {
          ...owner,
          dispose: async () => {
            disposals += 1
            await owner.dispose()
          },
        }
      },
      () => protocol,
    )

    try {
      await vi.waitFor(() => expect(finishConnect).toBeTypeOf('function'))
      const eofListener = process.stdin.listeners('end').find(listener => !stdinListeners.includes(listener))
      expect(eofListener).toBeDefined()
      eofListener?.call(process.stdin)
      await connectStarted
      expect(disposals).toBe(0)

      allowTransportClose()
      await serving
      expect(disposals).toBe(1)
      expect(process.listeners('SIGINT')).toEqual(signalListeners.sigint)
      expect(process.listeners('SIGTERM')).toEqual(signalListeners.sigterm)
      expect(process.stdin.listeners('end')).toEqual(stdinListeners)
    } finally {
      allowTransportClose()
      await serving
      database.cleanup()
    }
  })

  it('releases the stdio owner after connect failure and removes process listeners', async () => {
    const database = makeDatabase()
    const signalListeners = {
      sigint: process.listeners('SIGINT'),
      sigterm: process.listeners('SIGTERM'),
    }
    const stdinListeners = process.stdin.listeners('end')
    let disposals = 0
    const protocol = {
      server: {
        connect: async () => {
          throw new Error('connect failed')
        },
        close: async () => {},
      },
      transport: { close: async () => {} } as unknown as StdioServerTransport,
    }

    try {
      await expect(
        serveStdio(
          database.dbPath,
          async path => {
            const owner = await createLedgerMcpQueryRuntime(path)
            return {
              ...owner,
              dispose: async () => {
                disposals += 1
                await owner.dispose()
              },
            }
          },
          () => protocol,
        ),
      ).rejects.toThrow('connect failed')
      expect(disposals).toBe(1)
      expect(process.listeners('SIGINT')).toEqual(signalListeners.sigint)
      expect(process.listeners('SIGTERM')).toEqual(signalListeners.sigterm)
      expect(process.stdin.listeners('end')).toEqual(stdinListeners)
    } finally {
      database.cleanup()
    }
  })
})
