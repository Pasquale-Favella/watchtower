import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as Stream from 'effect/Stream'

import { configInvalidationRevisionAtom } from '@/app/atoms/config-change'
import { restartRpcQuery } from '@/app/atoms/rpc-query'
import { scanStateAtom } from '@/app/atoms/scan'
import { currencyChangedAtom } from '@/features/settings/atoms'
import { parseEvent } from '@/shared/lib/contract-decoder'
import { RendererProtocolLayer } from '@/shared/lib/rpc-connection'

import type { PanelLifecycleEvent, PanelLifecycleFrame } from '../../../shared/rpc/lifecycle.js'
import { type OrbPlacement, orbPlacementSchema } from '../../../shared/schemas/orb.js'
import { registry, runtime } from '../app/renderer-runtime.js'
import { orbRecentQuery, orbTodayQuery } from './panel-atoms.js'
import { PanelRoleClient } from './panel-role-client.js'
import { placementAtom } from './placement-atoms.js'
import { type RoleConnectionReadiness, type RoleLifecycleCursor, runRoleLifecycle } from './role-lifecycle.js'

export const panelEventsReadyAtom = Atom.keepAlive(Atom.make<RoleConnectionReadiness>('inactive'))

function applyScanActivity(
  owner: AtomRegistry.AtomRegistry,
  activity: {
    scanning: boolean
    progress: null | { stage: 'pricing' | 'parse' | 'port-in'; provider?: string; processed?: number }
    error: string | null
  },
  hydrated?: boolean,
): void {
  const current = owner.get(scanStateAtom)
  const progress = activity.progress?.provider
    ? [
        {
          provider: activity.progress.provider,
          processed: activity.progress.processed ?? 0,
          done: activity.progress.stage === 'port-in',
        },
      ]
    : []
  owner.set(scanStateAtom, {
    ...current,
    ...(hydrated === undefined ? {} : { hydrated }),
    scanning: activity.scanning,
    scanError: activity.error,
    progress,
    stage: activity.progress?.stage ?? null,
  })
}

export interface PanelQueryReset {
  readonly reset: (owner: AtomRegistry.AtomRegistry) => void
}

const panelQueryReset: PanelQueryReset = {
  reset: owner => {
    restartRpcQuery(owner, orbTodayQuery)
    restartRpcQuery(owner, orbRecentQuery)
  },
}

export function applyPanelLifecycleFrame(
  frame: PanelLifecycleFrame,
  cursor: RoleLifecycleCursor,
  owner: AtomRegistry.AtomRegistry,
  queries: PanelQueryReset = panelQueryReset,
): Effect.Effect<boolean, never, Reactivity.Reactivity> {
  if (frame._tag === 'Snapshot') {
    const state = frame.state
    if (cursor.epoch === state.epoch && state.sequence < cursor.sequence) {
      owner.set(panelEventsReadyAtom, 'ready')
      return Effect.succeed(true)
    }
    const epochChanged = cursor.epoch !== undefined && cursor.epoch !== state.epoch
    const reset = epochChanged || (cursor.generation !== undefined && cursor.generation !== state.resetGeneration)
    if (reset) queries.reset(owner)
    cursor.epoch = state.epoch
    cursor.sequence = state.sequence
    cursor.generation = state.resetGeneration
    applyScanActivity(owner, state.scanActivity, state.hasScanned)
    owner.set(currencyChangedAtom, state.currency)
    const settled = reset ? Effect.void : Reactivity.invalidate(['ledger', 'pricing'])
    return settled.pipe(
      Effect.tap(() => Effect.sync(() => owner.set(panelEventsReadyAtom, 'ready'))),
      Effect.as(true),
    )
  }

  if (cursor.epoch === undefined || frame.envelope.epoch !== cursor.epoch) return Effect.succeed(false)
  if (frame.envelope.sequence <= cursor.sequence) return Effect.succeed(true)
  if (cursor.generation !== undefined && frame.envelope.ledgerGeneration < cursor.generation)
    return Effect.succeed(true)
  if (
    cursor.generation !== undefined &&
    frame.envelope.ledgerGeneration > cursor.generation &&
    frame.envelope.event._tag !== 'LedgerReset'
  )
    return Effect.succeed(false)
  cursor.sequence = frame.envelope.sequence
  const event: PanelLifecycleEvent = frame.envelope.event
  switch (event._tag) {
    case 'ScanProgress':
      applyScanActivity(owner, { scanning: true, progress: event.progress, error: null })
      return Effect.succeed(true)
    case 'ScanError':
      applyScanActivity(owner, { scanning: false, progress: null, error: event.message })
      return Effect.succeed(true)
    case 'ScanIdle':
      applyScanActivity(owner, { scanning: false, progress: null, error: null })
      return Effect.succeed(true)
    case 'LedgerChanged':
      applyScanActivity(owner, { scanning: false, progress: null, error: null }, true)
      return Reactivity.invalidate(['ledger', 'pricing']).pipe(Effect.as(true))
    case 'ConfigChanged':
      return Reactivity.invalidate(['pricing']).pipe(
        Effect.tap(() => Effect.sync(() => owner.set(configInvalidationRevisionAtom, frame.envelope.configRevision))),
        Effect.as(true),
      )
    case 'CurrencyChanged':
      owner.set(currencyChangedAtom, event.currency)
      return Effect.succeed(true)
    case 'LedgerReset':
      if (cursor.generation !== undefined && event.ledgerGeneration <= cursor.generation) return Effect.succeed(true)
      queries.reset(owner)
      cursor.generation = event.ledgerGeneration
      applyScanActivity(owner, { scanning: false, progress: null, error: null }, false)
      return Effect.succeed(true)
  }
}

const panelRuntime = runtime((get: Atom.AtomContext) =>
  Layer.merge(get(PanelRoleClient.runtime.layer), RendererProtocolLayer),
)
const panelLifecycleAtom = panelRuntime.atom(get =>
  runRoleLifecycle(get, {
    readinessAtom: panelEventsReadyAtom,
    events: () =>
      Effect.gen(function* () {
        const client = yield* PanelRoleClient
        return client('panel:events', undefined)
      }),
    apply: applyPanelLifecycleFrame,
  }),
)

const placementEventsAtom = runtime(Layer.empty).atom(get =>
  Stream.runForEach(
    Stream.callback<OrbPlacement>(
      Effect.fnUntraced(function* (queue) {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            window.api.orb.onPlacement(raw => {
              const decoded = parseEvent(orbPlacementSchema, 'orb placement', raw)
              if (decoded) Queue.offerUnsafe(queue, decoded)
            }),
          ),
          unsubscribe => Effect.sync(unsubscribe),
        )
      }),
      { bufferSize: 1, strategy: 'sliding' },
    ).pipe(Stream.mapEffect(placement => Effect.sync(() => get.registry.set(placementAtom, placement)))),
    () => Effect.void,
  ),
)

/** Mounts the role RPC stream and the narrow main-owned placement adapter. */
export function subscribeToOrbPanel(owner: AtomRegistry.AtomRegistry = registry): () => void {
  const stopLifecycle = owner.mount(panelLifecycleAtom)
  const stopPlacement = owner.mount(placementEventsAtom)
  let mounted = true
  return () => {
    if (!mounted) return
    mounted = false
    stopPlacement()
    stopLifecycle()
  }
}
