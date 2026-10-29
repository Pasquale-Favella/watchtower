import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import * as ConfigProvider from 'effect/ConfigProvider'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FiberMap from 'effect/FiberMap'
import * as Layer from 'effect/Layer'
import * as Metric from 'effect/Metric'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HarnessInfo } from '../src/infrastructure/agent-harnesses/detect.js'
import { type ProbeChild, probeHarness } from '../src/infrastructure/agent-harnesses/probe.js'
import { HarnessSnapshot } from '../src/infrastructure/agent-harnesses/snapshot.js'
import { Env } from '../src/infrastructure/config/environment.js'
import { type MainRuntime, makeMainRuntime } from '../src/platform/electron/main/main-runtime.js'
import {
  closeOperationalLog,
  initOperationalLog,
  OPERATIONAL_LOG_FILE,
  PROBE_OUTCOME_COUNTER,
} from '../src/infrastructure/logging/operational-log.js'
import type { CoachHarnessRow } from '../src/shared/schemas/agents.js'

const info: HarnessInfo = {
  instanceId: 'codex',
  name: 'codex',
  kind: 'codex',
  displayName: 'Codex',
  bin: 'codex',
  scrubEnv: [],
}

const runtimes: MainRuntime[] = []

class RuntimeProbeChild extends EventEmitter implements ProbeChild {
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() })
  stdout = Readable.from([])
  stderr = Readable.from([])

  kill(): boolean {
    return true
  }
}

function makeRuntime(options: Parameters<typeof makeMainRuntime>[0], overrides: Parameters<typeof makeMainRuntime>[1]) {
  const runtime = makeMainRuntime(options, overrides)
  runtimes.push(runtime)
  return runtime
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => Effect.runPromise(runtime.disposeEffect)))
})

