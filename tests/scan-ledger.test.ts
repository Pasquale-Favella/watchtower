import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/pipeline/scan.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/main/pipeline/scan.js')>()),
  runScan: vi.fn(),
}))

import { GatewayReports } from '../src/main/application/gateway-reports.js'
import { scanLedger } from '../src/main/application/scan-ledger.js'
import { runScan, ScanAbortedError, type ScanMetadata } from '../src/main/pipeline/scan.js'
import { atTime, openLedgerFixture } from './fixtures/ledger-runtime.js'

const metadata: ScanMetadata = {
  scanId: 'scan-fixture',
  startedAt: '2026-10-09T08:00:00.000Z',
  completedAt: '2026-10-09T08:00:00.000Z',
  portedFiles: 0,
  unchangedFiles: 0,
  failedFiles: 0,
  perProvider: [],
  aborted: false,
}

afterEach(() => vi.resetAllMocks())

describe('ledger scan application workflow', () => {
  it('captures the application clock for the lifetime range and forwards the owned callbacks', async () => {
    const { runtime } = openLedgerFixture()
    const now = new Date('2026-10-09T08:00:00.000Z')
    const emit = vi.fn()
    const control = { isAborted: () => false }
    const getReport = () => Effect.succeed([])
    vi.mocked(runScan).mockReturnValue(Effect.succeed(metadata))

    const result = await runtime.runPromise(
      atTime(scanLedger({ provider: 'codex' }, emit, control), now).pipe(
        Effect.provideService(GatewayReports, GatewayReports.of({ enabled: true, getReport })),
      ),
    )

    expect(result).toBe(metadata)
    expect(runScan).toHaveBeenCalledExactlyOnceWith(
      { range: { start: new Date(0), end: now }, provider: 'codex' },
      emit,
      control,
      expect.any(Function),
      { gatewayEnabled: true, fetchGatewayReport: getReport },
    )
    expect(emit).not.toHaveBeenCalled()
  })

  it('preserves the typed scan failure for the worker protocol boundary', async () => {
    const { runtime } = openLedgerFixture()
    const reason = new ScanAbortedError({ message: 'scan aborted' })
    vi.mocked(runScan).mockReturnValue(Effect.fail(reason))

    const result = await runtime.runPromiseExit(scanLedger(undefined, vi.fn(), { isAborted: () => false }))

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const failure = Cause.findErrorOption(result.cause)
      expect(Option.isSome(failure) ? failure.value : undefined).toBe(reason)
    }
  })
})
