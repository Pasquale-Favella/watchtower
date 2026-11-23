import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/infrastructure/agent-harnesses/detect.js'
import type {
  ControlledHarnessInspection,
  HarnessProviderInput,
  HarnessRunInput,
  HarnessRuntime,
  NativeHarnessRun,
} from '../src/infrastructure/agent-harnesses/runtime.js'
import {
  type CoachRunner,
  createCoachRunner,
  type HarnessSource,
  type LedgerMcpAttachment,
  type NativeHarnessSource,
} from '../src/platform/electron/main/coach/ipc.js'
import type { MainRuntime } from '../src/platform/electron/main/main-runtime.js'
import { ledgerHttp } from '../src/platform/mcp/ledger-endpoint.js'
import { LocalLedgerMcp, localLedgerMcpLayer } from '../src/platform/mcp/local-ledger-mcp.js'
import { createLedgerMcpQueries } from '../src/platform/mcp/query-api.js'
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

/** The runner's `ledgerMcpServer` dep, wrapped so the test can count the
 *  runner's releases without reaching into the pool's own (no-op) one. */
function countingAttachmentSource(counter: { released: number }): {
  ledgerMcpServer: (harnessKind: string) => Promise<LedgerMcpAttachment | null>
} {
  return {
    ledgerMcpServer: async () => ({
      server: { name: 'watchtower-ledger', command: 'node', args: ['ledger-mcp-proxy.js'], env: [] },
      release: () => {
        counter.released++
      },
    }),
  }
}

const ownedRunners = new Set<CoachRunner>()
const ownedEffectHosts = new Set<ManagedRuntime.ManagedRuntime<never, never>>()
type TestRunnerOptions = {
  harnesses: HarnessSource
  ledgerMcpServer: (harnessKind: string) => Promise<LedgerMcpAttachment | null>
  getRuntime: () => Promise<HarnessRuntime>
}

function nativeHarnesses(source: HarnessSource): NativeHarnessSource {
  return {
    list: () => Effect.tryPromise({ try: () => source.list(), catch: error => error }),
    refresh: () => Effect.tryPromise({ try: () => source.refresh(), catch: error => error }),
    get: instanceId => Effect.tryPromise({ try: () => source.get(instanceId), catch: error => error }),
    reportAuth: (instanceId, status) => Effect.sync(() => source.reportAuth?.(instanceId, status)),
  }
}

function bounded<T>(promise: Promise<T>): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), 3_000)
    void promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

function ownRunner(options: TestRunnerOptions): CoachRunner {
  const host = ManagedRuntime.make(Layer.empty)
  ownedEffectHosts.add(host)
  const nativeDeps = {
    harnesses: nativeHarnesses(options.harnesses),
    ledgerMcpServer: (kind: string) =>
      Effect.tryPromise({ try: () => options.ledgerMcpServer(kind), catch: error => error }),
    effectHost: host as unknown as MainRuntime,
    startRun: (input: HarnessRunInput) =>
      Effect.tryPromise({
        try: async (): Promise<NativeHarnessRun> => {
          const runtime = await options.getRuntime!()
          const controlled = runtime.runControlled?.(input)
          const source = controlled?.events ?? runtime.run(input)
          const iterator = source[Symbol.asyncIterator]()
          let stopping: Promise<void> | undefined
          return {
            events: {
              [Symbol.asyncIterator]: () => ({
                next: () => iterator.next(),
                return: async () => ({ done: true, value: undefined }),
              }),
            },
            stop: Effect.tryPromise({
              try: () =>
                (stopping ??= bounded(
                  controlled ? controlled.stop() : Promise.resolve(iterator.return?.(undefined)).then(() => undefined),
                )),
              catch: error => error as Error,
            }).pipe(
              Effect.asVoid,
              Effect.catchCause(() => Effect.void),
            ),
          }
        },
        catch: error => error as Error,
      }),
    startInspection: (input: HarnessProviderInput) =>
      Effect.sync(() => {
        let cancelled = false
        let controlled: ControlledHarnessInspection | undefined
        return {
          result: Effect.tryPromise({
            try: async () => {
              const runtime = await options.getRuntime!()
              if (cancelled) return {}
              controlled = runtime.inspectControlled?.(input)
              return controlled ? controlled.result : runtime.inspect(input)
            },
            catch: error => error as Error,
          }),
          stop: Effect.sync(() => {
            cancelled = true
          }).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: () => (controlled ? bounded(controlled.stop()) : Promise.resolve(undefined)),
                catch: error => error as Error,
              }).pipe(
                Effect.asVoid,
                Effect.catchCause(() => Effect.void),
              ),
            ),
          ),
        }
      }),
  }
  const runner = createCoachRunner(nativeDeps)
  ownedRunners.add(runner)
  return runner
}

afterEach(async () => {
  const runners = [...ownedRunners]
  ownedRunners.clear()
  await Promise.all(runners.map(runner => runner.reset()))
  const hosts = [...ownedEffectHosts]
  ownedEffectHosts.clear()
  await Promise.all(hosts.map(host => host.dispose()))
})

describe('ledger MCP attachment lifetime — a run the app stopped waiting for cannot keep its claim', () => {
  it('releases the attachment of an ABANDONED run when the conversation is torn down', async () => {
    const counter = { released: 0 }
    const runner = ownRunner({
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
    const runner = ownRunner({
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
    const runner = ownRunner({
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

  it('keeps the app-scoped HTTP endpoint available after a Coach reset', async () => {
    const localRuntime = ManagedRuntime.make(localLedgerMcpLayer(Effect.runPromise))
    const queries = createLedgerMcpQueries({ request: async () => undefined })
    const connection = Effect.flatMap(LocalLedgerMcp, local => local.connection(queries))
    try {
      const runner = ownRunner({
        getRuntime: async () => streamingRuntime(),
        harnesses: harnessSource,
        ledgerMcpServer: async () => {
          const endpoint = await localRuntime.runPromise(connection)
          return endpoint ? { server: ledgerHttp(endpoint), release: () => {} } : null
        },
      })

      expect((await runner.start(request, () => {})).ok).toBe(true)
      const endpoint = await localRuntime.runPromise(connection)
      if (!endpoint) throw new Error('Expected the local ledger endpoint')
      await runner.reset()
      expect(await localRuntime.runPromise(connection)).toEqual(endpoint)
      const status = await fetch(endpoint.url.replace(/\/mcp$/, '/health'), {
        headers: { Authorization: `Bearer ${endpoint.token}` },
      })
      expect(status.status).toBe(200)
    } finally {
      await localRuntime.dispose()
    }
  })
})
