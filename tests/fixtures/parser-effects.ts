import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Effect from 'effect/Effect'

import { Env } from '../../src/main/env.js'
import { HttpFetch } from '../../src/main/pipeline/fetch-utils.js'
import { type DeltaHandler, parseAllSessionsEffect } from '../../src/main/pipeline/parser.js'
import type { ProviderScanServices } from '../../src/main/pipeline/providers/types.js'
import { scanAbortError } from '../../src/main/pipeline/scan-control.js'
import type { DateRange, ProjectSummary } from '../../src/main/pipeline/types.js'
import type { ScanDelta } from '../../src/shared/schemas/scan.js'

type PromiseDeltaHandler = (delta: ScanDelta, pricing?: Parameters<DeltaHandler>[1]) => void | Promise<void>

/** Run the native parser with the production runtime services at the test boundary. */
export function runParseAllSessionsForTest(
  dateRange?: DateRange,
  providerFilter?: string,
  onDelta?: PromiseDeltaHandler,
  onUnparsed?: (provider: string, count: number) => void,
  signal?: AbortSignal,
  services: ProviderScanServices = {},
): Promise<ProjectSummary[]> {
  const nativeDelta: DeltaHandler | undefined = onDelta
    ? (delta, pricing) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const promise = Promise.resolve().then(() => {
              if (signal?.aborted) throw scanAbortError(signal)
              return onDelta(delta, pricing)
            })
            const drain = promise.then(
              () => undefined,
              () => undefined,
            )
            return { promise, drain }
          }),
          owned =>
            Effect.tryPromise({
              try: () => owned.promise,
              catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
            }),
          owned => Effect.void.pipe(Effect.ensuring(Effect.promise(() => owned.drain))),
        )
    : undefined

  return Effect.runPromise(
    parseAllSessionsEffect(dateRange, providerFilter, nativeDelta, onUnparsed, signal, services).pipe(
      Effect.provide(Env.layer),
      Effect.provide(HttpFetch.layerWithFetch(globalThis.fetch)),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
}
