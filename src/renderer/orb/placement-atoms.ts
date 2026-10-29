import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'

import type { OrbPanelRequest, OrbPlacement } from '../../shared/schemas/orb.js'
import { BeaconRoleClient } from './beacon-role-client.js'
import { PanelRoleClient } from './panel-role-client.js'

const initialPlacement: OrbPlacement = { expanded: false, peek: false, horizontal: 'right', vertical: 'bottom' }

export function createPlacementAtoms<R, E>(
  remote: Atom.AtomRuntime<R>,
  read: Effect.Effect<OrbPlacement | null, E, R>,
  requestPanel: (request: OrbPanelRequest) => Effect.Effect<OrbPlacement | null, E, R>,
) {
  const currentPlacementAtom = Atom.keepAlive(Atom.make(initialPlacement))
  const placementRevisionAtom = Atom.keepAlive(Atom.make(0))

  const placementAtom = Atom.writable(
    get => get(currentPlacementAtom),
    (context, placement: OrbPlacement) => {
      context.set(placementRevisionAtom, context.get(placementRevisionAtom) + 1)
      context.set(currentPlacementAtom, placement)
    },
  )

  const syncPlacementAtom = remote.fn<undefined>()((_, get) =>
    Effect.gen(function* () {
      const revision = get.registry.get(placementRevisionAtom)
      const placement = yield* read
      if (placement && revision === get.registry.get(placementRevisionAtom)) get.set(placementAtom, placement)
      return placement
    }),
  )

  const requestPlacementAtom = remote.fn<OrbPanelRequest>()((request, get) =>
    Effect.gen(function* () {
      const revision = get.registry.get(placementRevisionAtom)
      const placement = yield* requestPanel(request)
      if (placement && revision === get.registry.get(placementRevisionAtom)) get.set(placementAtom, placement)
      return placement
    }),
  )

  return { placementAtom, syncPlacementAtom, requestPlacementAtom }
}

const beaconPlacement = createPlacementAtoms(
  BeaconRoleClient.runtime,
  Effect.flatMap(BeaconRoleClient, rpc => rpc('orb:placement', undefined)),
  request => Effect.flatMap(BeaconRoleClient, rpc => rpc('orb:command', { _tag: 'Panel', request })),
)
const panelPlacement = createPlacementAtoms(
  PanelRoleClient.runtime,
  Effect.flatMap(PanelRoleClient, rpc => rpc('orb:placement', undefined)),
  request => Effect.flatMap(PanelRoleClient, rpc => rpc('orb:command', { _tag: 'Panel', request })),
)
export const { placementAtom, syncPlacementAtom, requestPlacementAtom } = globalThis.location?.pathname.endsWith(
  '/orb-panel.html',
)
  ? panelPlacement
  : beaconPlacement
