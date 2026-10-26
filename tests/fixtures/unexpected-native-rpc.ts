import * as Effect from 'effect/Effect'

import { nativeHandlers } from '../../src/main/rpc/native-handlers.js'

const unexpected = () => Effect.die(new Error('Unexpected native RPC operation in a data-query test'))

/** Keep data-query tests on the production group while refusing unrelated capabilities. */
export const unexpectedNativeHandlers = nativeHandlers({
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
})
