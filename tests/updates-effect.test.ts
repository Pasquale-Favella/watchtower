import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, describe, expect, it } from 'vitest'

import { closeOperationalLog, initOperationalLog, OperationalLogLoggerLayer } from '../src/main/operational-log.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { runWithTestClockWindow } from './helpers/run-effect-test.js'
import {
  createUpdateCheckerEffect,
  fetchReleasesEffect,
  type UpdateCheckerEffect,
  UpdateFetchError,
  type UpdateStatus,
} from '../src/main/updates.js'
import { runEffectTest } from './helpers/run-effect-test.js'

const CURRENT = '0.1.0'

afterEach(() => {
  closeOperationalLog()
})

function okFetch(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch
}

function statusFetch(status: number): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    json: async () => ({}),
  })) as unknown as typeof fetch
}

function throwingFetch(message = 'offline'): typeof fetch {
  return (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch
}

const neverFetch = (() => new Promise<Response>(() => {})) as typeof fetch

function makeChecker(version: string = CURRENT): Promise<UpdateCheckerEffect> {
  return Effect.runPromise(createUpdateCheckerEffect({ currentVersion: version }))
}

function runCheck(checker: UpdateCheckerEffect, fetchImpl: typeof fetch): Promise<UpdateStatus> {
  // `OperationalLogLoggerLayer` is what production installs in `MainLive`; this
  // test builds its own graph, so it installs the `Logger` reference itself.
  // Without it the `update.offline` record would go to Effect's default logger.
  return Effect.runPromise(
    checker
      .check()
      .pipe(Effect.provide(OperationalLogLoggerLayer), Effect.provide(HttpFetch.layerWithFetch(fetchImpl))),
  )
}

function runFetchReleases(fetchImpl: typeof fetch): Promise<Array<{ tag_name?: string }>> {
  return Effect.runPromise(fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl))))
}

function readOperationalLogLines(logDir: string): string[] {
  const lines: string[] = []
  for (const file of readdirSync(logDir).filter(f => f.startsWith('operational'))) {
    const content = readFileSync(join(logDir, file), 'utf8')
    for (const line of content.split('\n')) {
      if (line.trim() !== '') {
        lines.push(line)
      }
    }
  }
  return lines
}

describe('fetchReleasesEffect (Effect-native releases boundary)', () => {
  it('passes through the releases array from a 200 response', async () => {
    const releases = await runFetchReleases(okFetch([{ tag_name: 'v0.2.0' }]))
    expect(releases).toEqual([{ tag_name: 'v0.2.0' }])
  })

  it('maps a non-2xx response to a typed UpdateFetchError', async () => {
    const error = await Effect.runPromise(
      fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(statusFetch(404))), Effect.flip),
    )
    expect(error).toBeInstanceOf(UpdateFetchError)
    expect(error.reason).toBe('http')
    expect(error.status).toBe(404)
    expect(error.message).toBe('GitHub HTTP 404')
  })

  it('yields [] for non-array JSON', async () => {
    const releases = await runFetchReleases(okFetch({ tag_name: 'v0.2.0' }))
    expect(releases).toEqual([])
  })

  it('maps a network rejection to a typed network error', async () => {
    const error = await Effect.runPromise(
      fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(throwingFetch())), Effect.flip),
    )
    expect(error).toBeInstanceOf(UpdateFetchError)
    expect(error.reason).toBe('network')
  })

  it('times out via the Effect Clock (TestClock-controllable)', async () => {
    const error = await runEffectTest(
      Effect.gen(function* () {
        return yield* runWithTestClockWindow(
          fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(neverFetch))),
          60_000,
        ).pipe(Effect.flip)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(error).toBeInstanceOf(UpdateFetchError)
    expect(error.reason).toBe('timeout')
  })
})

