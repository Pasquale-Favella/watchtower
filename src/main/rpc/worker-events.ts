import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

import { activeCurrencySchema } from '../../shared/schemas/fx.js'
import { storeChangedMessageSchema } from '../../shared/schemas/ipc.js'
import { scanProgressSchema } from '../../shared/schemas/scan.js'
import type { DbWorkerEvent } from '../db-worker/protocol.js'
import type { LifecyclePublishEvent } from './lifecycle.js'

const invalidPayloadEventSchema = Schema.Literals(['scan:progress', 'store:changed', 'currency:changed', 'scan:error'])

export class WorkerLifecycleEventError extends Schema.TaggedError<WorkerLifecycleEventError>()(
  'WorkerLifecycleEventError',
  {
    code: Schema.Literal('invalid-payload'),
    event: invalidPayloadEventSchema,
  },
) {}

type LifecycleWorkerEventName = Schema.Schema.Type<typeof invalidPayloadEventSchema>

function decodePayload<S extends Schema.ConstraintDecoder<unknown>, A>(
  event: LifecycleWorkerEventName,
  schema: S,
  payload: unknown,
  map: (value: S['Type']) => A,
): Result.Result<A, WorkerLifecycleEventError> {
  const decoded = Schema.decodeUnknownResult(schema)(payload)
  if (Result.isFailure(decoded)) {
    return Result.fail(new WorkerLifecycleEventError({ code: 'invalid-payload', event }))
  }
  return Result.succeed(map(decoded.success))
}

/** Maps internal worker broadcasts to renderer-safe lifecycle inputs. */
export function lifecycleEventFromWorker(
  input: DbWorkerEvent,
): Result.Result<LifecyclePublishEvent | undefined, WorkerLifecycleEventError> {
  switch (input.event) {
    case 'scan:progress':
      return decodePayload('scan:progress', scanProgressSchema, input.progress, progress => ({
        _tag: 'ScanProgress',
        progress,
      }))
    case 'scan:error':
      return decodePayload('scan:error', Schema.String, input.message, message => ({ _tag: 'ScanError', message }))
    case 'scan:idle':
      return Result.succeed({ _tag: 'ScanIdle' })
    case 'store:changed':
      return decodePayload('store:changed', storeChangedMessageSchema, input.metadata, metadata => ({
        _tag: 'StoreChanged',
        metadata,
      }))
    case 'ledger:reset':
      return Result.succeed({ _tag: 'LedgerReset' })
    case 'config:changed':
      return Result.succeed({ _tag: 'ConfigChanged' })
    case 'currency:changed':
      return decodePayload('currency:changed', activeCurrencySchema, input.currency, currency => ({
        _tag: 'CurrencyChanged',
        currency,
      }))
    case 'ready':
    case 'init-error':
    case 'oplog':
      return Result.succeed(undefined)
  }
}
