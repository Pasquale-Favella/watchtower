import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import type * as Atom from 'effect/reactivity/Atom'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

import { createRpcQuerySlot } from '@/app/atoms/rpc-query'
import { ApplicationClient } from '@/shared/lib/application-rpc'
import { keyOfScope } from '@/shared/lib/query-keys'

import type { AnalyticsRpcError } from '../../../../shared/rpc/errors.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'
import type { PullRequestsPayload } from '../../../../shared/schemas/pull-requests.js'

type PullRequestsQuery = (
  scope: OverviewScope,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<PullRequestsPayload | null, AnalyticsRpcError | RpcClientError>>

const applicationPullRequestsQuery: PullRequestsQuery = (scope, selectionId) =>
  ApplicationClient.query(
    'pullRequests:view',
    { scope },
    { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
  )

export function createPullRequestsAtoms(query: PullRequestsQuery = applicationPullRequestsQuery) {
  return {
    pullRequestsQuery: createRpcQuerySlot({
      key: keyOfScope,
      query,
    }),
  }
}

export const { pullRequestsQuery } = createPullRequestsAtoms()
