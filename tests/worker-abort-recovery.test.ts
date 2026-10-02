import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DbWorkerClient, type DbWorkerPort, SCAN_ABORT_DRAIN_TIMEOUT_MS } from '../src/main/db-worker/client.js'
import type { DbWorkerData, DbWorkerEvent } from '../src/main/db-worker/protocol.js'

class ControlledWorker implements DbWorkerPort {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  readonly posted: Array<{ id: number; op: string; args: unknown[] }> = []
  terminationCalls = 0
  terminateImpl: () => Promise<unknown> = async () => 0

  postMessage(raw: unknown): void {
    this.posted.push(raw as { id: number; op: string; args: unknown[] })
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  async terminate(): Promise<unknown> {
    this.terminationCalls++
    return this.terminateImpl()
  }
}

function ready(worker: ControlledWorker): void {
  worker.emit('message', { event: 'ready' })
}

function deferred<A>(): { promise: Promise<A>; resolve(value: A): void } {
  let resolve!: (value: A) => void
  const promise = new Promise<A>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function responding(worker: ControlledWorker): void {
  worker.posted.forEach(request => {
    worker.emit('message', { id: request.id, ok: true, data: null })
  })
}

function controlledClient(): { client: DbWorkerClient; workers: ControlledWorker[] } {
  const workers: ControlledWorker[] = []
  const init: DbWorkerData = { dbPath: ':memory:', dataDir: ':memory:', cacheDir: ':memory:' }
  const client = new DbWorkerClient(init, 'controlled-worker.js', () => {
    const worker = new ControlledWorker()
    workers.push(worker)
    return worker
  })
  return { client, workers }
}

describe('DbWorkerClient bounded scan-abort recovery', () => {
  it('waits for real termination, gates replacement requests until ready, and ignores the old incarnation', async () => {
    const { client, workers } = controlledClient()
    const oldWorker = workers[0]!
    ready(oldWorker)
    await client.ready
    const releaseTermination = deferred<number>()
    const terminationStarted = deferred<undefined>()
    oldWorker.terminateImpl = () => {
      terminationStarted.resolve(undefined)
      return releaseTermination.promise
    }

    const scan = client.request('scan:start')
    const scanRejected = expect(scan).rejects.toThrow('data worker terminated after scan abort timed out')
    const timeout = 25
    const abortFiberPromise = Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.scanAbortEffect([], timeout, 2_000))
        yield* Effect.yieldNow
        yield* TestClock.adjust(timeout)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    const abortFailure = expect(abortFiberPromise).rejects.toThrow('scan abort drain timed out')

    await vi.waitFor(() => expect(oldWorker.posted.map(request => request.op)).toContain('scan:abort'))
    await terminationStarted.promise
    expect(workers).toHaveLength(1)

    const replacementRead = client.request('currency:get')
    await Promise.resolve()
    expect(oldWorker.posted.map(request => request.op)).not.toContain('currency:get')
    const events: DbWorkerEvent[] = []
    client.onEvent(event => events.push(event))
    releaseTermination.resolve(0)
    await vi.waitFor(() => expect(workers).toHaveLength(2))
    const replacement = workers[1]!
    expect(replacement.posted).toHaveLength(0)

    // Events arriving after termination are ignored by worker identity.
    oldWorker.emit('message', { event: 'store:changed', metadata: { stale: true } })
    ready(replacement)
    await vi.waitFor(() => expect(replacement.posted.map(request => request.op)).toContain('currency:get'))
    responding(replacement)
    await replacementRead
    await abortFailure
    await scanRejected
    expect(replacement.posted.map(request => request.op)).toEqual(['currency:get'])
    expect(events).toContainEqual({
      event: 'scan:error',
      manual: true,
      message: 'scan abort timed out; worker restarted',
    })
    expect(events).toContainEqual({ event: 'scan:idle' })
    expect(events).not.toContainEqual({ event: 'store:changed', metadata: { stale: true } })

    await client.terminate()
  })

  it('leaves the owning worker installed and admits no replacement when termination fails', async () => {
    const { client, workers } = controlledClient()
    const worker = workers[0]!
    ready(worker)
    await client.ready
    worker.terminateImpl = async () => {
      throw new Error('termination failed')
    }

    const result = Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.scanAbortEffect([], 10, 10))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    const failure = expect(result).rejects.toThrow('termination failed')
    await failure
    expect(workers).toHaveLength(1)
    await expect(client.request('currency:get')).rejects.toThrow('termination failed')
  })

  it('keeps recovery non-interruptible until actual termination settles', async () => {
    const { client, workers } = controlledClient()
    const oldWorker = workers[0]!
    ready(oldWorker)
    await client.ready
    const releaseTermination = deferred<number>()
    const terminationStarted = deferred<undefined>()
    const interruptionSent = deferred<undefined>()
    oldWorker.terminateImpl = () => {
      terminationStarted.resolve(undefined)
      return releaseTermination.promise
    }

    const recovery = Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.scanAbortEffect([], 10))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        yield* Effect.promise(() => terminationStarted.promise)
        yield* Effect.forkChild(Fiber.interrupt(fiber))
        interruptionSent.resolve(undefined)
        yield* Effect.promise(() => releaseTermination.promise)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    await interruptionSent.promise
    const queued = client.request('currency:get')
    const queuedFailure = expect(queued).rejects.toThrow(/unavailable/)
    const shutdown = client.shutdown()
    await Promise.resolve()
    expect(workers).toHaveLength(1)

    releaseTermination.resolve(0)
    await recovery
    await shutdown
    await queuedFailure
    expect(workers).toHaveLength(1)
    expect(oldWorker.terminationCalls).toBe(1)
  })

