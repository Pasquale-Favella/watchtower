import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'

import { nativeHandlers } from '../../src/main/rpc/native-handlers.js'
import { CoachRpcGroup } from '../../src/shared/rpc/coach.js'

const unexpected = () => Effect.die(new Error('Unexpected native RPC operation in a data-query test'))

export const unexpectedCoachHandlers = CoachRpcGroup.toLayer({
  'coach:run': () => Stream.die(new Error('Unexpected Coach run in a data-query test')),
  'coach:cancel': unexpected,
  'coach:reset': unexpected,
})

/** Keep data-query tests on the production group while refusing unrelated capabilities. */
export const unexpectedNativeHandlers = Layer.merge(
  nativeHandlers({
    startScan: unexpected,
    isScanActive: unexpected,
    getUpdateStatus: unexpected,
    checkForUpdates: unexpected,
    downloadUpdate: unexpected,
    installUpdate: unexpected,
    exportData: unexpected,
    getLedgerMcpStatus: unexpected,
    setLedgerMcpStartupMode: unexpected,
    getLedgerMcpConnection: unexpected,
    regenerateLedgerMcpToken: unexpected,
    getAppVersion: unexpected,
    dismissSkill: unexpected,
    saveSkill: unexpected,
    getCoachHarnesses: unexpected,
    refreshCoachHarnesses: unexpected,
    inspectCoachHarness: unexpected,
    openCoachLoginTerminal: unexpected,
  }),
  unexpectedCoachHandlers,
)
