import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type { RpcClientError } from 'effect/rpc/RpcClientError'

import { createRpcQuerySlot } from '@/app/atoms/rpc-query'
import { ApplicationClient } from '@/shared/lib/application-rpc'

import type { AnalyticsRpcError } from '../../../../shared/rpc/errors.js'
import type { ComparePair, ComparePayload } from '../../../../shared/schemas/compare.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'

export interface CompareRequest {
  readonly scope: OverviewScope
  readonly pair?: ComparePair
}

export function pairFromPayload(payload: ComparePayload | null): ComparePair | undefined {
  const report = payload?.report
  return report ? { modelA: report.modelA.model, modelB: report.modelB.model } : undefined
}

export const compareRequestKey = ({ scope, pair }: CompareRequest): string => JSON.stringify([scope, pair ?? null])
export const compareSelectionAtom = Atom.keepAlive(Atom.make<ComparePair | undefined>(undefined))

export type CompareQuery = (
  request: CompareRequest,
  selectionId: string,
) => Atom.Atom<AsyncResult.AsyncResult<ComparePayload | null, AnalyticsRpcError | RpcClientError>>

export function createCompareQuery<Services>(
  runtime: Atom.AtomRuntime<Services, never>,
  call: (
    scope: OverviewScope,
    pair: ComparePair | undefined,
  ) => Effect.Effect<ComparePayload | null, AnalyticsRpcError | RpcClientError, Services>,
): CompareQuery {
  return request =>
    runtime.factory.withReactivity(['ledger', 'pricing'])(
      runtime.atom<ComparePayload | null, AnalyticsRpcError | RpcClientError>(get =>
        Effect.gen(function* () {
          const previous = Option.flatMap(
            get.self<AsyncResult.AsyncResult<ComparePayload | null, AnalyticsRpcError | RpcClientError>>(),
            AsyncResult.value,
          )
          const pair = request.pair ?? pairFromPayload(Option.getOrNull(previous))
          return yield* call(request.scope, pair)
        }),
      ),
    )
}

const applicationCompareQuery = createCompareQuery(ApplicationClient.runtime, (scope, pair) =>
  Effect.flatMap(ApplicationClient, client => client('compare:view', pair === undefined ? { scope } : { scope, pair })),
)

export function createCompareAtoms(query: CompareQuery = applicationCompareQuery) {
  return {
    compareQuery: createRpcQuerySlot({
      key: compareRequestKey,
      query,
    }),
  }
}

export const { compareQuery } = createCompareAtoms()
