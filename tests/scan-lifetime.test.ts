import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CommandRunner, makeRecordingCommandRunner } from '../src/main/agents/command-runner.js'

const hooks = vi.hoisted(() => ({
  parseEffect: vi.fn(),
}))

vi.mock('../src/main/pipeline/parser.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/main/pipeline/parser.js')>()),
  parseAllSessionsEffect: (...args: unknown[]) => hooks.parseEffect(...args),
}))

import { DbWorkerContext } from '../src/main/db-worker/context.js'
import type { DbWorkerEvent } from '../src/main/db-worker/protocol.js'
import {
  captureScanPricing,
  setLocalModelSavings,
  setModelAliases,
  setPriceOverrides,
} from '../src/main/pipeline/models.js'
import type { DeltaHandler } from '../src/main/pipeline/parser.js'
import type { ProviderScanServices } from '../src/main/pipeline/providers/types.js'
import { runOwnedScanPromise } from '../src/main/pipeline/scan.js'
import { LedgerIngest } from '../src/main/store/ledger-ports.js'
import type { ScanDelta } from '../src/shared/schemas/scan.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { openWorkerOwner } from './fixtures/worker-owner.js'

function deferred<A>(): { promise: Promise<A>; resolve(value: A): void } {
  let resolve!: (value: A) => void
  const promise = new Promise<A>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function delta(): ScanDelta {
  return {
    provider: 'claude',
    envFingerprint: 'fixture-env',
    filePath: 'session.jsonl',
    verdict: 'new',
    cachedFile: buildFixtureCachedFile({ failed: false }),
    workingDirectory: '/workspace/demo-project',
  }
}

function defaultCommandLayer(): Layer.Layer<CommandRunner> {
  return makeRecordingCommandRunner(() => Effect.succeed({ stdout: 'https://example.test/project', exitCode: 0 })).layer
}

describe('scan lifetime ownership', () => {
  let dir = ''
  let context: DbWorkerContext | null = null
  const events: DbWorkerEvent[] = []

  function open(commandLayer: Layer.Layer<CommandRunner> = defaultCommandLayer()) {
    dir = mkdtempSync(join(tmpdir(), 'watchtower-scan-lifetime-'))
    const dbPath = join(dir, 'ledger.db')
    const owner = openWorkerOwner(dbPath, undefined, commandLayer)
    context = new DbWorkerContext(
      { dbPath, dataDir: dir, cacheDir: join(dir, 'cache') },
      event => events.push(event),
      owner,
    )
    return { context, ...owner }
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    hooks.parseEffect.mockReset()
    setPriceOverrides({})
    setModelAliases({})
    setLocalModelSavings({})
    await context?.close()
    context = null
    events.length = 0
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it.each(['https://example.test/project', ''])('memoizes repository answers per scan, including %j', async url => {
    const { layer, calls } = makeRecordingCommandRunner(() => Effect.succeed({ stdout: url, exitCode: url ? 0 : 1 }))
    const { context: c, runtime } = open(layer)
    const portIn = vi.spyOn(runtime.runSync(LedgerIngest), 'portIn')
    hooks.parseEffect.mockImplementation((...args: unknown[]) =>
      Effect.gen(function* () {
        const onDelta = args[2] as DeltaHandler
        for (const filePath of ['one.jsonl', 'two.jsonl']) yield* onDelta({ ...delta(), filePath })
      }),
    )

    await expect(c.dispatch('scan:start', [])).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(portIn.mock.calls.map(([delta]) => delta.repoUrl)).toEqual([url || undefined, url || undefined])
    await expect(c.dispatch('scan:start', [])).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })

  it('persists scan-owned costs and savings after pricing changes during repository lookup', async () => {
    const repoEntered = deferred<undefined>()
    const releaseRepo = deferred<string | undefined>()
    const { layer: commandLayer } = makeRecordingCommandRunner(() =>
      Effect.andThen(
        Effect.sync(() => repoEntered.resolve(undefined)),
        Effect.uninterruptible(
          Effect.promise(() => releaseRepo.promise.then(url => ({ stdout: url ?? '', exitCode: url ? 0 : 1 }))),
        ),
      ),
    )
    const { context: c, ledger, runtime } = open(commandLayer)
    const portIn = vi.spyOn(runtime.runSync(LedgerIngest), 'portIn')
    const model = 'scan-owned-model'
    const baseline = 'scan-owned-baseline'
    setPriceOverrides({ [baseline]: { input: 1, output: 2, cacheRead: 3 } })
    setModelAliases({ [model]: baseline })
    setLocalModelSavings({ 'local-scan-model': baseline })
    const original = captureScanPricing()
    const firstExpected = original.calculateCost(model, 100, 50, 0, 20, 0)
    const cachedCall = { ...buildFixtureCachedCall(0), provider: 'claude', model, costUSD: undefined }
    const firstDelta: ScanDelta = {
      ...delta(),
      cachedFile: buildFixtureCachedFile({
        turns: [
          buildFixtureCachedTurn(0, 'Captured prices', {
            calls: [cachedCall, { ...cachedCall, model: 'local-scan-model', deduplicationKey: 'local-scan-call' }],
          }),
        ],
      }),
    }
    hooks.parseEffect.mockImplementation((...args: unknown[]) =>
      Effect.gen(function* () {
        const onDelta = args[2] as DeltaHandler
        const services = args[5] as ProviderScanServices
        expect(services.pricing).toBeDefined()
        yield* onDelta(firstDelta)
      }),
    )

    const firstScan = c.dispatch('scan:start', [])
    try {
      await repoEntered.promise
      setPriceOverrides({ [baseline]: { input: 100, output: 200, cacheRead: 300 } })
      setModelAliases({ [model]: 'unpriced-after-scan-start' })
      setLocalModelSavings({})
    } finally {
      releaseRepo.resolve('https://example.test/project')
    }
    await expect(firstScan).resolves.toEqual({ ok: true })
    const firstPricing = hooks.parseEffect.mock.calls[0][5].pricing
    expect(portIn.mock.calls[0][1]).toBe(firstPricing)
    expect(ledger.getCalls()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model, baseCostUSD: firstExpected, savingsUSD: 0 }),
        expect.objectContaining({
          model: 'local-scan-model',
          baseCostUSD: 0,
          savingsUSD: firstExpected,
          savingsBaselineModel: baseline,
        }),
      ]),
    )

    setModelAliases({ [model]: baseline })
    hooks.parseEffect.mockImplementation((...args: unknown[]) =>
      Effect.gen(function* () {
        const onDelta = args[2] as DeltaHandler
        yield* onDelta({ ...firstDelta, filePath: 'next-session.jsonl' })
      }),
    )
    await expect(c.dispatch('scan:start', [])).resolves.toEqual({ ok: true })
    const nextPricing = hooks.parseEffect.mock.calls[1][5].pricing
    expect(nextPricing).not.toBe(firstPricing)
    expect(portIn.mock.calls[1][1]).toBe(nextPricing)
    expect(
      ledger
        .getCalls()
        .filter(call => call.model === model)
        .map(call => call.baseCostUSD)
        .sort((a, b) => a - b),
    ).toEqual([firstExpected, firstExpected * 100])
    expect(
      ledger
        .getCalls()
        .filter(call => call.model === 'local-scan-model')
        .map(call => call.savingsUSD)
        .sort((a, b) => a - b),
    ).toEqual([0, firstExpected])
  })

  it('does not complete interruption until the parser callback Effect drains', async () => {
    const releaseRepoLookup = deferred<string | undefined>()
    const { layer: commandLayer } = makeRecordingCommandRunner(() =>
      Effect.uninterruptible(
        Effect.promise(() => releaseRepoLookup.promise.then(url => ({ stdout: url ?? '', exitCode: url ? 0 : 1 }))),
      ),
    )
    const { context: c, runtime } = open(commandLayer)
    const parserEntered = deferred<undefined>()
    const portIn = vi.spyOn(runtime.runSync(LedgerIngest), 'portIn')
    hooks.parseEffect.mockImplementationOnce((...args: unknown[]) =>
      Effect.gen(function* () {
        parserEntered.resolve(undefined)
        yield* (args[2] as DeltaHandler)(delta())
      }),
    )

    const request = c.dispatch('scan:start', [])
    await parserEntered.promise
    const aborting = c.dispatch('scan:abort', [])
    let abortFinished = false
    void aborting.then(() => {
      abortFinished = true
    })

    await expect(c.dispatch('scan:start', [])).resolves.toEqual({ ok: false, alreadyRunning: true })
    await Promise.resolve()
    expect(abortFinished).toBe(false)
    expect(portIn).not.toHaveBeenCalled()

    releaseRepoLookup.resolve('https://example.test/project')
    await aborting
    await expect(request).resolves.toMatchObject({ ok: false, aborted: true })
    expect(portIn).not.toHaveBeenCalled()
    expect(events.filter(event => event.event === 'store:changed')).toHaveLength(0)
    expect(events.filter(event => event.event === 'scan:progress')).toHaveLength(3)

    hooks.parseEffect.mockImplementation(() => Effect.void)
    await expect(c.dispatch('scan:start', [])).resolves.toEqual({ ok: true })
    expect(hooks.parseEffect).toHaveBeenCalledTimes(2)
    expect(events.filter(event => event.event === 'store:changed')).toHaveLength(1)
  })

  it('holds ledger close until an interrupted parser callback Effect drains', async () => {
    const releaseRepoLookup = deferred<string | undefined>()
    const { layer: commandLayer } = makeRecordingCommandRunner(() =>
      Effect.uninterruptible(
        Effect.promise(() => releaseRepoLookup.promise.then(url => ({ stdout: url ?? '', exitCode: url ? 0 : 1 }))),
      ),
    )
    const { context: c, runtime } = open(commandLayer)
    const parserEntered = deferred<undefined>()
    const portIn = vi.spyOn(runtime.runSync(LedgerIngest), 'portIn')
    const closeLedger = vi.spyOn(DatabaseSync.prototype, 'close')
    hooks.parseEffect.mockImplementation((...args: unknown[]) =>
      Effect.gen(function* () {
        parserEntered.resolve(undefined)
        yield* (args[2] as DeltaHandler)(delta())
      }),
    )

    const request = c.dispatch('scan:start', [])
    await parserEntered.promise
    const closing = c.close()
    let closeFinished = false
    void closing.then(() => {
      closeFinished = true
    })
    await Promise.resolve()
    expect(closeFinished).toBe(false)
    expect(portIn).not.toHaveBeenCalled()
    expect(closeLedger).not.toHaveBeenCalled()

    releaseRepoLookup.resolve('https://example.test/project')
    await closing
    await expect(request).resolves.toMatchObject({ ok: false, aborted: true })
    expect(portIn).not.toHaveBeenCalled()
    expect(closeLedger).toHaveBeenCalledOnce()
    expect(events.filter(event => event.event === 'store:changed')).toHaveLength(0)
  })

  it('drains the owned Promise after interruption before releasing its scope', async () => {
    const release = deferred<undefined>()
    const parserEntered = deferred<undefined>()
    const holdParent = deferred<undefined>()
    const promise = release.promise
    const parent = Effect.runFork(
      Effect.gen(function* () {
        yield* Effect.forkChild(
          runOwnedScanPromise(() => {
            parserEntered.resolve(undefined)
            return promise
          }),
        )
        yield* Effect.promise(() => holdParent.promise)
      }),
    )
    await parserEntered.promise
    const interruption = Effect.runPromise(Fiber.interrupt(parent))
    let interrupted = false
    void interruption.then(() => {
      interrupted = true
    })

    expect(interrupted).toBe(false)
    release.resolve(undefined)
    await interruption
    expect(interrupted).toBe(true)
  })

  it('requests parser stop independently, then drains its callback before releasing scope', async () => {
    const release = deferred<undefined>()
    const parserEntered = deferred<AbortSignal>()
    const parent = Effect.runFork(
      Effect.gen(function* () {
        yield* Effect.forkChild(
          runOwnedScanPromise(signal => {
            parserEntered.resolve(signal)
            return release.promise
          }),
        )
        yield* Effect.promise(() => new Promise<never>(() => undefined))
      }),
    )
    const signal = await parserEntered.promise
    const interruption = Effect.runPromise(Fiber.interrupt(parent))
    await Promise.resolve()

    expect(signal.aborted).toBe(true)
    let interrupted = false
    void interruption.then(() => {
      interrupted = true
    })
    expect(interrupted).toBe(false)

    release.resolve(undefined)
    await interruption
    expect(interrupted).toBe(true)
  })
})
