import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import type { PerProviderPort, ScanMetadata, ScanOptions, ScanProgress } from '../../shared/schemas/scan.js'
import type { Env } from '../env.js'
import { OperationalLog, SCAN_DURATION_COUNTER } from '../operational-log.js'
import { HttpFetch } from './fetch-utils.js'
import { loadPricingEffect } from './models.js'
import type { DeltaHandler } from './parser.js'
import { parseAllSessions } from './parser.js'
import type { ProviderScanServices } from './providers/types.js'
import { abortedScanError, ScanAbortedError } from './scan-control.js'

export type { PerProviderPort, ScanMetadata, ScanOptions, ScanProgress, ScanStage } from '../../shared/schemas/scan.js'
export { ScanAbortedError } from './scan-control.js'

type ScanDurationOutcome = 'success' | 'aborted' | 'failed'

interface OwnedScanPromise<A> {
  readonly promise: Promise<A>
  readonly drain: Promise<void>
  readonly controller: AbortController
  settled: boolean
}

/** Starts the parser only after its per-run stop signal has an owner. */
export function runOwnedScanPromise<A>(
  start: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ScanAbortedError | Error> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController()
      const promise = Promise.resolve().then(() =>
        controller.signal.aborted ? Promise.reject(abortedScanError()) : start(controller.signal),
      )
      const owned: OwnedScanPromise<A> = {
        promise,
        controller,
        settled: false,
        drain: promise.then(
          () => {
            owned.settled = true
          },
          () => {
            owned.settled = true
          },
        ),
      }
      return owned
    }),
    owned =>
      Effect.tryPromise({
        try: () => owned.promise,
        catch: cause => cause as ScanAbortedError | Error,
      }),
    owned =>
      Effect.promise(() => {
        if (!owned.settled) owned.controller.abort(abortedScanError())
        return owned.drain
      }),
  )
}

function isScanAbortedError(err: unknown): boolean {
  if (err instanceof ScanAbortedError) return true
  return typeof err === 'object' && err !== null && (err as { _tag?: unknown })._tag === 'ScanAbortedError'
}

/** Maps a finished scan `Exit` to the duration-counter outcome label
 * (labels only, no payloads). Success → `success`; failure whose cause
 * contains `ScanAbortedError` (typed abort) or an interruption (fiber abort
 * rides the flag) → `aborted`; every other failure or defect → `failed`.
 * Defects stay in `Cause` — this only reads the exit for the label, never
 * converts. Pure (unit-testable via `Exit`). */
function outcomeForScanExit(exit: Exit.Exit<unknown, unknown>): ScanDurationOutcome {
  if (Exit.isSuccess(exit)) return 'success'
  const cause = exit.cause as Cause.Cause<unknown>
  if (Cause.hasInterrupts(cause)) return 'aborted'
  for (const reason of cause.reasons) {
    if (reason._tag === 'Fail' && isScanAbortedError((reason as { error: unknown }).error)) return 'aborted'
  }
  return 'failed'
}

/** Files `SCAN_DURATION_COUNTER` for one finished scan (Wave 5 counter
 * wiring). Amount is wall duration in ms; fields are outcome labels only
 * (`op: 'scan'` + `outcome`) — never payloads, never paths. `outcome` is
 * allowlisted BY VALUE in `sanitizeOperationalRecord`
 * (`ALLOWED_ENUM_FIELDS.outcome`, transcribed from the `ScanDurationOutcome`
 * union above), so the dimension now reaches the file for a real breakdown
 * while any non-member is still dropped exactly like a free-text field — the
 * same closed treatment the probe slice's `status` and the fetch slice's
 * `reason` now have. Never throws (mirrors the probe/fetch `catchCause`
 * guard) so forked scan fibers are never broken by logging. Clock source is
 * `Clock.currentTimeMillis` so `TestClock` governs duration in tests. */
const fileScanDuration = Effect.fnUntraced(function* (
  start: number,
  exit: Exit.Exit<unknown, unknown>,
): Effect.fn.Return<void, never, OperationalLog> {
  const oplog = yield* OperationalLog
  const end = yield* Clock.currentTimeMillis
  const duration = Math.max(0, end - start)
  const outcome = outcomeForScanExit(exit)
  yield* oplog.incrementCounter(SCAN_DURATION_COUNTER, duration, { op: 'scan', outcome })
})

/**
 * Runs the full watchtower pipeline (discovery, parse, classify, price) and
 * returns the scan's METADATA — the ledger is written by the `onDelta`
 * callback, so no `ProjectSummary[]` ever leaves the scan (ADRs 0002/0004).
 *
 * When `onDelta` is supplied, each settled session file is streamed to the
 * handler as a delta (the ledger port-in seam) while the parse runs; port-in
 * commits per file and overlaps the tail of parse. A `port-in` stage tick
 * marks the streaming window; the `aggregate` stage no longer exists.
 */
