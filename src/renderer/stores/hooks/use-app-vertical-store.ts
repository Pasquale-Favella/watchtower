import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'

import type { AppVertical } from '@/renderer/app/navigation.js'
import { navigateToVertical } from '@/renderer/app/navigation.js'
import {
  appVerticalAtom,
  lastAnalyticsDestinationAtom,
  syncAppVerticalFromRouteAtom,
} from '@/renderer/stores/atoms/app-vertical.js'

export function useAppVerticalStore(): {
  readonly vertical: AppVertical
  readonly switchVertical: (vertical: AppVertical) => void
} {
  const vertical = useAtomValue(appVerticalAtom)
  const lastAnalyticsDestination = useAtomValue(lastAnalyticsDestinationAtom)

  return {
    vertical,
    switchVertical: next => navigateToVertical(next, lastAnalyticsDestination),
  }
}

/** Synchronize the Atom-owned vertical and return route after Router commits navigation. */
export function useSyncAppVerticalFromRoute(): void {
  const { pathname, search } = useRouterState({ select: state => state.location })
  const syncFromRoute = useAtomSet(syncAppVerticalFromRouteAtom)
  const sourceId = typeof search.sourceId === 'number' ? search.sourceId : undefined

  useEffect(() => {
    syncFromRoute({ pathname, ...(sourceId === undefined ? {} : { sourceId }) })
  }, [pathname, sourceId, syncFromRoute])
}
