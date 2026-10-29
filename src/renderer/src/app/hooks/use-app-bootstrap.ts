import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import { useEffect } from 'react'

import { appLifecycleReadinessAtom, appRpcLifecycleAtom } from '@/app/atoms/rpc-lifecycle'
import {
  hydrateScanProvidersAtom,
  refreshScanAtom,
  rehydrateScanAtom,
  type ScanHydrationState,
  scanStateAtom,
} from '@/app/atoms/scan'
import { registry, runtime } from '@/app/renderer-runtime'
import { navigationAtom } from '@/app/stores/subscribe'
import { coachDetection, mountCoachWorkflow } from '@/features/coach-skills/atoms'
import { loadCadenceAtom, loadCurrencyOptionsAtom, setCadenceAtom, setCurrencyAtom } from '@/features/settings/atoms'
import { mountSettingsCapabilityWorkflow } from '@/features/settings/capability-atoms'
import { preferencesAtom } from '@/features/settings/preferences-atoms'
import { ApplicationClient, ApplicationProtocolLayer } from '@/shared/lib/application-rpc'

import { pinWindowAtom } from './use-remote-query.js'

export function shouldStartInitialScan(hydration: ScanHydrationState, scanning: boolean): boolean {
  return hydration === 'unscanned' && !scanning
}

export function bootstrapInitialScan<R>(
  waitForNativeEvents: Effect.Effect<unknown, never, R>,
  hydrateScan: Effect.Effect<ScanHydrationState, unknown, R>,
  isScanning: () => boolean,
  startScan: () => Effect.Effect<unknown, unknown, R>,
): Effect.Effect<void, unknown, R> {
  return Effect.gen(function* () {
    yield* waitForNativeEvents
    const hydration = yield* hydrateScan
    if (shouldStartInitialScan(hydration, isScanning())) yield* startScan()
  })
}

export const appBootstrapAtom = runtime(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
).atom(get => {
  get.mount(hydrateScanProvidersAtom)
  get.mount(setCadenceAtom)
  get.mount(setCurrencyAtom)
  get.addFinalizer(mountCoachWorkflow(get.registry))
  get.addFinalizer(mountSettingsCapabilityWorkflow(get.registry))
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
  return Effect.gen(function* () {
    // Native application events establish readiness independently of navigation.
    yield* bootstrapInitialScan(
      Stream.runHead(get.stream(appLifecycleReadinessAtom).pipe(Stream.filter(state => state.state === 'ready'))),
      Effect.suspend(() => get.setResult(rehydrateScanAtom, undefined)),
      () => get.registry.get(scanStateAtom).scanning,
      () => get.setResult(refreshScanAtom, undefined),
    )
    yield* Effect.all([get.setResult(loadCadenceAtom, undefined), get.setResult(loadCurrencyOptionsAtom, undefined)], {
      concurrency: 'unbounded',
    })
    return yield* Effect.never
  })
})

/** The window root owns bootstrap and event subscriptions across React remounts. */
export function useAppBootstrap(): void {
  useEffect(() => {
    pinWindowAtom(registry, navigationAtom)
    pinWindowAtom(registry, appRpcLifecycleAtom)
    pinWindowAtom(registry, appBootstrapAtom)
  }, [])
}
