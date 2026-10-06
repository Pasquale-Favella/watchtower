import * as Effect from 'effect/Effect'
import type * as Layer from 'effect/Layer'

import type { OperationalLogSink } from '../../src/main/operational-log.js'
import { LedgerStore } from '../../src/main/store/ledger.js'
import { openWorkerRuntime, type WorkerOverrides, type WorkerRuntime } from '../../src/main/worker-runtime.js'

/** Compatibility fixture for tests still seeding or reading through LedgerStore.
 * Remove after those callers use ledger ports for setup and assertions. */
export function openWorkerOwner<Overrides extends WorkerOverrides = never>(
  dbPath: string,
  sink?: OperationalLogSink,
  overrides?: Layer.Layer<Overrides>,
  options: Parameters<typeof openWorkerRuntime>[3] = {},
): { ledger: LedgerStore; runtime: WorkerRuntime } {
  const runtime = openWorkerRuntime(dbPath, sink, overrides, options)
  try {
    return { ledger: new LedgerStore(dbPath, { runtime, initialize: false }), runtime }
  } catch (error) {
    try {
      Effect.runSync(runtime.disposeEffect)
    } catch {
      // Preserve the fixture construction failure.
    }
    throw error
  }
}
