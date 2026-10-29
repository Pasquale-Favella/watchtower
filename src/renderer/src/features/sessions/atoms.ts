import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import type * as Atom from 'effect/reactivity/Atom'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

import { createRpcQuerySlot } from '@/app/atoms/rpc-query'
import { ApplicationClient } from '@/shared/lib/application-rpc'
import { keyOfScope } from '@/shared/lib/query-keys'
import { type SessionRequest, sessionRequestKey } from '@/shared/lib/query-keys'

import type { AnalyticsRpcError } from '../../../../shared/rpc/errors.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'
import type { SessionDetail, SessionRow } from '../../../../shared/schemas/views.js'

type SessionRowsQuery = (
  scope: OverviewScope,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<SessionRow[], AnalyticsRpcError | RpcClientError>>
type SessionDetailQuery = (
  request: SessionRequest,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<SessionDetail | null, AnalyticsRpcError | RpcClientError>>

const applicationSessionRowsQuery: SessionRowsQuery = (scope, selectionId) =>
  ApplicationClient.query(
    'sessions:view',
    { scope },
    { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
  )
const applicationSessionDetailQuery: SessionDetailQuery = (request, selectionId) =>
  ApplicationClient.query('store:session', request, {
    serializationKey: selectionId,
    reactivityKeys: ['ledger', 'pricing'],
  })

export function createSessionsAtoms(
  sessionRowsQuery: SessionRowsQuery = applicationSessionRowsQuery,
  sessionDetailQuery: SessionDetailQuery = applicationSessionDetailQuery,
) {
  return {
    sessionQuery: createRpcQuerySlot({
      key: sessionRequestKey,
      query: sessionDetailQuery,
    }),
    sessionRowsQuery: createRpcQuerySlot({
      key: keyOfScope,
      query: sessionRowsQuery,
    }),
  }
}

export const { sessionRowsQuery, sessionQuery } = createSessionsAtoms()
