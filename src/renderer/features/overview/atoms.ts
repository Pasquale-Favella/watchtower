import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import type * as Atom from 'effect/reactivity/Atom'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

import { createRpcQuerySlot } from '@/stores/atoms/rpc-query'
import { ApplicationClient } from '@/shared/lib/application-rpc'
import { keyOfScope } from '@/shared/lib/query-keys'

import type { AnalyticsRpcError } from '../../../shared/rpc/errors.js'
import type { OverviewPayload, OverviewScope } from '../../../shared/schemas/overview.js'

type OverviewQuery = (
  scope: OverviewScope,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<OverviewPayload | null, AnalyticsRpcError | RpcClientError>>

const applicationOverviewQuery: OverviewQuery = (scope, selectionId) =>
  ApplicationClient.query(
    'overview:query',
    { scope },
    { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
  )

export function createOverviewAtoms(query: OverviewQuery = applicationOverviewQuery) {
  return {
    overviewQuery: createRpcQuerySlot({
      key: keyOfScope,
      query,
    }),
  }
}

export const { overviewQuery } = createOverviewAtoms()