  it('joins repeated abort recovery and does not respawn after shutdown wins the race', async () => {
    const { client, workers } = controlledClient()
    const oldWorker = workers[0]!
    ready(oldWorker)
    await client.ready
    const releaseTermination = deferred<number>()
    const terminationStarted = deferred<undefined>()
    oldWorker.terminateImpl = () => {
      terminationStarted.resolve(undefined)
      return releaseTermination.promise
    }

    const abort = Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.scanAbortEffect([], 10))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    const abortFailure = expect(abort).rejects.toThrow('scan abort drain timed out')
    await vi.waitFor(() => expect(oldWorker.posted.map(request => request.op)).toContain('scan:abort'))
    await terminationStarted.promise
    const repeatedAbort = client.request('scan:abort')
    const shutdown = client.shutdown()
    releaseTermination.resolve(0)
    await abortFailure
    await repeatedAbort
    await shutdown
    expect(workers).toHaveLength(1)
    expect(oldWorker.terminationCalls).toBe(1)
  })

  it('does not use an unbounded or repeated replacement after the replacement boot handshake fails', async () => {
    const { client, workers } = controlledClient()
    const oldWorker = workers[0]!
    ready(oldWorker)
    await client.ready
    oldWorker.terminateImpl = async () => 0

    const abort = Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.scanAbortEffect([], 10))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    const bootFailure = expect(abort).rejects.toThrow('replacement boot failed')
    await vi.waitFor(() => expect(workers).toHaveLength(2))
    workers[1]!.emit('message', { event: 'init-error', error: 'replacement boot failed' })
    const replacementExit = vi.waitFor(() => workers[1]!.emit('exit', 1))
    await bootFailure
    await replacementExit
    expect(workers).toHaveLength(2)
    await expect(client.request('currency:get')).rejects.toThrow('replacement boot failed')
  })

  it('rejects recovery when the replacement exits before ready', async () => {
    const { client, workers } = controlledClient()
    const oldWorker = workers[0]!
    ready(oldWorker)
    await client.ready
    oldWorker.terminateImpl = async () => 0

    const abort = Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.scanAbortEffect([], 10))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    const failure = expect(abort).rejects.toThrow('data worker failed to start (exit 1)')
    await vi.waitFor(() => expect(workers).toHaveLength(2))
    workers[1]!.emit('exit', 1)
    await failure
    expect(workers).toHaveLength(2)
    await expect(client.request('currency:get')).rejects.toThrow('data worker failed to start (exit 1)')
  })

  it('uses the worker present when a previously constructed abort Effect runs', async () => {
    const { client, workers } = controlledClient()
    const firstWorker = workers[0]!
    ready(firstWorker)
    await client.ready
    const abort = client.scanAbortEffect([], 2_000)

    firstWorker.emit('exit', 1)
    await vi.waitFor(() => expect(workers).toHaveLength(2), { timeout: 5_000 })
    const replacement = workers[1]!
    ready(replacement)

    const result = Effect.runPromise(abort)
    await vi.waitFor(() => expect(replacement.posted.map(request => request.op)).toContain('scan:abort'))
    const request = replacement.posted.find(message => message.op === 'scan:abort')!
    replacement.emit('message', { id: request.id, ok: true, data: 'aborted' })
    await expect(result).resolves.toBe('aborted')
    expect(firstWorker.posted).toHaveLength(0)

    await client.terminate()
  })

  it('bounds replacement readiness with the caller TestClock', async () => {
    const { client, workers } = controlledClient()
    const oldWorker = workers[0]!
    ready(oldWorker)
    await client.ready
    oldWorker.terminateImpl = async () => 0

    const recovery = Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.scanAbortEffect([], 10, 20))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        yield* Effect.promise(() => vi.waitFor(() => expect(workers).toHaveLength(2)))
        yield* TestClock.adjust(20)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    await expect(recovery).rejects.toThrow('replacement worker did not become ready')
    expect(workers[1]!.terminationCalls).toBe(1)

    await client.terminate()
  })

  it('settles queued requests when a listener defects during recovery completion', async () => {
    const { client, workers } = controlledClient()
    const oldWorker = workers[0]!
    ready(oldWorker)
    await client.ready
    oldWorker.terminateImpl = async () => 0
    client.onEvent(event => {
      if (event.event === 'scan:error') throw new Error('event listener defect')
    })

    const abort = Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.scanAbortEffect([], 10))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    const abortFailure = expect(abort).rejects.toThrow('event listener defect')
    await vi.waitFor(() => expect(workers).toHaveLength(2))
    const queued = client.request('currency:get')
    const queuedFailure = expect(queued).rejects.toThrow('event listener defect')
    ready(workers[1]!)
    await abortFailure
    await queuedFailure
    await client.terminate()
  })

  it('terminates and rejects a replacement that never completes its ready handshake', async () => {
    const { client, workers } = controlledClient()
    const oldWorker = workers[0]!
    ready(oldWorker)
    await client.ready
    oldWorker.terminateImpl = async () => 0

    const abort = Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.scanAbortEffect([], 10, 10))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        yield* Effect.promise(() => vi.waitFor(() => expect(workers).toHaveLength(2)))
        yield* TestClock.adjust(10)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    const bootFailure = expect(abort).rejects.toThrow('replacement worker did not become ready')
    await bootFailure
    expect(workers[1]!.terminationCalls).toBe(1)
    expect(workers).toHaveLength(2)
    await expect(client.request('currency:get')).rejects.toThrow('replacement worker did not become ready')
  })
})

