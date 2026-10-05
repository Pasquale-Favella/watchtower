import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  parse: vi.fn(),
  repoUrl: vi.fn(),
}))

vi.mock('../src/main/pipeline/parser.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/main/pipeline/parser.js')>()),
  parseAllSessions: (...args: unknown[]) => hooks.parse(...args),
}))

vi.mock('../src/main/pipeline/git-remote.js', () => ({
  getRepoUrl: (...args: unknown[]) => hooks.repoUrl(...args),
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
import { LedgerStore } from '../src/main/store/ledger.js'
import { openWorkerOwner } from '../src/main/worker-runtime.js'
import type { ScanDelta } from '../src/shared/schemas/scan.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

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

describe('scan lifetime ownership', () => {
  let dir = ''
  let context: DbWorkerContext | null = null
  const events: DbWorkerEvent[] = []

  function open(): DbWorkerContext {
    dir = mkdtempSync(join(tmpdir(), 'watchtower-scan-lifetime-'))
    const dbPath = join(dir, 'ledger.db')
    const owner = openWorkerOwner(dbPath)
    context = new DbWorkerContext(
      { dbPath, dataDir: dir, cacheDir: join(dir, 'cache') },
      event => events.push(event),
      owner,
    )
    return context
  }

  afterEach(async () => {
    hooks.parse.mockReset()
    hooks.repoUrl.mockReset()
    setPriceOverrides({})
    setModelAliases({})
    setLocalModelSavings({})
    await context?.close()
    context = null
    events.length = 0
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('persists scan-owned costs and savings after pricing changes during repository lookup', async () => {
    const c = open()
    const ledger = (c as unknown as { ledger: LedgerStore }).ledger
    const portIn = vi.spyOn(ledger, 'portIn')
    const repoEntered = deferred<undefined>()
    const releaseRepo = deferred<string | undefined>()
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
    hooks.repoUrl
      .mockImplementationOnce(() => {
        repoEntered.resolve(undefined)
        return releaseRepo.promise
      })
      .mockResolvedValue('https://example.test/project')
    hooks.parse.mockImplementation(
      async (
        _range: unknown,
        _provider: unknown,
        onDelta: DeltaHandler,
        _onUnparsed: unknown,
        _signal: unknown,
        services: ProviderScanServices,
      ) => {
        expect(services.pricing).toBeDefined()
        await onDelta(firstDelta)
      },
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
    const firstPricing = hooks.parse.mock.calls[0][5].pricing
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
    hooks.parse.mockImplementation(async (_range: unknown, _provider: unknown, onDelta: DeltaHandler) => {
      await onDelta({ ...firstDelta, filePath: 'next-session.jsonl' })
    })
    await expect(c.dispatch('scan:start', [])).resolves.toEqual({ ok: true })
    const nextPricing = hooks.parse.mock.calls[1][5].pricing
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

  it('does not complete interruption until the real parser Promise and callback drain', async () => {
    const c = open()
    const parserEntered = deferred<undefined>()
    const releaseRepoLookup = deferred<string | undefined>()
    const ledger = (c as unknown as { ledger: LedgerStore }).ledger
    const portIn = vi.spyOn(ledger, 'portIn')
    hooks.repoUrl.mockReturnValue(releaseRepoLookup.promise)
    hooks.parse.mockResolvedValue(undefined)
    hooks.parse.mockImplementationOnce(
      async (_range: unknown, _provider: unknown, onDelta: (value: ScanDelta) => Promise<void>) => {
        parserEntered.resolve(undefined)
        await onDelta(delta())
      },
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

    await expect(c.dispatch('scan:start', [])).resolves.toEqual({ ok: true })
    expect(hooks.parse).toHaveBeenCalledTimes(2)
    expect(events.filter(event => event.event === 'store:changed')).toHaveLength(1)
  })

  it('holds ledger close until an interrupted parser callback drains', async () => {
    const c = open()
    const parserEntered = deferred<undefined>()
    const releaseRepoLookup = deferred<string | undefined>()
    const ledger = (c as unknown as { ledger: LedgerStore }).ledger
    const portIn = vi.spyOn(ledger, 'portIn')
    const closeLedger = vi.spyOn(ledger, 'close')
    hooks.repoUrl.mockReturnValue(releaseRepoLookup.promise)
    hooks.parse.mockImplementation(
      async (_range: unknown, _provider: unknown, onDelta: (value: ScanDelta) => Promise<void>) => {
        parserEntered.resolve(undefined)
        await onDelta(delta())
      },
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
