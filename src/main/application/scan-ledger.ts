import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'

import { CommandRunner } from '../agents/command-runner.js'
import type { Env } from '../env.js'
import type { OperationalLog } from '../operational-log.js'
import type { HttpFetch } from '../pipeline/fetch-utils.js'
import { getRepoUrlEffect } from '../pipeline/git-remote.js'
import type { DeltaHandler } from '../pipeline/parser.js'
import { runScan, ScanAbortedError, type ScanMetadata, type ScanProgress } from '../pipeline/scan.js'
import { LedgerIngest } from '../store/ledger-ports.js'
import { GatewayReports } from './gateway-reports.js'

/** Port lifetime data through the worker's existing services. The worker owns
 * the scan fiber and supplies its cooperative stop state and progress callback. */
export const scanLedger = Effect.fnUntraced(function* (
  options: { provider?: string } | undefined,
  emit: (progress: ScanProgress) => void,
  control: { isAborted(): boolean },
): Effect.fn.Return<
  ScanMetadata,
  unknown,
  HttpFetch | Env | OperationalLog | LedgerIngest | CommandRunner | GatewayReports
> {
  const ingest = yield* LedgerIngest
  const runner = yield* CommandRunner
  const gateway = yield* GatewayReports
  // Cold scans must include history before the selected view period. Views
  // apply Scope when reading, while scans always port epoch through now.
  const range = { start: new Date(0), end: DateTime.toDateUtc(yield* DateTime.now) }
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
  return yield* runScan({ range, provider: options?.provider }, emit, control, portIn, {
    gatewayEnabled: gateway.enabled,
    fetchGatewayReport: gateway.getReport,
  })
})
