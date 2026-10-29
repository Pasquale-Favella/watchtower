import * as Effect from 'effect/Effect'
import type { ScanMetadata, ScanProgress } from '../../../shared/schemas/scan.js'
import * as Clock from '../../ports/clock.js'
import { CommandRunner } from '../../ports/process.js'
import { ScanSources, type DeltaHandler } from '../../ports/ingestion.js'
import { getRepoUrlEffect } from '../../ingestion/discovery/git-remote.js'
import { ScanAbortedError } from '../../ingestion/reconciliation/scan-control.js'
import { LedgerIngest } from '../../ports/repository.js'
import { GatewayReports } from '../../ports/gateway-reports.js'

/** Port lifetime data through the worker's existing services. The worker owns
 * the scan fiber and supplies its cooperative stop state and progress callback. */
export const scanLedger = Effect.fnUntraced(function* (
  options: { provider?: string } | undefined,
  emit: (progress: ScanProgress) => void,
  control: { isAborted(): boolean },
): Effect.fn.Return<ScanMetadata, unknown, LedgerIngest | CommandRunner | GatewayReports | ScanSources> {
  const ingest = yield* LedgerIngest
  const runner = yield* CommandRunner
  const gateway = yield* GatewayReports
  const sources = yield* ScanSources
  // Cold scans must include history before the selected view period. Views
  // apply Scope when reading, while scans always port epoch through now.
  const range = { start: new Date(0), end: new Date(yield* Clock.currentTimeMillis) }
  const repoUrls = new Map<string, string | undefined>()
  const portIn: DeltaHandler = Effect.fnUntraced(function* (delta, pricing) {
    if (delta.cachedFile.failed) return
    if (control.isAborted()) return yield* new ScanAbortedError({ message: 'scan aborted' })
    const cwd = delta.cachedFile.canonicalCwd ?? delta.workingDirectory ?? delta.cachedFile.workingDirectory
    let repoUrl: string | undefined
    if (cwd) {
      // Remember absent remotes as well, and never use the badge as identity.
      if (!repoUrls.has(cwd)) {
        repoUrls.set(cwd, yield* getRepoUrlEffect(cwd).pipe(Effect.provideService(CommandRunner, runner)))
      }
      repoUrl = repoUrls.get(cwd)
    }
    if (control.isAborted()) return yield* new ScanAbortedError({ message: 'scan aborted' })
    yield* ingest.portIn({ ...delta, repoUrl }, pricing)
  })
  return yield* sources.run({ range, provider: options?.provider }, emit, control, portIn, {
    gatewayEnabled: gateway.enabled,
    fetchGatewayReport: gateway.getReport,
  })
})
