import { useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'

import { refreshScanAtom, scanStateAtom } from '../atoms/scan.js'

const hydratedAtom = Atom.make(get => get(scanStateAtom).hydrated)
const scanningAtom = Atom.make(get => get(scanStateAtom).scanning)
const scanErrorAtom = Atom.make(get => get(scanStateAtom).scanError)
const unparsedTotalAtom = Atom.make(get => get(scanStateAtom).unparsedTotal)
const detectedProvidersAtom = Atom.make(get => get(scanStateAtom).detectedProviders)
const progressAtom = Atom.make(get => get(scanStateAtom).progress)
const stageAtom = Atom.make(get => get(scanStateAtom).stage)

export function useScanStore() {
  const hydrated = useAtomValue(hydratedAtom)
  const scanning = useAtomValue(scanningAtom)
  const scanError = useAtomValue(scanErrorAtom)
  const unparsedTotal = useAtomValue(unparsedTotalAtom)
  const detectedProviders = useAtomValue(detectedProvidersAtom)
  const progress = useAtomValue(progressAtom)
  const stage = useAtomValue(stageAtom)
  const refreshScan = useAtomSet(refreshScanAtom)

  return { hydrated, scanning, scanError, unparsedTotal, detectedProviders, progress, stage, refreshScan }
}

export function useDetectedProviders(): string[] {
  return useAtomValue(detectedProvidersAtom)
}

export function useScanning(): boolean {
  return useAtomValue(scanningAtom)
}

export function useScanHydrated(): boolean {
  return useAtomValue(hydratedAtom)
}
