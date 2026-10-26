import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { useEffect } from 'react'

import { pinWindowAtom } from '@/app/hooks/use-remote-query'
import { registry, runtime } from '@/app/renderer-runtime'
import { orbControls } from '@/shared/lib/api'
import { RendererApi } from '@/shared/lib/renderer-api'

import { loadOrbOverviewAtom, orbRecentQuery, orbTodayQuery } from './panel-atoms'
import { panelEventsReadyAtom, subscribeToOrbPanel } from './panel-wiring'
import { syncPlacementAtom } from './placement-atoms'

const panelBootstrapAtom = runtime(RendererApi.layer).atom(get => {
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
