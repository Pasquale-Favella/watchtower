import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

import { createRpcQuerySlot } from '@/app/atoms/rpc-query'
import { ApplicationClient } from '@/shared/lib/application-rpc'

import type { AnalyticsRpcError } from '../../../../shared/rpc/errors.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'
import type { SearchHit } from '../../../../shared/schemas/views.js'

export interface PaletteSearchRequest {
  readonly query: string
  /** Search is global, but the full visible Scope fences results between views. */
  readonly scope: OverviewScope
}

const scopeKey = (scope: OverviewScope): string => JSON.stringify(scope)
export const paletteSearchKey = (request: PaletteSearchRequest): string =>
  JSON.stringify([request.query, scopeKey(request.scope)])

type SearchQuery = (
  request: PaletteSearchRequest,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<SearchHit[], AnalyticsRpcError | RpcClientError>>

const applicationSearchQuery: SearchQuery = (request, selectionId) =>
  ApplicationClient.query(
    'store:search',
    { query: request.query },
    { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
  )

export function createSearchAtoms(query: SearchQuery = applicationSearchQuery) {
  const searchTextAtom = Atom.keepAlive(Atom.make(''))
  const debouncedSearchTextAtom = Atom.debounce(searchTextAtom, 180)
  const searchSlot = createRpcQuerySlot({
    key: paletteSearchKey,
    query,
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

export const { searchTextAtom, debouncedSearchTextAtom, searchSlot, resetSearchAtom } = createSearchAtoms()
