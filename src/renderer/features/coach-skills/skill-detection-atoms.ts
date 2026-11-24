import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import type * as Atom from 'effect/reactivity/Atom'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

import { ApplicationClient } from '@/renderer/shared/lib/application-rpc.js'
import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query.js'
import type { AnalyticsRpcError } from '@/shared/rpc/errors.js'
import type { OverviewScope } from '@/shared/schemas/overview.js'
import type { SkillsPayload } from '@/shared/schemas/skills.js'

export interface CoachDetectionRequest {
  readonly scope: OverviewScope
  readonly frequency: number
  readonly spread: number
}

export type CoachDetectionQuery = (
  request: CoachDetectionRequest,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<SkillsPayload | null, AnalyticsRpcError | RpcClientError>>

const applicationCoachDetectionQuery =
  (client: typeof ApplicationClient): CoachDetectionQuery =>
  (request, selectionId) =>
    client.query(
      'skills:view',
      { scope: request.scope, thresholds: { frequency: request.frequency, spread: request.spread } },
      { serializationKey: selectionId, reactivityKeys: ['ledger', 'pricing'] },
    )

export function createCoachDetectionSlot(
  client: typeof ApplicationClient = ApplicationClient,
  detectionQuery: CoachDetectionQuery = applicationCoachDetectionQuery(client),
) {
  return createRpcQuerySlot<CoachDetectionRequest, SkillsPayload | null, AnalyticsRpcError | RpcClientError>({
    key: request => `${JSON.stringify(request.scope)}:${request.frequency}:${request.spread}`,
    query: detectionQuery,
  })
}

export const coachSkillDetection = createCoachDetectionSlot()
