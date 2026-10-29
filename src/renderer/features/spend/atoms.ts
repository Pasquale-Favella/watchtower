import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import type * as Atom from 'effect/reactivity/Atom'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query'
import { ApplicationClient } from '@/renderer/shared/lib/application-rpc'
import { keyOfScope } from '@/renderer/shared/lib/query-keys'

import type { AnalyticsRpcError } from '@/shared/rpc/errors.js'
import type { OverviewScope } from '@/shared/schemas/overview.js'
import type { SpendPayload } from '@/shared/schemas/spend.js'

type SpendQuery = (
  scope: OverviewScope,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<SpendPayload | null, AnalyticsRpcError | RpcClientError>>

const applicationSpendQuery: SpendQuery = (scope, selectionId) =>
  ApplicationClient.query(
    'spend:view',
    { scope },
    { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
  )

export function createSpendAtoms(query: SpendQuery = applicationSpendQuery) {
  return {
    spendQuery: createRpcQuerySlot({
      key: keyOfScope,
      query,
    }),
  }
}

export const { spendQuery } = createSpendAtoms()
