import { useAtomSet, useAtomValue } from '@effect/atom-react'

import { querySnapshot } from '@/renderer/stores/hooks/use-remote-query'
import { useScanning } from '@/renderer/stores/hooks/use-scan-store'
import { useCurrencyFormatter } from '@/renderer/shared/lib/use-currency-formatter'

import { orbControls } from '@/renderer/orb/native-shell.js'
import {
  orbRecentQuery,
  orbTodayQuery,
  scanStartErrorAtom,
  scanStartPendingAtom,
  startScanAtom,
} from '@/renderer/orb/panel-atoms.js'
import { placementAtom } from '@/renderer/orb/placement-atoms.js'

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
