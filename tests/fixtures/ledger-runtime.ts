import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { onTestFinished } from 'vitest'

import type { ScopedViewQueryInputs } from '../../src/main/application/view-queries.js'
import { captureModelPricingCatalogue, captureProxyPaths } from '../../src/main/pipeline/models.js'
import { openWorkerRuntime, type WorkerRuntime } from '../../src/main/worker-runtime.js'

export interface LedgerFixture {
  readonly directory: string
  readonly dbPath: string
  readonly runtime: WorkerRuntime
}

function removeFixture(directory: string): void {
  assert.equal(dirname(directory), tmpdir())
  assert.ok(basename(directory).startsWith('watchtower-ledger-fixture-'))
  rmSync(directory, { recursive: true, force: true })
}

/** Owns the real worker runtime until the current test finishes, including failures. */
export function openLedgerFixture(): LedgerFixture {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-ledger-fixture-'))
  const dbPath = join(directory, 'ledger.db')
  try {
    const runtime = openWorkerRuntime(dbPath)
    onTestFinished(async () => {
      try {
        await runtime.dispose()
      } finally {
        removeFixture(directory)
      }
    })
    return { directory, dbPath, runtime }
  } catch (error) {
    try {
      removeFixture(directory)
    } catch {
      // Preserve the runtime construction failure.
    }
    throw error
  }
}

/** Fixes a query's wall-clock input while retaining the live sleep/monotonic clock. */
export function atTime<A, E, R>(effect: Effect.Effect<A, E, R>, now: Date): Effect.Effect<A, E, R> {
  const millis = now.getTime()
  const nanos = BigInt(millis) * 1_000_000n
  return Effect.clockWith(clock =>
    Effect.provideService(effect, Clock.Clock, {
      monotonicTimeNanos: clock.monotonicTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      sleep: duration => clock.sleep(duration),
      currentTimeMillis: Effect.succeed(millis),
      currentTimeMillisUnsafe: () => millis,
      currentTimeNanos: Effect.succeed(nanos),
      currentTimeNanosUnsafe: () => nanos,
    }),
  )
}

export function viewInputs(scope: ScopedViewQueryInputs['scope']): ScopedViewQueryInputs {
  return { scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }
}
