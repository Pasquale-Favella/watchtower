import { loadPricing } from './models.js'
import { parseAllSessions } from './parser.js'
import type { DeltaHandler } from './parser.js'
import type { DateRange } from './types.js'
import type {
  ScanMetadata,
  ScanOptions,
  ScanProgress,
} from '../../shared/schemas/scan.js'

export type {
  PerProviderPort,
  ScanMetadata,
  ScanOptions,
  ScanProgress,
  ScanStage,
} from '../../shared/schemas/scan.js'

export class ScanAbortedError extends Error {
  constructor() {
    super('scan aborted')
    this.name = 'ScanAbortedError'
  }
}

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
export async function runScan(
  options: ScanOptions,
  onProgress?: (progress: ScanProgress) => void,
  abort?: { isAborted(): boolean },
  onDelta?: DeltaHandler
): Promise<ScanMetadata> {
  const scanId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = new Date().toISOString()

  onProgress?.({ stage: 'pricing' })
  await loadPricing()

  onProgress?.({ stage: 'parse' })
  if (onDelta) onProgress?.({ stage: 'port-in' })

  const perProvider = new Map<string, { provider: string; ported: number; unchanged: number; failed: number; unparsed: number }>()
  const ensureProvider = (provider: string): { provider: string; ported: number; unchanged: number; failed: number; unparsed: number } => {
    let row = perProvider.get(provider)
    if (!row) {
      row = { provider, ported: 0, unchanged: 0, failed: 0, unparsed: 0 }
      perProvider.set(provider, row)
    }
    return row
  }

  let aborted = false

  const countingDelta: DeltaHandler | undefined = onDelta
    ? async delta => {
        if (abort?.isAborted()) {
          aborted = true
          throw new ScanAbortedError()
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

  await parseAllSessions(options.range, options.provider, countingDelta, onUnparsed)

  if (onDelta && abort?.isAborted()) {
    aborted = true
    throw new ScanAbortedError()
  }

  const providerRows = [...perProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider))
  const portedFiles = providerRows.reduce((s, r) => s + r.ported, 0)
  const unchangedFiles = providerRows.reduce((s, r) => s + r.unchanged, 0)
  const failedFiles = providerRows.reduce((s, r) => s + r.failed, 0)

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
}
