import { useAtomSet, useAtomValue } from '@effect/atom-react'

import { useScanning } from '@/renderer/stores/hooks/use-scan-store'

import { placementAtom, requestPlacementAtom } from '@/renderer/orb/placement-atoms.js'

export function useOrbBeaconStore() {
  const expanded = useAtomValue(placementAtom).expanded
  const scanning = useScanning()
  const requestPlacement = useAtomSet(requestPlacementAtom)

  return { expanded, scanning, requestPlacement }
}
