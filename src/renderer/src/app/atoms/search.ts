import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'

import { RendererApi } from '@/shared/lib/renderer-api'

import { runtime } from '../renderer-runtime.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'
import { createRemoteQuerySlot } from './remote-query.js'

export interface PaletteSearchRequest {
  readonly query: string
  /** Search is global, but the full visible Scope fences results between views. */
  readonly scope: OverviewScope
}

const scopeKey = (scope: OverviewScope): string => JSON.stringify(scope)
export const paletteSearchKey = (request: PaletteSearchRequest): string =>
  JSON.stringify([request.query, scopeKey(request.scope)])

export function createSearchAtoms(factory: Atom.RegistryRuntimeFactory, layer = RendererApi.layer) {
  const remote = factory(layer)
  const searchTextAtom = Atom.keepAlive(Atom.make(''))
  const debouncedSearchTextAtom = Atom.debounce(searchTextAtom, 180)
  const searchSlot = createRemoteQuerySlot({
    runtime: remote,
    key: paletteSearchKey,
    fetch: request => Effect.flatMap(RendererApi, api => api.search(request.query)),
    reactivityKeys: ['ledger', 'pricing'],
  })

  const resetSearchAtom = Atom.writable(
    get => get(searchSlot.requestAtom),
    context => {
      context.set(searchTextAtom, '')
      context.set(searchSlot.resetAtom, undefined)
    },
  )

  return { searchTextAtom, debouncedSearchTextAtom, searchSlot, resetSearchAtom }
}

export const { searchTextAtom, debouncedSearchTextAtom, searchSlot, resetSearchAtom } = createSearchAtoms(runtime)
