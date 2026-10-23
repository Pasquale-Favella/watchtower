import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'

import { RendererApi } from '@/shared/lib/renderer-api'

import type { OrbPanelRequest, OrbPlacement } from '../../../shared/schemas/orb.js'
import { runtime } from '../app/renderer-runtime.js'

const initialPlacement: OrbPlacement = { expanded: false, peek: false, horizontal: 'right', vertical: 'bottom' }

export function createPlacementAtoms(factory: Atom.RegistryRuntimeFactory, layer = RendererApi.layer) {
  const remote = factory(layer)
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
      const api = yield* RendererApi
      const placement = yield* api.getOrbPlacement()
      if (placement && revision === get.registry.get(placementRevisionAtom)) get.set(placementAtom, placement)
      return placement
    }),
  )

  const requestPlacementAtom = remote.fn<OrbPanelRequest>()((request, get) =>
    Effect.gen(function* () {
      const revision = get.registry.get(placementRevisionAtom)
      const api = yield* RendererApi
      const placement = yield* api.requestOrbPanel(request)
      if (placement && revision === get.registry.get(placementRevisionAtom)) get.set(placementAtom, placement)
      return placement
    }),
  )

  return { placementAtom, syncPlacementAtom, requestPlacementAtom }
}

export const { placementAtom, syncPlacementAtom, requestPlacementAtom } = createPlacementAtoms(runtime)
