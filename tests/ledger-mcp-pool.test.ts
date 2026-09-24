import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { Effect, Fiber } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import type { AcpMcpServer } from '../src/main/agents/harnesses/types.js'
import type { LedgerMcpSpawnContext } from '../src/main/agents/ledger-mcp/config.js'
import { createSidecarPool } from '../src/main/agents/ledger-mcp/pool.js'
import type { StartedLedgerMcpHttp } from '../src/main/agents/ledger-mcp/sidecar.js'
import { parseReadyPort, readReadyPort, readReadyPortEffect } from '../src/main/agents/ledger-mcp/sidecar.js'

const CTX: LedgerMcpSpawnContext = { execPath: '/bin/app', entryPath: '/app/ledger-mcp.js', dbPath: '/data/ledger.db' }

function httpServer(port: number): AcpMcpServer {
  return {
    type: 'http',
    name: 'watchtower-ledger',
    url: `http://127.0.0.1:${port}/mcp`,
    headers: [{ name: 'Authorization', value: 'Bearer test' }],
  }
}

interface FakeSidecar extends StartedLedgerMcpHttp {
  released: boolean
}

/** A controllable sidecar: health answers from a mutable flag, release is
 *  observable — so the tests prove reuse, respawn, and kill behavior without
 *  spawning anything. */
