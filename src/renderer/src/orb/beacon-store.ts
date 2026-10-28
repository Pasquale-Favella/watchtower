import { useAtomSet, useAtomValue } from '@effect/atom-react'

import { useScanning } from '@/app/hooks/use-scan-store.js'

import { placementAtom, requestPlacementAtom } from './placement-atoms.js'

export function useOrbBeaconStore() {
  const expanded = useAtomValue(placementAtom).expanded
  const scanning = useScanning()
  const requestPlacement = useAtomSet(requestPlacementAtom)

  return { expanded, scanning, requestPlacement }
}
