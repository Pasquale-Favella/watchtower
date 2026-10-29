import { useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { useEffect } from 'react'

import { pinWindowAtom } from '@/renderer/stores/hooks/use-remote-query'
import { registry, runtime } from '@/renderer/app/renderer-runtime'

import { PanelRoleClient } from '@/renderer/orb/panel-role-client'
import { orbControls } from '@/renderer/orb/native-shell'
import { loadOrbOverviewAtom, orbRecentQuery, orbTodayQuery } from '@/renderer/orb/panel-atoms'
import { panelEventsReadyAtom, subscribeToOrbPanel } from '@/renderer/orb/panel-wiring'
import { placementAtom, requestPlacementAtom, syncPlacementAtom } from '@/renderer/orb/placement-atoms'

const panelBootstrapAtom = PanelRoleClient.runtime.atom(get => {
  get.addFinalizer(subscribeToOrbPanel(get.registry))
  pinWindowAtom(get.registry, orbTodayQuery.resultAtom)
  pinWindowAtom(get.registry, orbRecentQuery.resultAtom)
  return Effect.gen(function* () {
    yield* Stream.runDrain(
      get.stream(panelEventsReadyAtom).pipe(
        Stream.filter(state => state === 'ready' || state === 'failed'),
        Stream.take(1),
      ),
    )
    yield* Effect.all(
      [Effect.ignore(get.setResult(syncPlacementAtom, undefined)), get.setResult(loadOrbOverviewAtom, undefined)],
      { concurrency: 'unbounded' },
    )
    yield* Effect.sync(() => orbControls.panelDataReady())
    return yield* Effect.never
  })
})

export function useOrbPanelBootstrap(): void {
  useEffect(() => {
    pinWindowAtom(registry, panelBootstrapAtom)
  }, [])
}

export function useOrbPanelAppStore() {
  const expanded = useAtomValue(placementAtom).expanded
  const request = useAtomSet(requestPlacementAtom)

  return { expanded, request, panelPainted: orbControls.panelPainted }
}
