import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import type * as Atom from 'effect/reactivity/Atom'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

import { createRpcQuerySlot } from '@/stores/atoms/rpc-query'
import { ApplicationClient } from '@/shared/lib/application-rpc'
import { keyOfScope } from '@/shared/lib/query-keys'

import type { AnalyticsRpcError } from '../../../shared/rpc/errors.js'
import type { OptimizePayload } from '../../../shared/schemas/optimize.js'
import type { OverviewScope } from '../../../shared/schemas/overview.js'
import type { YieldPayload } from '../../../shared/schemas/yield.js'

type OptimizeQuery = (
  scope: OverviewScope,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<OptimizePayload | null, AnalyticsRpcError | RpcClientError>>
type YieldQuery = (
  scope: OverviewScope,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<YieldPayload | null, AnalyticsRpcError | RpcClientError>>

const applicationOptimizeQuery: OptimizeQuery = (scope, selectionId) =>
  ApplicationClient.query(
    'optimize:view',
    { scope },
    { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
  )
const applicationYieldQuery: YieldQuery = (scope, selectionId) =>
  ApplicationClient.query(
    'optimize:yield',
    { scope },
    { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
  )

export function createOptimizeAtoms(
  optimizeQuery: OptimizeQuery = applicationOptimizeQuery,
  yieldQuery: YieldQuery = applicationYieldQuery,
) {
  return {
    optimizeQuery: createRpcQuerySlot({
      key: keyOfScope,
      query: optimizeQuery,
    }),
    yieldQuery: createRpcQuerySlot({
      key: keyOfScope,
      query: yieldQuery,
    }),
  }
}

export const { optimizeQuery, yieldQuery } = createOptimizeAtoms()
