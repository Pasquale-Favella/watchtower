import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import type * as Atom from 'effect/reactivity/Atom'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query'
import { ApplicationClient } from '@/renderer/shared/lib/application-rpc'
import { keyOfScope } from '@/renderer/shared/lib/query-keys'

import type { AnalyticsRpcError } from '@/shared/rpc/errors.js'
import type { ModelsPayload } from '@/shared/schemas/models.js'
import type { OverviewScope } from '@/shared/schemas/overview.js'

type ModelsQuery = (
  scope: OverviewScope,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<ModelsPayload | null, AnalyticsRpcError | RpcClientError>>

const applicationModelsQuery: ModelsQuery = (scope, selectionId) =>
  ApplicationClient.query(
    'models:view',
    { scope },
    { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
  )

export function createModelsAtoms(query: ModelsQuery = applicationModelsQuery) {
  return {
    modelsQuery: createRpcQuerySlot({
      key: keyOfScope,
      query,
    }),
  }
}

export const { modelsQuery } = createModelsAtoms()
