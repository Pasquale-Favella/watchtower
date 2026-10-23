import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as Stream from 'effect/Stream'

import { RendererApi } from '@/shared/lib/renderer-api'

import type { SplashProviderProgress } from '../../../../shared/schemas/renderer.js'
import {
  SCAN_STAGE_ORDER,
  type ScanMetadata,
  type ScanProgress,
  type ScanStage,
} from '../../../../shared/schemas/scan.js'
import { runtime } from '../renderer-runtime.js'
import { configInvalidationRevisionAtom } from './config-change.js'
import { eventConnectionAtom, retryRendererEventsAtom } from './event-connection.js'

export interface ScanState {
  readonly hydrated: boolean
  readonly scanning: boolean
  readonly scanError: string | null
  readonly unparsedTotal: number
  readonly detectedProviders: string[]
  readonly progress: SplashProviderProgress[]
  readonly stage: ScanStage | null
  readonly fdaNeeded: boolean
}

export function initialScanState(): ScanState {
  return {
    hydrated: false,
    scanning: false,
    scanError: null,
    unparsedTotal: 0,
    detectedProviders: [],
    progress: [],
    stage: null,
    fdaNeeded: false,
  }
}

export function foldScanProgress(state: ScanState, { stage, provider, processed = 0 }: ScanProgress): ScanState {
  const nextStage = !state.stage || SCAN_STAGE_ORDER[stage] >= SCAN_STAGE_ORDER[state.stage] ? stage : state.stage
  if (!provider) return { ...state, scanning: true, stage: nextStage }
  const entry = { provider, processed, done: stage === 'port-in' }
  const progress = state.progress.some(row => row.provider === provider)
    ? state.progress.map(row => (row.provider === provider ? entry : row))
    : [...state.progress, entry]
  return { ...state, progress, scanning: true, stage: nextStage }
}

function needsFullDiskAccess(platform: string, metadata?: ScanMetadata): boolean {
  return (
    platform === 'darwin' &&
    metadata !== undefined &&
    metadata.perProvider.length === 0 &&
    metadata.portedFiles + metadata.unchangedFiles + metadata.failedFiles === 0
  )
}

