import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { AssistantSetup } from '../src/main/application/assistant-setup.js'
import { queryOptimizeView } from '../src/main/application/optimize-query.js'
import { LedgerIngest, LedgerQueries } from '../src/main/store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../src/main/store/ledger-query-snapshot.js'
import { buildFixtureCachedFile } from './fixtures/cached-file.js'
import { atTime, openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'

describe('Optimize focused call diagnostics', () => {
  it('opts into captured result facts while normal snapshots remain narrow', async () => {
    const { runtime } = openLedgerFixture()
    const file = buildFixtureCachedFile()
    const call = file.turns[0]!.calls[0]!
    call.toolErrors = 2
    call.editFailed = 1
    call.interrupted = true
    call.userModified = true
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'diagnostics-test',
          filePath: '/diagnostics/session.json',
          verdict: 'new',
          cachedFile: file,
        }),
      ),
    )

    const input = viewInputs({ period: 'lifetime', provider: 'opencode' })
    const narrow = runtime.runSync(loadLedgerQuerySnapshotEffect(input))
    expect(narrow.callDiagnostics).toBeUndefined()
    expect(narrow.calls[0]).not.toHaveProperty('toolErrors')
    const focused = runtime.runSync(loadLedgerQuerySnapshotEffect(input, undefined, true))
    expect(focused.calls).toEqual(narrow.calls)
    expect(focused.callDiagnostics).toEqual([
      expect.objectContaining({
        sessionId: 'sess-0',
        toolErrors: 2,
        editFailed: 1,
        interrupted: 1,
        userModified: 1,
      }),
    ])

    const setup = AssistantSetup.of({
      getOptimizeSetup: () => Effect.die('Non-Claude data must not read Claude setup'),
      getSkillInventory: () => Effect.succeed([]),
    })
    const payload = await runtime.runPromise(
      atTime(
        queryOptimizeView(input).pipe(Effect.provideService(AssistantSetup, setup)),
        new Date('2026-07-15T12:00:00.000Z'),
      ),
    )
    for (const id of ['tool-failures', 'interrupted-calls']) {
      const finding = payload.findings.find(finding => finding.id === id)
      expect(finding).toMatchObject({
        basis: 'observed',
        quantity: { value: 1, unit: 'calls' },
        associatedSpendUSD: 0.42,
        estimatedSavingsUSD: null,
        affectedSessions: [expect.objectContaining({ sessionId: 'sess-0', costUSD: 0.42 })],
      })
    }
    expect(payload.summary.potentialSavingsCostUSD).toBeNull()
  })

  it('keeps diagnostics outside the selected period from generating findings', async () => {
    const { runtime } = openLedgerFixture()
    const file = buildFixtureCachedFile()
    file.turns[0]!.calls[0]!.toolErrors = 1
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'diagnostics-test',
          filePath: '/diagnostics/old-session.json',
          verdict: 'new',
          cachedFile: file,
        }),
      ),
    )
    const range = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-21T00:00:00Z') }
    const snapshot = runtime.runSync(
      Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData(range, true)),
    )
    expect(snapshot.calls).toEqual([])
    expect(snapshot.callDiagnostics).toEqual([])
  })
})
