import * as Effect from 'effect/Effect'
import type { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Schema from 'effect/Schema'

import { WorkerRpcError, WorkerRpcGroup } from '@/shared/rpc/worker.js'
import type { WorkerRpcClient } from '@/platform/electron/workers/rpc-transport.js'

type Operation = {
  readonly tag: keyof WorkerRpcClient
  readonly payload: (args: unknown[]) => unknown
}

const noPayload = () => undefined
const scope = (args: unknown[]) => ({ scope: args[0] })
const model = (args: unknown[]) => ({ model: args[0] })

/** Local compatibility for main callers. Only the declared typed RPCs cross
 * the worker boundary; positional arguments never enter the transport. */
const operations: Readonly<Record<string, Operation>> = {
  'store:views': { tag: 'store:views', payload: noPayload },
  'store:projects': { tag: 'store:projects', payload: noPayload },
  'store:sessions': { tag: 'store:sessions', payload: args => ({ filter: args[0] }) },
  'store:session': {
    tag: 'store:session',
    payload: args => ({ sessionId: args[0], ...(args[1] === undefined ? {} : { sourceId: args[1] }) }),
  },
  'store:analytics': { tag: 'store:analytics', payload: noPayload },
  'overview:query': { tag: 'overview:query', payload: scope },
  'sessions:view': { tag: 'sessions:view', payload: scope },
  'pullRequests:view': { tag: 'pullRequests:view', payload: scope },
  'spend:view': { tag: 'spend:view', payload: scope },
  'models:view': { tag: 'models:view', payload: scope },
  'compare:view': { tag: 'compare:view', payload: args => ({ scope: args[0], pair: args[1] }) },
  'optimize:view': { tag: 'optimize:view', payload: scope },
  'optimize:yield': { tag: 'optimize:yield', payload: scope },
  'skills:view': { tag: 'skills:view', payload: args => ({ scope: args[0], thresholds: args[1] }) },
  'store:search': { tag: 'store:search', payload: args => ({ query: args[0] }) },
  'export:csv': { tag: 'export:csv', payload: args => ({ outputPath: args[0] }) },
  'export:json': { tag: 'export:json', payload: args => ({ outputPath: args[0] }) },
  'skills:dismiss': { tag: 'skills:dismiss', payload: args => args[0] },
  'models:addAlias': { tag: 'models:addAlias', payload: args => ({ model: args[0], aliasOf: args[1] }) },
  'models:getAliases': { tag: 'models:getAliases', payload: noPayload },
  'models:removeAlias': { tag: 'models:removeAlias', payload: model },
  'models:getPriceOverrides': { tag: 'models:getPriceOverrides', payload: noPayload },
  'models:removePriceOverride': { tag: 'models:removePriceOverride', payload: model },
  'models:setPrice': {
    tag: 'models:setPrice',
    payload: args => ({ model: args[0], inputPricePerMillion: args[1], outputPricePerMillion: args[2] }),
  },
  'ledger-mcp:startup:get': { tag: 'ledger-mcp:startup:get', payload: noPayload },
  'ledger-mcp:startup:set': { tag: 'ledger-mcp:startup:set', payload: args => ({ mode: args[0] }) },
  'scan:start': { tag: 'scan:start', payload: args => args[0] ?? {} },
  'scan:active': { tag: 'scan:active', payload: noPayload },
  'scan:abort': { tag: 'scan:abort', payload: noPayload },
  shutdown: { tag: 'worker:shutdown', payload: noPayload },
  'cadence:get': { tag: 'cadence:get', payload: noPayload },
  'cadence:set': { tag: 'cadence:set', payload: args => ({ value: args[0] }) },
  'store:status': { tag: 'store:status', payload: noPayload },
  'settings:info': { tag: 'settings:info', payload: noPayload },
  'settings:clear': { tag: 'settings:clear', payload: noPayload },
  'pricing:refresh': { tag: 'pricing:refresh', payload: noPayload },
  'currency:get': { tag: 'currency:get', payload: noPayload },
  'currency:set': { tag: 'currency:set', payload: args => ({ code: args[0] }) },
  'currency:list': { tag: 'currency:list', payload: noPayload },
}

export function workerOperation(
  client: WorkerRpcClient,
  operation: string,
  args: unknown[],
): Effect.Effect<unknown, WorkerRpcError | RpcClientError> {
  const entry = Object.hasOwn(operations, operation) ? operations[operation] : undefined
  const rpc = entry && WorkerRpcGroup.requests.get(entry.tag)
  const invalid = () =>
    new WorkerRpcError({ code: 'invalid-request', message: 'The database worker operation failed.' })
  if (!entry || !rpc) return Effect.fail(invalid())
  return Schema.decodeUnknownEffect(rpc.payloadSchema)(entry.payload(args)).pipe(
    Effect.mapError(invalid),
    // The tag selects both this payload codec and its generated client method.
    // TypeScript cannot correlate the two members of the closed RPC union.
    Effect.flatMap((payload): Effect.Effect<unknown, WorkerRpcError | RpcClientError> =>
      client[entry.tag](payload as never),
    ),
  )
}