export function createScanAtoms(factory: Atom.RegistryRuntimeFactory, layer = RendererApi.layer) {
  const remote = factory(layer)
  const scanStateAtom = Atom.keepAlive(Atom.make(initialScanState()))
  const activityRevisionAtom = Atom.keepAlive(Atom.make(0))
  const changeRevisionAtom = Atom.keepAlive(Atom.make(0))
  const scanCommandBusyAtom = Atom.keepAlive(Atom.make(false))
  const update = (get: Atom.FnContext | Atom.AtomContext, patch: Partial<ScanState>): void => {
    const registry = get.registry
    registry.set(scanStateAtom, { ...registry.get(scanStateAtom), ...patch })
  }
  const lifecycle = <A>(fold: (state: ScanState, value: A) => ScanState) =>
    Atom.writable(
      get => get(scanStateAtom),
      (context, value: A) => {
        context.set(activityRevisionAtom, context.get(activityRevisionAtom) + 1)
        context.set(scanStateAtom, fold(context.get(scanStateAtom), value))
      },
    )
  const scanProgressAtom = lifecycle(foldScanProgress)
  const scanErrorAtom = lifecycle((state: ScanState, message: string) => ({
    ...state,
    scanning: false,
    scanError: message,
  }))
  const scanIdleAtom = lifecycle<undefined>((state: ScanState) => ({
    ...state,
    scanning: false,
    progress: [],
    stage: null,
  }))

  const applyChange = (get: Atom.FnContext | Atom.AtomContext, configChanged = false) =>
    Effect.gen(function* () {
      // A metadata failure must never suppress invalidation of committed ledger/config changes.
      yield* Reactivity.invalidate(['ledger', 'pricing'])
      if (configChanged)
        get.registry.set(configInvalidationRevisionAtom, get.registry.get(configInvalidationRevisionAtom) + 1)
      const changeRevision = get.registry.get(changeRevisionAtom) + 1
      get.registry.set(changeRevisionAtom, changeRevision)
      const api = yield* RendererApi
      const revision = get.registry.get(activityRevisionAtom)
      const status = yield* Effect.result(api.getScanStatus())
      if (changeRevision !== get.registry.get(changeRevisionAtom)) return
      const activity =
        !configChanged && revision === get.registry.get(activityRevisionAtom)
          ? { scanning: false, progress: [], stage: null }
          : {}
      if (status._tag === 'Failure') {
        update(get, { ...activity, scanError: status.failure.message })
        return
      }
      const platform = yield* api.getPlatform()
      const current = get.registry.get(scanStateAtom)
      update(get, {
        ...activity,
        hydrated: status.success.scanned,
        unparsedTotal:
          status.success.metadata?.perProvider.reduce((count, provider) => count + provider.unparsed, 0) ?? 0,
        scanError: status.success.scanned ? null : current.scanError,
        fdaNeeded: needsFullDiskAccess(platform, status.success.metadata),
      })
      const analytics = yield* Effect.result(api.getAnalytics())
      if (changeRevision !== get.registry.get(changeRevisionAtom)) return
      update(get, {
        detectedProviders:
          analytics._tag === 'Success' && analytics.success
            ? analytics.success.providers.map(provider => provider.name)
            : [],
      })
    })

  const syncActivity = (get: Atom.FnContext | Atom.AtomContext) =>
    Effect.gen(function* () {
      const revision = get.registry.get(activityRevisionAtom)
      const api = yield* RendererApi
      const active = yield* Effect.result(api.getScanActive())
      if (active._tag === 'Success' && active.success && revision === get.registry.get(activityRevisionAtom))
        update(get, { scanning: true })
    })

  const applyScanChangeAtom = remote.fn((_: undefined, get) => applyChange(get))
  const applyConfigChangeAtom = remote.fn((_: undefined, get) => applyChange(get, true))
  const syncScanActivityAtom = remote.fn((_: undefined, get) => syncActivity(get))
  const refreshScanAtom = remote.fn(
    (_: undefined, get) =>
      Effect.suspend(() => {
        if (get.registry.get(scanCommandBusyAtom)) return Effect.void
        get.registry.set(scanCommandBusyAtom, true)
        const admission = get.registry.getNodes().get(scanCommandBusyAtom)
        get.registry.set(activityRevisionAtom, get.registry.get(activityRevisionAtom) + 1)
        return Effect.gen(function* () {
          const connection = get.registry.get(eventConnectionAtom)
          if (connection === 'failed' || connection === 'pending') {
            if (connection === 'failed') get.registry.set(retryRendererEventsAtom, undefined)
            const settled = yield* Stream.runCollect(
              get.stream(eventConnectionAtom).pipe(
                Stream.filter(state => state === 'ready' || state === 'failed'),
                Stream.take(1),
              ),
            )
            if (settled[0] !== 'ready') return
          }
          update(get, { scanning: true, scanError: null })
          const api = yield* RendererApi
          const result = yield* Effect.result(api.scan())
          if (result._tag === 'Failure') update(get, { scanError: result.failure.message, scanning: false })
          else if (!result.success.ok && !result.success.aborted)
            update(get, {
              scanError: result.success.error ?? 'Scan failed. Check your provider sources and try again.',
              scanning: false,
            })
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (get.registry.getNodes().get(scanCommandBusyAtom) === admission)
                get.registry.set(scanCommandBusyAtom, false)
            }),
          ),
        )
      }),
    { concurrent: true },
  )

  // One hydration per registry, shared by StrictMode remounts and window bootstrap consumers.
  const hydrateScanAtom = Atom.keepAlive(
    remote.atom(get =>
      Effect.gen(function* () {
        const api = yield* RendererApi
        const status = yield* Effect.result(api.getScanStatus())
        if (status._tag === 'Failure') {
          update(get, { scanError: status.failure.message })
          return 'failed' as const
        }
        if (status.success.scanned) {
          update(get, { hydrated: true })
          yield* applyChange(get)
        }
        yield* syncActivity(get)
        return status.success.scanned ? ('scanned' as const) : ('unscanned' as const)
      }),
    ),
  )
  return {
    scanStateAtom,
    scanProgressAtom,
    scanErrorAtom,
    scanIdleAtom,
    applyScanChangeAtom,
    applyConfigChangeAtom,
    syncScanActivityAtom,
    refreshScanAtom,
    hydrateScanAtom,
  }
}

export const {
  scanStateAtom,
  scanProgressAtom,
  scanErrorAtom,
  scanIdleAtom,
  applyScanChangeAtom,
  applyConfigChangeAtom,
  syncScanActivityAtom,
  refreshScanAtom,
  hydrateScanAtom,
} = createScanAtoms(runtime)