describe('main-owned harness snapshot', () => {
  it('reads current cached harness rows without detecting or probing, then publishes after startup', async () => {
    const published: CoachHarnessRow[][] = []
    const detect = vi.fn(async () => [info])
    const probe = vi.fn(() => Effect.succeed({ status: 'ready' as const, auth: { status: 'unknown' as const } }))
    const runtime = makeRuntime(
      { clientVersion: 'test', appPath: '/app', onHarnessChange: rows => published.push(rows) },
      { detect, probe },
    )

    const current = Effect.flatMap(HarnessSnapshot, snapshot => snapshot.current())
    expect(await runtime.runPromise(current)).toEqual([])
    expect(detect).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()

    await runtime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.start()))
    await vi.waitFor(() => expect(published.at(-1)?.[0]?.status).toBe('ready'))
    expect(detect).toHaveBeenCalledOnce()
    expect(await runtime.runPromise(current)).toMatchObject([{ instanceId: 'codex', status: 'ready' }])
  })

  it('provides the main operational tracer while acquiring an additional callback service', async () => {
    class Callback extends Context.Service<Callback, { run: () => void }>()('test/main/Callback') {}
    const callbacks = Layer.effect(
      Callback,
      Effect.gen(function* () {
        const fibers = yield* FiberMap.make<string>()
        const run = yield* FiberMap.runtime(fibers)<never>()
        return Callback.of({
          run: () => {
            run('callback', Effect.void.pipe(Effect.withSpan('shell.callback')))
          },
        })
      }),
    )
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-main-callback-'))
    await initOperationalLog({ logDir: directory, isPackaged: false })
    const runtime = makeMainRuntime(
      { clientVersion: 'test', appPath: '/app', onHarnessChange: () => {} },
      { detect: async () => [] },
      callbacks,
    )
    try {
      const callback = await runtime.runPromise(Callback)
      callback.run()
      closeOperationalLog()
      const lines = readFileSync(join(directory, OPERATIONAL_LOG_FILE), 'utf8')
      expect(lines).toContain('"op":"shell.callback"')
    } finally {
      closeOperationalLog()
      await runtime.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('uses one Config provider for Env and harness discovery', async () => {
    const detect = vi.fn(async () => [])
    const runtime = makeRuntime(
      { clientVersion: 'test', appPath: '/app', onHarnessChange: () => {} },
      {
        detect,
        configProvider: ConfigProvider.fromEnvRecord(
          { PATH: '', AI_GATEWAY_API_KEY: ' fixture-key ', WATCHTOWER_PRICING_TTL_HOURS: '2' },
          { preserveEmptyStrings: true },
        ),
      },
    )
    const env = await runtime.runPromise(
      Effect.gen(function* () {
        const values = yield* Env
        const snapshot = yield* HarnessSnapshot
        yield* snapshot.list()
        return values
      }),
    )
    expect(env).toEqual({ vercelGatewayApiKey: 'fixture-key', pricingCacheTtlMs: 2 * 60 * 60 * 1000 })
    expect(detect).toHaveBeenCalledWith('')
  })

  it('publishes the real probe’s bounded operational result while keeping the binary path in its row field', async () => {
    const published: CoachHarnessRow[][] = []
    const runtime = makeRuntime(
      {
        clientVersion: '4.2.1',
        appPath: '/app',
        onHarnessChange: rows => published.push(rows),
      },
      {
        detect: async () => [info],
        probe: harness =>
          probeHarness(harness, {
            spawn: () => new RuntimeProbeChild(),
            connectionFactory: () => ({
              initialize: async () => {
                throw new Error(`SDK details from ${info.bin}: token=secret`)
              },
            }),
          }),
      },
    )

    await runtime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list()))
    await vi.waitFor(() => expect(published.at(-1)?.[0]?.status).toBe('error'))

    expect(published.at(-1)?.[0]).toMatchObject({
      status: 'error',
      binaryPath: info.bin,
      message: 'Codex did not complete the ACP handshake. Check the installation and try again.',
      auth: { status: 'unknown', loginCommand: 'codex login' },
    })
    expect(published.at(-1)?.[0]?.message).not.toContain(info.bin)
    expect(published.at(-1)?.[0]?.message).not.toContain('token=secret')
  })

  it('uses the root version and the same probe capability for the live snapshot route', async () => {
    const versions: string[] = []
    const published: CoachHarnessRow[][] = []
    const runtime = makeRuntime(
      {
        clientVersion: '4.2.1',
        appPath: '/app',
        onHarnessChange: rows => published.push(rows),
      },
      {
        detect: async () => [info],
        probe: (_info, clientVersion) => {
          versions.push(clientVersion)
          return Effect.succeed({ status: 'ready', auth: { status: 'unknown' }, version: '1.0.0' })
        },
      },
    )

    const rows = await runtime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list()))
    await vi.waitFor(() => expect(versions).toEqual(['4.2.1']))
    await vi.waitFor(() => expect(published.at(-1)?.[0]?.status).toBe('ready'))

    expect(rows).toEqual([
      {
        instanceId: 'codex',
        kind: 'codex',
        displayName: 'Codex',
        status: 'ready',
        auth: { status: 'unknown', loginCommand: 'codex login' },
        binaryPath: 'codex',
        version: '1.0.0',
      },
    ])
    expect(published.map(batch => batch[0]?.status)).toEqual(['pending', 'ready'])
  })

  it('interrupts a pending probe once on root disposal and ignores its late completion', async () => {
    let started = false
    let finalized = 0
    const published: CoachHarnessRow[][] = []
    const runtime = makeRuntime(
      {
        clientVersion: 'test',
        appPath: '/app',
        onHarnessChange: rows => published.push(rows),
      },
      {
        detect: async () => [info],
        probe: () =>
          Effect.scoped(
            Effect.sync(() => {
              started = true
            }).pipe(
              Effect.andThen(Effect.acquireRelease(Effect.void, () => Effect.sync(() => finalized++))),
              Effect.andThen(Effect.never),
            ),
          ),
      },
    )

    await runtime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list()))
    await vi.waitFor(() => expect(started).toBe(true))
    await Effect.runPromise(runtime.disposeEffect)

    expect(finalized).toBe(1)
    expect(published.map(batch => batch[0]?.status)).toEqual(['pending'])
  })

  it('coalesces refresh requests and checks PATH freshness at each list call', async () => {
    let release: ((value: HarnessInfo[]) => void) | undefined
    let path = 'first'
    let round = 0
    const detectedPaths: Array<string | undefined> = []
    const detect = vi.fn((pathEnv: string | undefined) => {
      detectedPaths.push(pathEnv)
      round++
      if (round > 1) return Promise.resolve([info])
      return new Promise<HarnessInfo[]>(resolve => {
        release = resolve
      })
    })
    const runtime = makeRuntime(
      { clientVersion: 'test', appPath: '/app', onHarnessChange: () => {} },
      { detect, probe: () => Effect.never, readPath: () => path },
    )
    const snapshot = Effect.flatMap(HarnessSnapshot, service => service.refresh())
    const first = runtime.runPromise(snapshot)
    const second = runtime.runPromise(snapshot)
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1))
    release?.([info])
    await Promise.all([first, second])

    const service = Effect.flatMap(HarnessSnapshot, value => value.list())
    await runtime.runPromise(service)
    path = 'second'
    await runtime.runPromise(service)
    expect(detect).toHaveBeenCalledTimes(2)
    expect(detectedPaths).toEqual(['first', 'second'])
  })

  it('distinguishes missing and blank PATH values from the live ConfigProvider', async () => {
    const environment: Record<string, string | undefined> = {}
    const detectedPaths: Array<string | undefined> = []
    const detect = vi.fn((pathEnv: string | undefined) => {
      detectedPaths.push(pathEnv)
      return Promise.resolve([])
    })
    const runtime = makeRuntime(
      { clientVersion: 'test', appPath: '/app', onHarnessChange: () => {} },
      {
        detect,
        probe: () => Effect.never,
        configProvider: ConfigProvider.fromEnvRecord(environment, { preserveEmptyStrings: true }),
      },
    )
    const list = Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list())

    await runtime.runPromise(list)
    environment['PATH'] = ''
    await runtime.runPromise(list)

    expect(detectedPaths).toEqual([undefined, ''])
  })

  it('uses the same live PATH for executable detection and freshness, and records one native metric delta', async () => {
    const root = mkdtempSync(join(tmpdir(), 'watchtower-main-path-'))
    const firstPath = join(root, 'first')
    const secondPath = join(root, 'second')
    const logDir = join(root, 'logs')
    mkdirSync(firstPath)
    mkdirSync(secondPath)
    const executable = process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp'
    const firstBinary = join(firstPath, executable)
    const secondBinary = join(secondPath, executable)
    writeFileSync(firstBinary, '')
    writeFileSync(secondBinary, '')
    const environment: Record<string, string | undefined> = { PATH: firstPath }
    await initOperationalLog({ logDir, isPackaged: true })
    const runtime = makeRuntime(
      { clientVersion: 'test', appPath: '/app', onHarnessChange: () => {} },
      {
        configProvider: ConfigProvider.fromEnvRecord(environment, { preserveEmptyStrings: true }),
        probe: () => Effect.succeed({ status: 'ready', auth: { status: 'unknown' } }),
      },
    )

    try {
      const list = Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list())
      const firstRows = await runtime.runPromise(list)
      expect(firstRows.find(row => row.kind === 'codex')?.binaryPath).toBe(firstBinary)
      expect((await runtime.runPromise(Metric.value(Metric.counter(PROBE_OUTCOME_COUNTER)))).count).toBe(1)

      environment['PATH'] = secondPath
      const secondRows = await runtime.runPromise(list)
      expect(secondRows.find(row => row.kind === 'codex')?.binaryPath).toBe(secondBinary)
      expect((await runtime.runPromise(Metric.value(Metric.counter(PROBE_OUTCOME_COUNTER)))).count).toBe(2)
      closeOperationalLog()
      const records = readFileSync(join(logDir, OPERATIONAL_LOG_FILE), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map(line => JSON.parse(line) as { event?: string; count?: number })
      expect(records.filter(record => record.event === PROBE_OUTCOME_COUNTER)).toHaveLength(2)
      expect(records.filter(record => record.event === PROBE_OUTCOME_COUNTER).map(record => record.count)).toEqual([
        1, 1,
      ])
    } finally {
      closeOperationalLog()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('settles a pending detection caller on disposal and never publishes late results', async () => {
    const completions: Array<(value: HarnessInfo[]) => void> = []
    const published: CoachHarnessRow[][] = []
    const probe = vi.fn(() => Effect.never)
    const runtime = makeRuntime(
      { clientVersion: 'test', appPath: '/app', onHarnessChange: rows => published.push(rows) },
      {
        detect: () => new Promise<HarnessInfo[]>(resolve => completions.push(resolve)),
        probe,
      },
    )
    // Attach rejection handling before disposal so the expected interrupted
    // caller cannot become an unhandled rejection in the test runner.
    const pending = runtime.runPromise(Effect.flatMap(HarnessSnapshot, snapshot => snapshot.list())).then(
      () => 'completed',
      () => 'interrupted',
    )
    await vi.waitFor(() => expect(completions).toHaveLength(1))

    await Effect.runPromise(runtime.disposeEffect)
    await expect(pending).resolves.toBe('interrupted')
    completions[0]?.([info])
    await Promise.resolve()
    await Promise.resolve()

    expect(published).toEqual([])
    expect(probe).not.toHaveBeenCalled()
  })
})