describe('createUpdateCheckerEffect (Effect-native check)', () => {
  it('flags an update when a newer desktop release exists', async () => {
    const checker = await makeChecker()
    expect(await runCheck(checker, okFetch([{ tag_name: 'v0.2.0' }]))).toEqual({
      currentVersion: CURRENT,
      latestVersion: '0.2.0',
      updateAvailable: true,
      tag: 'v0.2.0',
    })
  })

  it('reports up-to-date when the newest release equals the running version', async () => {
    const checker = await makeChecker()
    expect(await runCheck(checker, okFetch([{ tag_name: 'v0.1.0' }]))).toEqual({
      currentVersion: CURRENT,
      latestVersion: '0.1.0',
      updateAvailable: false,
      tag: null,
    })
  })

  it('reports up-to-date (no tag link) when the newest release is older', async () => {
    const checker = await makeChecker()
    const status = await runCheck(checker, okFetch([{ tag_name: 'v0.0.9' }]))
    expect(status).toMatchObject({ updateAvailable: false, latestVersion: '0.0.9', tag: null })
  })

  it('degrades to cached status on offline with the offline note — never fails', async () => {
    const base = mkdtempSync(join(tmpdir(), 'watchtower-updates-effect-'))
    try {
      await initOperationalLog({ logDir: join(base, 'logs'), isPackaged: true })
      const checker = await makeChecker()
      const status = await runCheck(checker, throwingFetch())
      expect(status).toEqual({
        currentVersion: CURRENT,
        latestVersion: null,
        updateAvailable: false,
        tag: null,
      })
      const lines = readOperationalLogLines(join(base, 'logs'))
      expect(lines).toHaveLength(1)
      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(parsed).toMatchObject({ level: 'info', event: 'update.offline', op: 'updates:check', code: 'unavailable' })
    } finally {
      closeOperationalLog()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('recovers on the next check after a failure', async () => {
    const checker = await makeChecker()
    expect((await runCheck(checker, throwingFetch())).updateAvailable).toBe(false)
    expect(await runCheck(checker, okFetch([{ tag_name: 'v0.2.0' }]))).toMatchObject({
      updateAvailable: true,
      latestVersion: '0.2.0',
    })
  })

  it('dedupes concurrent checks into a single fetch', async () => {
    const checker = await makeChecker()
    let fetches = 0
    const slow = (async () => {
      fetches += 1
      await new Promise(resolve => setTimeout(resolve, 20))
      return { ok: true, status: 200, json: async () => [{ tag_name: 'v0.2.0' }] }
    }) as unknown as typeof fetch
    const [first, second] = await Effect.runPromise(
      Effect.all([checker.check(), checker.check()], { concurrency: 2 }).pipe(
        Effect.provide(HttpFetch.layerWithFetch(slow)),
      ),
    )
    expect(first).toEqual(second)
    expect(first).toMatchObject({ updateAvailable: true, latestVersion: '0.2.0' })
    expect(fetches).toBe(1)
  })

  it('times out via TestClock and falls back to cached status', async () => {
    const checker = await makeChecker()
    const status = await runEffectTest(
      Effect.gen(function* () {
        return yield* runWithTestClockWindow(
          checker.check().pipe(Effect.provide(HttpFetch.layerWithFetch(neverFetch))),
          60_000,
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(status).toEqual({
      currentVersion: CURRENT,
      latestVersion: null,
      updateAvailable: false,
      tag: null,
    })
  })

  it('fiber interruption propagates and leaves the checker usable', async () => {
    const checker = await makeChecker()
    let observedSignal: AbortSignal | undefined
    const hanging = ((_: string, init: RequestInit = {}) => {
      observedSignal = init.signal ?? undefined
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }) as typeof fetch
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(checker.check().pipe(Effect.provide(HttpFetch.layerWithFetch(hanging))))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(observedSignal?.aborted).toBe(true)
    // The interrupted flight was cleared: the next check starts a fresh one.
    expect(await runCheck(checker, okFetch([{ tag_name: 'v0.2.0' }]))).toMatchObject({ updateAvailable: true })
  })
})
