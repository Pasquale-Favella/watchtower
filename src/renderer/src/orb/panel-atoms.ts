import * as Effect from 'effect/Effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

import { createRemoteQuerySlot } from '@/app/atoms/remote-query'
import { keyOfScope } from '@/shared/lib/query-keys'
import { RendererApi } from '@/shared/lib/renderer-api'

import type { OverviewScope } from '../../../shared/schemas/overview.js'
import { runtime } from '../app/renderer-runtime.js'

/** The panel has no scope selector. Today is its headline; 30 days feed the
 * chart and week-over-week trend. */
export const ORB_SCOPES = {
  today: { period: 'today' },
  recent: { period: '30days' },
} as const satisfies Record<string, OverviewScope>

export function createPanelAtoms(factory: Atom.RegistryRuntimeFactory, layer = RendererApi.layer) {
  const remote = factory(layer)
  const fetchOverview = (scope: OverviewScope) => Effect.flatMap(RendererApi, api => api.getOverview(scope))

  const orbTodayQuery = createRemoteQuerySlot({
    runtime: remote,
    key: keyOfScope,
    fetch: fetchOverview,
    reactivityKeys: ['ledger', 'pricing'],
  })
  const orbRecentQuery = createRemoteQuerySlot({
    runtime: remote,
    key: keyOfScope,
    fetch: fetchOverview,
    reactivityKeys: ['ledger', 'pricing'],
  })

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

export const { orbTodayQuery, orbRecentQuery, loadOrbOverviewAtom, orbOverviewLoadedAtom } = createPanelAtoms(runtime)
