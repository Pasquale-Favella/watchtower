import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { useEffect } from 'react'

import { appLifecycleReadinessAtom, appRpcLifecycleAtom } from '@/app/atoms/rpc-lifecycle'
import { hydrateScanAtom, refreshScanAtom, scanStateAtom } from '@/app/atoms/scan'
import { registry, runtime } from '@/app/renderer-runtime'
import { appEventsReadyAtom, subscribeToIpc } from '@/app/stores/subscribe'
import { coachDetection, mountCoachWorkflow } from '@/features/coach-skills/atoms'
import {
  loadCadenceAtom,
  loadCurrencyAtom,
  loadCurrencyOptionsAtom,
  setCadenceAtom,
  setCurrencyAtom,
} from '@/features/settings/atoms'
import { mountSettingsCapabilityWorkflow } from '@/features/settings/capability-atoms'
import { preferencesAtom } from '@/features/settings/preferences-atoms'
import { loadUpdateStatusAtom } from '@/features/settings/updates-atoms'
import { RendererApi } from '@/shared/lib/renderer-api'

import { pinWindowAtom } from './use-remote-query.js'

export const appBootstrapAtom = runtime(RendererApi.layer).atom(get => {
  get.mount(refreshScanAtom)
  get.mount(appRpcLifecycleAtom)
  get.mount(setCadenceAtom)
  get.mount(setCurrencyAtom)
  get.mount(loadUpdateStatusAtom)
  get.addFinalizer(mountCoachWorkflow(get.registry))
  get.addFinalizer(mountSettingsCapabilityWorkflow(get.registry))
  get.addFinalizer(subscribeToIpc(get.registry))
  const preferences = get.registry.get(preferencesAtom)
  let thresholdKey = `${preferences.skillsFrequency}\0${preferences.skillsSpread}`
  get.subscribe(preferencesAtom, next => {
    const nextKey = `${next.skillsFrequency}\0${next.skillsSpread}`
    if (nextKey === thresholdKey) return
    thresholdKey = nextKey
    const request = get.registry.get(coachDetection.requestAtom)
    if (request)
      get.registry.set(coachDetection.requestAtom, {
        ...request,
        frequency: next.skillsFrequency,
        spread: next.skillsSpread,
      })
  })
  get.registry.set(loadUpdateStatusAtom, undefined)
  return Effect.gen(function* () {
    yield* Stream.runHead(
      get
        .stream(appLifecycleReadinessAtom)
        .pipe(Stream.filter(state => state.state === 'ready' || state.state === 'failed')),
    )
    yield* Stream.runDrain(
      get.stream(appEventsReadyAtom).pipe(
        Stream.filter(state => state === 'ready' || state === 'failed'),
        Stream.take(1),
      ),
    )
    const hydrated = yield* get.result(hydrateScanAtom)
    if (hydrated === 'failed') {
      yield* Stream.runDrain(
        get.stream(scanStateAtom).pipe(
          Stream.filter(state => state.hydrated),
          Stream.take(1),
        ),
      )
    } else if (hydrated === 'unscanned') yield* get.setResult(refreshScanAtom, undefined)
    yield* Effect.all(
      [
        get.setResult(loadCadenceAtom, undefined),
        get.setResult(loadCurrencyAtom, undefined),
        get.setResult(loadCurrencyOptionsAtom, undefined),
      ],
      { concurrency: 'unbounded' },
    )
    return yield* Effect.never
  })
})

/** The window root owns bootstrap and event subscriptions across React remounts. */
export function useAppBootstrap(): void {
  useEffect(() => {
    pinWindowAtom(registry, appBootstrapAtom)
  }, [])
}
