import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/main/agents/detect.js'
import type { AcpMcpServer } from '../src/main/agents/harnesses/types.js'
import { createCoachRunner, type HarnessSource, type LedgerMcpAttachment } from '../src/main/agents/ipc.js'
import type { LedgerMcpSpawnContext } from '../src/main/agents/ledger-mcp/config.js'
import { createSidecarPool } from '../src/main/agents/ledger-mcp/pool.js'
import type { StartedLedgerMcpHttp } from '../src/main/agents/ledger-mcp/sidecar.js'
import type { HarnessRuntime } from '../src/main/agents/runtime.js'
import type { CoachEvent } from '../src/shared/schemas/agents.js'

/**
 * The ledger MCP attachment's LIFETIME, as opposed to its payload: who ends a
 * run's claim on the ledger MCP server, and what happens to a run that never
 * settles at all.
 *
 * The property under test is the one a hand-called `release()` cannot give:
 * a run the app has stopped waiting for cannot keep a claim past the
 * conversation that made it. The evidence is a run whose generator is WEDGED
 * (it awaits a promise that never settles), because that is the only shape
 * where `for await` never reaches the `finally` — an ordinary interruption is
 * already covered by `agents-ipc.test.ts` and stays green here.
 */

const CTX: LedgerMcpSpawnContext = { execPath: '/bin/app', entryPath: '/app/ledger-mcp.js', dbPath: '/data/ledger.db' }

const harness: HarnessInfo = {
  name: 'claude',
  kind: 'claude',
  displayName: 'Claude Code',
  bin: 'C:\\bin\\claude-agent-acp.exe',
  scrubEnv: ['ANTHROPIC_API_KEY'],
  authStatus: 'configured',
}

const harnessSource: HarnessSource = {
  async list() {
    return []
  },
  async refresh() {
    return []
  },
  async get(instanceId) {
    return instanceId === 'claude'
      ? { instanceId, info: harness, status: 'ready', auth: { status: 'configured' } }
      : undefined
  },
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const request = { harnessKind: 'claude', prompt: 'Summarise my spend' }

/** A run whose generator NEVER settles: `return()` on it is queued behind an
 *  await that never resolves, so the pump's `finally` is unreachable. This is
 *  the wedged-ACP-child shape (a real child that stops answering) reduced to
 *  something a unit test can hold still. */
function wedgedRuntime(emit: (event: CoachEvent) => void): HarnessRuntime {
  return {
    async *run() {
      yield { kind: 'status', state: 'starting' }
      // Never settles: nothing below is ever reached, and the generator's
      // finally never runs.
      await new Promise<void>(() => {})
      emit({ kind: 'text', delta: 'unreachable' })
    },
    async inspect() {
      return {}
    },
  }
}

/** A run that streams forever on a timer, so `cancel`'s `return()` IS
 *  processed — the ordinary-interruption shape, kept as the non-regression
 *  counterpart to the wedged one. */
function streamingRuntime(): HarnessRuntime {
  return {
    async *run() {
      let i = 0
      yield { kind: 'status', state: 'starting' }
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 1))
        yield { kind: 'text', delta: `chunk-${i++}` }
      }
    },
    async inspect() {
      return {}
    },
  }
}

function httpServer(port: number): AcpMcpServer {
  return {
    type: 'http',
    name: 'watchtower-ledger',
    url: `http://127.0.0.1:${port}/mcp`,
    headers: [{ name: 'Authorization', value: 'Bearer test' }],
  }
}

/** A pool whose sidecars are observable: a counter for boots, a flag for kills,
 * and a mutable health answer. No child process, no socket — the property is
 *  about lifetimes, not about the loopback endpoint. */
function trackedPool() {
  const state = { boots: 0, healthy: true, live: 0, killed: 0 }
  const pool = createSidecarPool({
    spawn: async () => {
      state.boots++
      state.live++
      return {
        server: httpServer(9_000 + state.boots),
        release: () => {
          state.killed++
          state.live--
        },
        checkHealth: async () => state.healthy,
      } satisfies StartedLedgerMcpHttp
    },
  })
  return { pool, state }
}

/** The runner's `ledgerMcpServer` dep, wrapped so the test can count the
 *  runner's releases without reaching into the pool's own (no-op) one. */
function countingAttachmentSource(counter: { released: number }): {
  ledgerMcpServer: (harnessKind: string) => Promise<LedgerMcpAttachment | null>
} {
  return {
    ledgerMcpServer: async () => ({
      server: { name: 'watchtower-ledger', command: 'node', args: ['ledger-mcp.js', '--ledger-mcp'] },
      release: () => {
        counter.released++
      },
    }),
  }
}