function fakeSidecar(healthy: () => boolean): FakeSidecar {
  const fake: FakeSidecar = {
    server: httpServer(9_999),
    release: () => {
      fake.released = true
    },
    checkHealth: async () => healthy(),
    released: false,
  }
  return fake
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function trackRelease(started: FakeSidecar, onRelease: (sidecar: FakeSidecar) => void): void {
  const release = started.release
  started.release = () => {
    onRelease(started)
    release()
  }
}

describe('sidecar ready announcement (parent-side port handoff)', () => {
  it('parses the READY line the child prints after binding', () => {
    expect(parseReadyPort('READY {"port":54321}')).toBe(54_321)
  })

  it('rejects anything that is not a valid READY line — never something to connect to', () => {
    expect(() => parseReadyPort('listening on 54321')).toThrow()
    expect(() => parseReadyPort('READY not-json')).toThrow()
    expect(() => parseReadyPort('READY {"port":0}')).toThrow()
    expect(() => parseReadyPort('READY {"port":65536}')).toThrow()
    expect(() => parseReadyPort('READY {"port":1.5}')).toThrow()
    expect(() => parseReadyPort('READY {}')).toThrow()
  })

  it('skips preamble lines before the READY announcement', async () => {
    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new PassThrough()
    const pending = readReadyPort(child, stdout)
    stdout.write('(node:12345) ExperimentalWarning: SQLite is experimental\n')
    stdout.write('some banner line\nREADY {"port":4567}\n')
    await expect(pending).resolves.toBe(4567)
  })

  it('fails fast on a corrupt READY line instead of burning the timeout', async () => {
    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new PassThrough()
    const pending = readReadyPort(child, stdout)
    stdout.write('READY {"port":0}\n')
    await expect(pending).rejects.toThrow('invalid port')
  })

  it('rejects when the child exits before announcing', async () => {
    const emitter = new EventEmitter()
    const child = emitter as unknown as ChildProcess
    const stdout = new PassThrough()
    const pending = readReadyPort(child, stdout)
    emitter.emit('exit', 1)
    await expect(pending).rejects.toThrow('exited early')
  })
})

describe('sidecar pool (one app-level sidecar for local MCP clients)', () => {
  it('reuses a healthy sidecar across turns — one spawn, per-run releases are no-ops', async () => {
    let spawns = 0
    const pool = createSidecarPool({
      spawn: async () => {
        spawns++
        return fakeSidecar(() => true)
      },
    })

    const first = await pool.acquire(CTX)
    expect(first?.server).toEqual(httpServer(9_999))
    first?.release()
    const second = await pool.acquire(CTX)
    second?.release()

    expect(spawns).toBe(1)
  })

  it('exposes the same healthy connection to Coach and local clients', async () => {
    let spawns = 0
    const pool = createSidecarPool({
      spawn: async () => {
        spawns++
        return fakeSidecar(() => true)
      },
    })

    const coach = await pool.connection(CTX)
    const local = await pool.connection(CTX)

    expect(local).toEqual(coach)
    expect(spawns).toBe(1)
    expect(await pool.status()).toEqual(coach)
  })

  it('regenerates the app-level sidecar and token on demand', async () => {
    let spawns = 0
    const released: FakeSidecar[] = []
    const pool = createSidecarPool({
      spawn: async () => {
        spawns++
        const started = fakeSidecar(() => true)
        trackRelease(started, sidecar => {
          released.push(sidecar)
        })
        started.server = { ...started.server, url: `http://127.0.0.1:${9_999 + spawns}/mcp` }
        return started
      },
    })

    const first = await pool.connection(CTX)
    const second = await pool.regenerate(CTX)

    expect(second).not.toEqual(first)
    expect(spawns).toBe(2)
    expect(released).toHaveLength(1)
  })

  it('respawns when the pooled sidecar died between turns — the dead one is released, never handed out', async () => {
    let spawns = 0
    let alive = true
    let lastReleased: FakeSidecar | null = null
    const pool = createSidecarPool({
      spawn: async () => {
        spawns++
        const started = fakeSidecar(() => alive)
        trackRelease(started, sidecar => {
          lastReleased = sidecar
        })
        return started
      },
    })

    await pool.acquire(CTX)
    alive = false
    const next = await pool.acquire(CTX)

    expect(next?.server).toEqual(httpServer(9_999))
    expect(spawns).toBe(2)
    expect(lastReleased?.released).toBe(true)
  })

  it('respawns when the health probe itself throws', async () => {
    let spawns = 0
    let failProbe = false
    const pool = createSidecarPool({
      spawn: async () => {
        spawns++
        const started = fakeSidecar(() => true)
        started.checkHealth = async () => {
          if (failProbe) throw new Error('probe blew up')
          return true
        }
        return started
      },
    })

    await pool.acquire(CTX)
    failProbe = true
    await pool.acquire(CTX)

    expect(spawns).toBe(2)
  })

  it('degrades to null when the spawn fails — the turn runs without data tools', async () => {
    const pool = createSidecarPool({
      spawn: async () => {
        throw new Error('no binary')
      },
    })

    expect(await pool.acquire(CTX)).toBeNull()
  })

  it('releaseAll kills the pooled sidecar and the next acquire spawns fresh', async () => {
    let spawns = 0
    const released: FakeSidecar[] = []
    const pool = createSidecarPool({
      spawn: async () => {
        spawns++
        const started = fakeSidecar(() => true)
        trackRelease(started, sidecar => {
          released.push(sidecar)
        })
        return started
      },
    })

    await pool.acquire(CTX)
    pool.releaseAll()
    expect(released).toHaveLength(1)

    await pool.acquire(CTX)
    expect(spawns).toBe(2)
  })

  it('a reset racing an in-flight spawn kills the orphan and degrades that turn to null', async () => {
    const gate = deferred<StartedLedgerMcpHttp>()
    const spawned = fakeSidecar(() => true)
    const pool = createSidecarPool({ spawn: () => gate.promise })

    const pending = pool.acquire(CTX)
    pool.releaseAll()
    gate.resolve(spawned)

    expect(await pending).toBeNull()
    expect(spawned.released).toBe(true)
  })

  it('coalesces rapid turns while a spawn is in flight — one sidecar, not one each', async () => {
    let spawns = 0
    const gate = deferred<StartedLedgerMcpHttp>()
    const pool = createSidecarPool({
      spawn: () => {
        spawns++
        return gate.promise
      },
    })

    const first = pool.acquire(CTX)
    const second = pool.acquire(CTX)
    gate.resolve(fakeSidecar(() => true))

    expect((await first)?.server).toEqual(httpServer(9_999))
    expect((await second)?.server).toEqual(httpServer(9_999))
    expect(spawns).toBe(1)
  })

  it('a reset between two spawns keeps tracking the live one — no duplicate spawn', async () => {
    const firstGate = deferred<StartedLedgerMcpHttp>()
    const secondGate = deferred<StartedLedgerMcpHttp>()
    const staleSidecar = fakeSidecar(() => true)
    const freshSidecar = fakeSidecar(() => true)
    let calls = 0
    const pool = createSidecarPool({
      spawn: () => {
        calls++
        return calls === 1 ? firstGate.promise : secondGate.promise
      },
    })

    const stale = pool.acquire(CTX)
    pool.releaseAll()
    // A new conversation starts while the stale spawn is still in flight.
    const next = pool.acquire(CTX)
    firstGate.resolve(staleSidecar)
    expect(await stale).toBeNull()
    expect(staleSidecar.released).toBe(true)

    // This acquire lands after the stale spawn's cleanup ran: it must share
    // the live in-flight spawn, not start a duplicate no acquire can reach.
    const late = pool.acquire(CTX)
    secondGate.resolve(freshSidecar)
    expect((await next)?.server).toEqual(httpServer(9_999))
    expect((await late)?.server).toEqual(httpServer(9_999))
    expect(calls).toBe(2)
    expect(freshSidecar.released).toBe(false)
  })

  it('releaseAll during a hung spawn degrades pending acquires immediately (Deferred interruption)', async () => {
    let spawns = 0
    const pool = createSidecarPool({
      spawn: () => {
        spawns++
        return new Promise<StartedLedgerMcpHttp>(() => {})
      },
    })

    const pending = pool.acquire(CTX)
    await new Promise(resolve => setTimeout(resolve, 0))
    pool.releaseAll()

    await expect(pending).resolves.toBeNull()
    expect(spawns).toBe(1)
  })
})

describe('sidecar READY deadline (Clock-governed)', () => {
  it('a hung READY hits the deadline via TestClock instead of hanging', async () => {
    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new PassThrough()
    let failure: unknown = null
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(readReadyPortEffect(child, stdout) as Effect.Effect<number, Error>)
        yield* TestClock.adjust(10_000 + 100)
        const result = yield* Fiber.await(fiber)
        if (result._tag === 'Failure') {
          failure = result.cause
        }
      }).pipe(Effect.provide(TestClock.layer())),
    )
    stdout.destroy()
    expect(failure).not.toBeNull()
    expect(String(failure)).toContain('did not become ready')
  })
})
