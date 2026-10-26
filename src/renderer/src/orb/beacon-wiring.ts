import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Stream from 'effect/Stream'

import { scanStateAtom } from '@/app/atoms/scan'
import { parseEvent } from '@/shared/lib/api'
import { RendererProtocolLayer } from '@/shared/lib/rpc-connection'

import type { BeaconLifecycleFrame } from '../../../shared/rpc/lifecycle.js'
import { type OrbPlacement, orbPlacementSchema } from '../../../shared/schemas/orb.js'
import { registry, runtime } from '../app/renderer-runtime.js'
import { BeaconRoleClient } from './beacon-role-client.js'
import { placementAtom } from './placement-atoms.js'
import { type RoleConnectionReadiness, type RoleLifecycleCursor, runRoleLifecycle } from './role-lifecycle.js'

export const beaconEventsReadyAtom = Atom.keepAlive(Atom.make<RoleConnectionReadiness>('inactive'))

function applyScanActivity(
  owner: AtomRegistry.AtomRegistry,
  activity: {
    scanning: boolean
    progress: null | { stage: 'pricing' | 'parse' | 'port-in'; provider?: string; processed?: number }
    error: string | null
  },
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
    scanning: activity.scanning,
    scanError: activity.error,
    progress,
    stage: activity.progress?.stage ?? null,
  })
}

export function applyBeaconLifecycleFrame(
  frame: BeaconLifecycleFrame,
  cursor: RoleLifecycleCursor,
  owner: AtomRegistry.AtomRegistry,
): Effect.Effect<boolean> {
  if (frame._tag === 'Snapshot') {
    if (cursor.epoch === frame.state.epoch && frame.state.sequence < cursor.sequence) {
      owner.set(beaconEventsReadyAtom, 'ready')
      return Effect.succeed(true)
    }
    cursor.epoch = frame.state.epoch
    cursor.sequence = frame.state.sequence
    applyScanActivity(owner, frame.state.scanActivity)
    owner.set(beaconEventsReadyAtom, 'ready')
    return Effect.succeed(true)
  }
  if (cursor.epoch === undefined || frame.envelope.epoch !== cursor.epoch) return Effect.succeed(false)
  if (frame.envelope.sequence <= cursor.sequence) return Effect.succeed(true)
  cursor.sequence = frame.envelope.sequence
  const event = frame.envelope.event
  switch (event._tag) {
    case 'ScanProgress':
      applyScanActivity(owner, { scanning: true, progress: event.progress, error: null })
      break
    case 'ScanError':
      applyScanActivity(owner, { scanning: false, progress: null, error: event.message })
      break
    case 'ScanIdle':
      applyScanActivity(owner, { scanning: false, progress: null, error: null })
      break
  }
  return Effect.succeed(true)
}

const beaconRuntime = runtime((get: Atom.AtomContext) =>
  Layer.merge(get(BeaconRoleClient.runtime.layer), RendererProtocolLayer),
)
const beaconLifecycleAtom = beaconRuntime.atom(get =>
  runRoleLifecycle(get, {
    readinessAtom: beaconEventsReadyAtom,
    events: () =>
      Effect.gen(function* () {
        const client = yield* BeaconRoleClient
        return client('beacon:events', undefined)
      }),
    apply: applyBeaconLifecycleFrame,
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

/** The beacon receives only lifecycle activity and its main-owned placement. */
export function subscribeToOrbBeacon(owner: AtomRegistry.AtomRegistry = registry): () => void {
  const stopLifecycle = owner.mount(beaconLifecycleAtom)
  const stopPlacement = owner.mount(placementEventsAtom)
  let mounted = true
  return () => {
    if (!mounted) return
    mounted = false
    stopPlacement()
    stopLifecycle()
  }
}