afterEach(() => {
  // Same shape as the runner's own `deleteWorkspace`: a wedged run can still be
  // holding its temp dir, and an unguarded rm would fail the test for that.
  for (const dir of readdirSync(tmpdir())) {
    if (dir.startsWith('watchtower-coach-')) {
      try {
        rmSync(join(tmpdir(), dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        /* best effort */
      }
    }
  }
})

describe('ledger MCP attachment lifetime — a run the app stopped waiting for cannot keep its claim', () => {
  it('releases the attachment of an ABANDONED run when the conversation is torn down', async () => {
    const counter = { released: 0 }
    const runner = createCoachRunner({
      getRuntime: async () => wedgedRuntime(() => {}),
      harnesses: harnessSource,
      ...countingAttachmentSource(counter),
    })

    const ack = await runner.start(request, () => {})
    expect(ack.ok).toBe(true)
    await flush()
    // The run is wedged: the pump is parked on a promise that never settles,
    // so nothing has released the attachment yet. This is the whole premise —
    // without the conversation-level owner, the count would stay here.
    expect(counter.released).toBe(0)

    // The conversation ends (renderer `coach:reset`, or app quit via dispose).
    // `reset` awaits the 3s teardown barrier for the wedged generator, so the
    // claim must be observable BEFORE that wait — this asserts on the reset
    // promise racing the barrier rather than on the wait itself.
    const resetting = runner.reset()
    expect(counter.released).toBe(1)
    await resetting

    // Once only: the abandoned run's settle path can still fire later (it
    // cannot, but a duplicate release would be a double-free if it did).
    await flush()
    expect(counter.released).toBe(1)
  })

  it('still releases an INTERRUPTED run from its own settle path (the fast path is unchanged)', async () => {
    const counter = { released: 0 }
    const runner = createCoachRunner({
      getRuntime: async () => streamingRuntime(),
      harnesses: harnessSource,
      ...countingAttachmentSource(counter),
    })

    const ack = await runner.start(request, () => {})
    expect(ack.ok).toBe(true)
    if (ack.ok) await runner.cancel(ack.runId)

    // No reset: the run's own `finally` did the work, which is what makes the
    // conversation-level drain a backstop rather than a replacement.
    await vi.waitFor(() => expect(counter.released).toBe(1))
    await runner.reset()
    expect(counter.released).toBe(1)
  })

  it('releases every claim a crashed conversation made, not just the first', async () => {
    const counter = { released: 0 }
    const runner = createCoachRunner({
      getRuntime: async () => wedgedRuntime(() => {}),
      harnesses: harnessSource,
      ...countingAttachmentSource(counter),
    })

    await runner.start(request, () => {})
    await runner.start({ ...request, prompt: 'and my models' }, () => {})
    await flush()
    expect(counter.released).toBe(0)

    const resetting = runner.reset()
    // Two abandoned runs, two claims: a single-owner release would strand one.
    expect(counter.released).toBe(2)
    await resetting
  })

  it('does NOT claim the sidecar is dead: a reset releases the claim, ADR 0027 keeps the process', async () => {
    const { pool, state } = trackedPool()
    const runner = createCoachRunner({
      getRuntime: async () => wedgedRuntime(() => {}),
      harnesses: harnessSource,
      ledgerMcpServer: async () => pool.acquire(CTX),
    })

    await runner.start(request, () => {})
    await flush()
    expect(state.boots).toBe(1)
    expect(state.live).toBe(1)

    const resetting = runner.reset()
    await resetting

    // The honest half of the property, asserted so it cannot be read as
    // "a reset kills the endpoint": the sidecar is APP-scoped (ADR 0027 — a
    // local MCP client may be using it independently), so a conversation reset
    // leaves it running, and the next turn reuses it with no new boot.
    expect(state.killed).toBe(0)
    expect(state.live).toBe(1)
    const reused = await pool.acquire(CTX)
    expect(reused?.server).toEqual(httpServer(9_001))
    expect(state.boots).toBe(1)
    reused?.release()

    // App quit is the other end of the same lifetime, and it kills it.
    pool.releaseAll()
    expect(state.killed).toBe(1)
    expect(state.live).toBe(0)
  })
})

describe('sidecar pool lifetime — one app-scoped process, and who may end it', () => {
  it('shares ONE sidecar across concurrent acquisitions and the app keeps it until quit', async () => {
    const { pool, state } = trackedPool()

    const first = pool.acquire(CTX)
    const second = pool.acquire(CTX)
    const [a, b] = await Promise.all([first, second])

    expect(state.boots).toBe(1)
    expect(a?.server).toEqual(b?.server)

    // The count, not a boolean: the app's own claim is permanent (ADR 0027),
    // so dropping run claims can never be the last release. The flip is the
    // intermediate assertion — with a boolean, "still alive after one release"
    // and "alive because release is a no-op" would be indistinguishable.
    a?.release()
    expect(state.killed).toBe(0)
    b?.release()
    expect(state.killed).toBe(0)

    // A third turn after both releases: still one process, still no new boot.
    const third = await pool.acquire(CTX)
    expect(state.boots).toBe(1)
    expect(third?.server).toEqual(httpServer(9_001))
    third?.release()

    pool.releaseAll()
    expect(state.killed).toBe(1)
  })

  it('kills a dead sidecar on the health gate even while a run still holds it', async () => {
    const { pool, state } = trackedPool()

    const held = await pool.acquire(CTX)
    expect(state.boots).toBe(1)
    state.healthy = false

    // Never handed out, and killed NOW: the holder's claim is on a dead
    // process, so waiting for it to let go would leak nothing and delay the
    // only thing that matters — the next turn gets a fresh boot.
    const next = await pool.acquire(CTX)
    expect(state.boots).toBe(2)
    expect(state.killed).toBe(1)
    expect(next?.server).toEqual(httpServer(9_002))

    held?.release()
    next?.release()
    pool.releaseAll()
    expect(state.live).toBe(0)
  })

  it('retries a failed boot on the next acquire instead of caching the failure', async () => {
    let attempts = 0
    const pool = createSidecarPool({
      spawn: async () => {
        attempts++
        if (attempts === 1) throw new Error('no binary')
        return {
          server: httpServer(9_500),
          release: () => {},
          checkHealth: async () => true,
        } satisfies StartedLedgerMcpHttp
      },
    })

    // The booked honesty rule: a sidecar that fails to boot degrades the turn
    // to no-tools rather than failing it.
    expect(await pool.acquire(CTX)).toBeNull()
    // ...and the failure is not sticky: the next turn tries again.
    expect((await pool.acquire(CTX))?.server).toEqual(httpServer(9_500))
    pool.releaseAll()
  })
})
