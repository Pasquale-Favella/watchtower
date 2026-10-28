import { useAtomSet, useAtomValue } from '@effect/atom-react'

import { querySnapshot } from '@/app/hooks/use-remote-query.js'
import { useScanning } from '@/app/hooks/use-scan-store.js'
import { useCurrencyFormatter } from '@/shared/lib/use-currency-formatter.js'

import { orbControls } from './native-shell.js'
import {
  orbRecentQuery,
  orbTodayQuery,
  scanStartErrorAtom,
  scanStartPendingAtom,
  startScanAtom,
} from './panel-atoms.js'
import { placementAtom } from './placement-atoms.js'

export function useOrbPanelStore() {
  const { currency, formatUsd } = useCurrencyFormatter()
  const placement = useAtomValue(placementAtom)
  const today = querySnapshot(useAtomValue(orbTodayQuery.resultAtom))
  const recent = querySnapshot(useAtomValue(orbRecentQuery.resultAtom))
  const scanning = useScanning()
  const scanPending = useAtomValue(scanStartPendingAtom)
  const scanCommandError = useAtomValue(scanStartErrorAtom)
  const startScan = useAtomSet(startScanAtom)

  return {
    currency,
    formatUsd,
    peek: placement.peek,
    today,
    recent,
    scanning,
    scanPending,
    scanCommandError,
    startScan,
    orbControls,
  }
}
