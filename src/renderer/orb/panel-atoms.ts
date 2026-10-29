import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type * as RpcClientError from 'effect/rpc/RpcClientError'

import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query'
import { keyOfScope } from '@/renderer/shared/lib/query-keys'

import type { AnalyticsRpcError } from '@/shared/rpc/errors.js'
import type { ScanResult } from '@/shared/schemas/ipc.js'
import type { OverviewPayload, OverviewScope } from '@/shared/schemas/overview.js'
import { scanStateAtom } from '@/renderer/stores/atoms/scan.js'
import { runtime } from '@/renderer/app/renderer-runtime.js'
import { PanelRoleClient } from '@/renderer/orb/panel-role-client.js'

/** The panel has no Scope selector: today is the headline and 30 days feed the trend. */
export const ORB_SCOPES = {
  today: { period: 'today' },
  recent: { period: '30days' },
} as const satisfies Record<string, OverviewScope>

export type PanelOverviewQuery = (
  scope: OverviewScope,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<OverviewPayload | null, AnalyticsRpcError | RpcClientError.RpcClientError>>

const panelOverviewQuery: PanelOverviewQuery = (scope, selectionId) =>
  PanelRoleClient.query(
    'overview:query',
    { scope },
    { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
  )

export function createPanelAtoms(
  factory: Atom.RegistryRuntimeFactory = runtime,
  query: PanelOverviewQuery = panelOverviewQuery,
) {
  const remote = factory(Layer.empty)
  const querySlot = (scope: OverviewScope) =>
    createRpcQuerySlot({ key: keyOfScope, query: (_request, selectionId) => query(scope, selectionId) })

  const orbTodayQuery = querySlot(ORB_SCOPES.today)
  const orbRecentQuery = querySlot(ORB_SCOPES.recent)

  const loadOrbOverviewAtom = remote.fn<undefined>()((_, get) =>
    Effect.gen(function* () {
      get.set(orbTodayQuery.requestAtom, ORB_SCOPES.today)
      get.set(orbRecentQuery.requestAtom, ORB_SCOPES.recent)
      yield* Effect.all([
        Effect.result(get.result(orbTodayQuery.resultAtom)),
        Effect.result(get.result(orbRecentQuery.resultAtom)),
      ])
    }),
  )

  const orbOverviewLoadedAtom = Atom.keepAlive(
    Atom.readable(get => {
      const today = get(orbTodayQuery.resultAtom)
      const recent = get(orbRecentQuery.resultAtom)
      return !AsyncResult.isInitial(today) && !AsyncResult.isInitial(recent)
    }),
  )

  return { orbTodayQuery, orbRecentQuery, loadOrbOverviewAtom, orbOverviewLoadedAtom }
}

export function createPanelScanCommandAtoms<Service, RuntimeError>(
  rpcRuntime: Atom.AtomRuntime<Service, RuntimeError>,
  startScan: (get: Atom.FnContext) => Effect.Effect<ScanResult, unknown, Service>,
) {
  const pendingAtom = Atom.keepAlive(Atom.make(false))
  const errorAtom = Atom.keepAlive(Atom.make<string | null>(null))
  const startScanAtom = rpcRuntime.fn<undefined>()(
    (_, get) =>
      Effect.suspend(() => {
        const registry = get.registry
        if (registry.get(pendingAtom) || registry.get(scanStateAtom).scanning) return Effect.succeed(undefined)
        registry.set(pendingAtom, true)
        registry.set(errorAtom, null)
        return Effect.gen(function* () {
          const result = yield* Effect.result(startScan(get))
          if (result._tag === 'Failure') {
            registry.set(errorAtom, 'Could not start a scan. Check the connection and try again.')
            return undefined
          }
          const scan = result.success
          if (!scan.ok && !scan.aborted && !scan.alreadyRunning)
            registry.set(errorAtom, scan.error ?? 'Scan could not be started. Try again.')
          return scan
        }).pipe(Effect.ensuring(Effect.sync(() => registry.set(pendingAtom, false))))
      }),
    { concurrent: true },
  )
  return { startScanAtom, pendingAtom, errorAtom }
}

export const { orbTodayQuery, orbRecentQuery, loadOrbOverviewAtom, orbOverviewLoadedAtom } = createPanelAtoms()

const startScanRpc = PanelRoleClient.mutation('scan:start')

export const {
  startScanAtom,
  pendingAtom: scanStartPendingAtom,
  errorAtom: scanStartErrorAtom,
} = createPanelScanCommandAtoms(PanelRoleClient.runtime, get => get.setResult(startScanRpc, { payload: {} }))
