import { useAtomSet, useAtomValue } from '@effect/atom-react'

import { useScanning } from '@/stores/hooks/use-scan-store'

import { placementAtom, requestPlacementAtom } from './placement-atoms.js'

export function useOrbBeaconStore() {
  const expanded = useAtomValue(placementAtom).expanded
  const scanning = useScanning()
  const requestPlacement = useAtomSet(requestPlacementAtom)

  return { expanded, scanning, requestPlacement }
}