export const runScan = Effect.fnUntraced(function* (
  options: ScanOptions,
  onProgress?: (progress: ScanProgress) => void,
  abort?: { isAborted(): boolean },
  onDelta?: DeltaHandler,
  providerServices: ProviderScanServices = {},
): Effect.fn.Return<ScanMetadata, ScanAbortedError | Error, HttpFetch | Env | OperationalLog> {
  // Wall-duration start via the Effect Clock so TestClock governs duration in
  // tests (mirrors `refreshFxRateWithRates` staleness + fetch-timeout Clock).
  // `Date.now`/`new Date` below stay for scanId/timestamps (wire, out of scope).
  const start = yield* Clock.currentTimeMillis

  return yield* Effect.gen(function* () {
    const scanId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const startedAt = new Date().toISOString()

    onProgress?.({ stage: 'pricing' })
    yield* loadPricingEffect()

    onProgress?.({ stage: 'parse' })
    if (onDelta) onProgress?.({ stage: 'port-in' })

    const perProvider = new Map<string, PerProviderPort>()
    const ensureProvider = (provider: string): PerProviderPort => {
      let row = perProvider.get(provider)
      if (!row) {
        row = { provider, ported: 0, unchanged: 0, failed: 0, unparsed: 0 }
        perProvider.set(provider, row)
      }
      return row
    }

    let aborted = false

    // Promise-boundary seam (NOT Effect-native): `DeltaHandler` is
    // `(delta) => void | Promise<void>`, so this stays `async`/`throw`.
    // Throws the TAGGED error with the preserved `'scan aborted'` message —
    // `instanceof` + `err.name` both keep working for the parser re-throw.
    const countingDelta: DeltaHandler | undefined = onDelta
      ? async delta => {
          if (abort?.isAborted()) {
            aborted = true
            throw abortedScanError()
          }
          const row = ensureProvider(delta.provider)
          if (delta.cachedFile.failed) {
            // failed files are counted but never forwarded: scan metadata knows
            // them, the ledger never ports a failed file
            row.failed++
            return
          }
          if (delta.verdict === 'unchanged') row.unchanged++
          else row.ported++
          await onDelta(delta)
        }
      : undefined

    // Extraction seam tally (ADR 0003): rows/blobs skipped because a declared
    // field failed its schema. Surfaced per-provider in scan metadata so provider
    // schema drift is visible, never fatal.
    const onUnparsed = (provider: string, count: number): void => {
      ensureProvider(provider).unparsed += count
    }

    // Parser work observes this per-run signal, but the Promise remains owned
    // until every parser and callback has actually settled after interruption.
    yield* runOwnedScanPromise(signal =>
      parseAllSessions(options.range, options.provider, countingDelta, onUnparsed, signal, providerServices),
    )

    if (onDelta && abort?.isAborted()) {
      aborted = true
      // Effect-native typed failure (NOT `throw`, which would be a defect):
      // always `return yield*` per AGENTS.md so `catchTag('ScanAbortedError')`
      // downstream sees the `_tag`.
      return yield* abortedScanError()
    }

    const providerRows: PerProviderPort[] = [...perProvider.values()].sort((a, b) =>
      a.provider.localeCompare(b.provider),
    )
    let portedFiles = 0
    let unchangedFiles = 0
    let failedFiles = 0
    for (const row of providerRows) {
      portedFiles += row.ported
      unchangedFiles += row.unchanged
      failedFiles += row.failed
    }

    onProgress?.({ stage: 'port-in', processed: portedFiles })
    return {
      scanId,
      startedAt,
      completedAt: new Date().toISOString(),
      portedFiles,
      unchangedFiles,
      failedFiles,
      perProvider: providerRows,
      aborted,
    }
  }).pipe(
    // Duration filing for every completion (success/abort/failure + interruption):
    // `onExit` replays the original exit unchanged after filing, so envelopes,
    // coalescing, and abort semantics stay byte-identical. Filing itself is
    // never-throw (`catchCause` swallows failure AND defect, mirroring the
    // fetch/probe slices) so forked scan fibers are never broken by logging.
    Effect.onExit(exit =>
      fileScanDuration(start, exit as Exit.Exit<unknown, unknown>).pipe(Effect.catchCause(() => Effect.void)),
    ),
  )
})

/** Operational-log record shape for a finished scan (#128): one `scan.finish`
 * totals record plus one `scan.provider` record per provider that has
 * unparsed or failed files. Providers with a clean run stay silent, so the
 * success path never chatters. Pure (unit-tested without a worker). */
export interface ScanSummaryRecord {
  logEvent: string
  level: 'info' | 'warn'
  fields: Record<string, string | number>
}

export function buildScanSummaryRecords(metadata: ScanMetadata): ScanSummaryRecord[] {
  const records: ScanSummaryRecord[] = []
  let unparsed = 0
  let failed = 0
  for (const row of metadata.perProvider ?? []) {
    unparsed += row.unparsed
    failed += row.failed
    if (row.unparsed > 0 || row.failed > 0) {
      records.push({
        logEvent: 'scan.provider',
        level: 'warn',
        fields: { provider: row.provider, unparsed: row.unparsed, failed: row.failed },
      })
    }
  }
  records.unshift({
    logEvent: 'scan.finish',
    level: 'info',
    fields: { op: 'scan', ported: metadata.portedFiles, unparsed, failed },
  })
  return records
}
