import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as Stream from 'effect/Stream'

import { runtime as rendererRuntime } from '@/app/renderer-runtime'
import { ApplicationClient, ApplicationProtocolLayer } from '@/shared/lib/application-rpc'
import { getPlatform } from '@/shared/lib/native-shell'

import type { StoreChangedMessage } from '../../../shared/schemas/ipc.js'
import type { SplashProviderProgress } from '../../../shared/schemas/renderer.js'
import { SCAN_STAGE_ORDER, type ScanMetadata, type ScanProgress, type ScanStage } from '../../../shared/schemas/scan.js'
import { configInvalidationRevisionAtom } from './config-change.js'

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

export type ScanHydrationState = 'pending' | 'scanned' | 'unscanned' | 'failed'

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

type ScanClient = typeof ApplicationClient

export function createScanAtoms(
  client: ScanClient = ApplicationClient,
  runtime: Atom.RegistryRuntimeFactory = rendererRuntime,
) {
  const scanHydrationStateAtom = Atom.keepAlive(Atom.make<ScanHydrationState>('pending'))
  const scanStateAtom = Atom.keepAlive(Atom.make(initialScanState()))
  const activityRevisionAtom = Atom.keepAlive(Atom.make(0))
  const changeRevisionAtom = Atom.keepAlive(Atom.make(0))
  const scanCommandBusyAtom = Atom.keepAlive(Atom.make(false))
  const providerHydrationRevisionAtom = Atom.keepAlive(Atom.make(0))
  const atomRuntime = runtime((get: Atom.AtomContext) =>
    Layer.merge(get(client.runtime.layer), ApplicationProtocolLayer),
  )
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

  const invalidateChanges = (get: Atom.FnContext | Atom.AtomContext, configChanged = false) =>
    Effect.gen(function* () {
      // Always invalidate committed ledger/config changes before fallible hydration.
      yield* Reactivity.invalidate(['ledger', 'pricing'])
      if (configChanged)
        get.registry.set(configInvalidationRevisionAtom, get.registry.get(configInvalidationRevisionAtom) + 1)
      get.registry.set(changeRevisionAtom, get.registry.get(changeRevisionAtom) + 1)
    })

  const applyMetadata = (
    get: Atom.FnContext | Atom.AtomContext,
    metadata: ScanMetadata | undefined,
    statusScanned?: boolean,
    activityRevisionAtStart?: number,
  ) =>
    Effect.gen(function* () {
      const revision = get.registry.get(changeRevisionAtom)
      const activityRevision = activityRevisionAtStart ?? get.registry.get(activityRevisionAtom)
      const api = yield* client
      const [status, platform] = yield* Effect.all([
        statusScanned === undefined
          ? Effect.result(api('store:status', undefined))
          : Effect.succeed({ _tag: 'Success' as const, success: { scanned: statusScanned } }),
        getPlatform,
      ])
      if (revision !== get.registry.get(changeRevisionAtom)) return
      const current = get.registry.get(scanStateAtom)
      const scanned = status._tag === 'Success' ? status.success.scanned : current.hydrated
      const statusMetadata =
        status._tag === 'Success' && 'metadata' in status.success ? status.success.metadata : undefined
      const resolvedMetadata = metadata ?? statusMetadata
      update(get, {
        hydrated: scanned || metadata !== undefined,
        unparsedTotal: resolvedMetadata?.perProvider.reduce((count, provider) => count + provider.unparsed, 0) ?? 0,
        scanError:
          status._tag === 'Failure'
            ? typeof status.failure.message === 'string'
              ? status.failure.message
              : 'Unable to read scan status.'
            : scanned
              ? null
              : current.scanError,
        fdaNeeded: needsFullDiskAccess(platform, resolvedMetadata),
        ...(activityRevision === get.registry.get(activityRevisionAtom) && status._tag === 'Success'
          ? { scanning: false, progress: [], stage: null }
          : {}),
        detectedProviders: current.detectedProviders,
      })
      get.registry.set(providerHydrationRevisionAtom, get.registry.get(providerHydrationRevisionAtom) + 1)
    })

  const applyStoreMetadataAtom = Atom.writable(
    get => get(scanStateAtom),
    (context, metadata: StoreChangedMessage) => {
      // StoreChanged carries validated metadata already. Apply it synchronously so
      // the lifecycle stream can move on to later frames while provider analytics
      // hydrates in the single root-owned, revision-coalescing worker.
      context.set(changeRevisionAtom, context.get(changeRevisionAtom) + 1)
      context.set(activityRevisionAtom, context.get(activityRevisionAtom) + 1)
      context.set(scanHydrationStateAtom, 'scanned')
      const current = context.get(scanStateAtom)
      const platform = typeof window === 'undefined' ? '' : (window.api?.platform ?? '')
      context.set(scanStateAtom, {
        ...current,
        hydrated: true,
        scanning: false,
        scanError: null,
        progress: [],
        stage: null,
        unparsedTotal: metadata.perProvider.reduce((count, provider) => count + provider.unparsed, 0),
        fdaNeeded: needsFullDiskAccess(platform, metadata),
      })
      context.set(providerHydrationRevisionAtom, context.get(providerHydrationRevisionAtom) + 1)
    },
  )
  const resetScanMetadataAtom = Atom.writable(
    get => get(scanStateAtom),
    context => {
      const current = context.get(scanStateAtom)
      context.set(changeRevisionAtom, context.get(changeRevisionAtom) + 1)
      context.set(activityRevisionAtom, context.get(activityRevisionAtom) + 1)
      context.set(providerHydrationRevisionAtom, context.get(providerHydrationRevisionAtom) + 1)
      context.set(scanHydrationStateAtom, 'pending')
      context.set(scanStateAtom, {
        ...current,
        hydrated: false,
        scanError: null,
        unparsedTotal: 0,
        detectedProviders: [],
        progress: [],
        stage: null,
        fdaNeeded: false,
      })
    },
  )
  const applyScanChangeAtom = client.runtime.fn<undefined>()((_, get) =>
    invalidateChanges(get).pipe(Effect.andThen(applyMetadata(get, undefined))),
  )
  const applyConfigChangeAtom = client.runtime.fn<undefined>()((_, get) => invalidateChanges(get, true))
  const syncActivity = (get: Atom.FnContext, revision = get.registry.get(activityRevisionAtom)) =>
    Effect.gen(function* () {
      const api = yield* client
      const activity = yield* Effect.result(api('scan:active', undefined))
      if (activity._tag === 'Failure') {
        if (revision === get.registry.get(activityRevisionAtom))
          update(get, {
            scanError:
              typeof activity.failure.message === 'string'
                ? activity.failure.message
                : 'Unable to determine whether a scan is active.',
          })
        return false
      }
      if (revision === get.registry.get(activityRevisionAtom))
        update(get, activity.success ? { scanning: true } : { scanning: false, progress: [], stage: null })
      return true
    })
  const syncActivityAtom = client.runtime.fn<undefined>()((_, get) => syncActivity(get))
  const refreshScanAtom = client.runtime.fn<undefined>()(
    (_, get) =>
      Effect.suspend(() => {
        if (get.registry.get(scanCommandBusyAtom)) return Effect.void
        get.registry.set(scanCommandBusyAtom, true)
        const admission = get.registry.getNodes().get(scanCommandBusyAtom)
        get.registry.set(activityRevisionAtom, get.registry.get(activityRevisionAtom) + 1)
        return Effect.gen(function* () {
          update(get, { scanError: null })
          const api = yield* client
          const result = yield* Effect.result(api('scan:start', {}))
          if (result._tag === 'Failure') {
            if (result.failure._tag === 'NativeRpcError') update(get, { scanError: 'Unable to start the scan.' })
            return
          }
          if (result.success.alreadyRunning) {
            update(get, { scanning: true })
            return
          }
          if (!result.success.ok && !result.success.aborted)
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

  const rehydrateScanAtom = client.runtime.fn<undefined>()(
    (_, get) =>
      Effect.gen(function* () {
        const revision = get.registry.get(changeRevisionAtom)
        const activityRevision = get.registry.get(activityRevisionAtom)
        const api = yield* client
        const status = yield* Effect.result(api('store:status', undefined))
        if (revision !== get.registry.get(changeRevisionAtom)) return 'failed' as const
        if (status._tag === 'Failure') {
          update(get, {
            scanError:
              typeof status.failure.message === 'string' ? status.failure.message : 'Unable to read scan status.',
          })
          get.registry.set(scanHydrationStateAtom, 'failed')
          return 'failed' as const
        }
        update(get, { hydrated: status.success.scanned })
        yield* applyMetadata(get, status.success.metadata, status.success.scanned, activityRevision)
        const activityConfirmed = yield* syncActivity(get, activityRevision)
        if (revision !== get.registry.get(changeRevisionAtom)) return get.registry.get(scanHydrationStateAtom)
        if (!activityConfirmed) {
          get.registry.set(scanHydrationStateAtom, 'failed')
          return 'failed' as const
        }
        get.registry.set(scanHydrationStateAtom, status.success.scanned ? 'scanned' : 'unscanned')
        return status.success.scanned ? ('scanned' as const) : ('unscanned' as const)
      }),
    { concurrent: true },
  )

  const hydrateScanProvidersAtom = Atom.keepAlive(
    atomRuntime.atom(get => {
      let completedRevision = 0
      const hydrateLatest = Effect.gen(function* () {
        while (completedRevision < get.registry.get(providerHydrationRevisionAtom)) {
          const requestedRevision = get.registry.get(providerHydrationRevisionAtom)
          const changeRevision = get.registry.get(changeRevisionAtom)
          const api = yield* client
          const analytics = yield* Effect.result(api('store:analytics', undefined))
          if (requestedRevision !== get.registry.get(providerHydrationRevisionAtom)) continue
          completedRevision = requestedRevision
          if (changeRevision !== get.registry.get(changeRevisionAtom)) continue
          const current = get.registry.get(scanStateAtom)
          if (analytics._tag === 'Success' && analytics.success) {
            update(get, {
              detectedProviders: analytics.success.providers.map(provider => provider.name),
            })
          } else {
            update(get, {
              detectedProviders: [],
              scanError:
                analytics._tag === 'Failure' && typeof analytics.failure.message === 'string'
                  ? analytics.failure.message
                  : current.scanError,
            })
          }
        }
      })
      return Stream.runForEach(get.stream(providerHydrationRevisionAtom), () => hydrateLatest)
    }),
  )

  return {
    scanStateAtom,
    scanHydrationStateAtom,
    scanProgressAtom,
    scanErrorAtom,
    scanIdleAtom,
    applyScanChangeAtom,
    applyConfigChangeAtom,
    applyStoreMetadataAtom,
    resetScanMetadataAtom,
    syncActivityAtom,
    refreshScanAtom,
    rehydrateScanAtom,
    hydrateScanProvidersAtom,
  }
}

export const {
  scanStateAtom,
  scanHydrationStateAtom,
  scanProgressAtom,
  scanErrorAtom,
  scanIdleAtom,
  applyScanChangeAtom,
  applyConfigChangeAtom,
  applyStoreMetadataAtom,
  resetScanMetadataAtom,
  syncActivityAtom,
  refreshScanAtom,
  rehydrateScanAtom,
  hydrateScanProvidersAtom,
} = createScanAtoms()