describe('DbWorkerClient real scan-abort termination', () => {
  let directory = ''

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
    directory = ''
  })

  it('kills a wedged worker before its scheduled callback can write or publish progress', async () => {
    directory = mkdtempSync(join(tmpdir(), 'watchtower-abort-recovery-'))
    const markerPath = join(directory, 'late-write.txt')
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'scan-abort-stuck-worker.cjs')
    const init: DbWorkerData = { dbPath: ':memory:', dataDir: directory, cacheDir: directory }
    const events: DbWorkerEvent[] = []
    const client = new DbWorkerClient(
      init,
      fixture,
      () =>
        new Worker(fixture, {
          workerData: { markerPath, lateWriteDelayMs: SCAN_ABORT_DRAIN_TIMEOUT_MS + 300 },
        }) as unknown as DbWorkerPort,
    )
    client.onEvent(event => events.push(event))
    try {
      await client.ready

      const scan = client.request('scan:start')
      const scanRejected = expect(scan).rejects.toThrow('data worker terminated after scan abort timed out')
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: 'scan:progress' })))
      const start = Date.now()
      await expect(client.request('scan:abort')).rejects.toThrow('scan abort drain timed out; worker was restarted')
      expect(Date.now() - start).toBeLessThan(5_000)
      await scanRejected
      await new Promise(resolve => setTimeout(resolve, 450))
      expect(existsSync(markerPath)).toBe(false)
      expect(events.filter(event => event.event === 'scan:progress')).toHaveLength(1)
    } finally {
      await client.terminate()
    }
  })
})
