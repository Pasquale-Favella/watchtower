import * as Cause from 'effect/Cause'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/sql/SqlError'

import { WorkerRpcError } from '../../../shared/rpc/worker.js'
import { CurrencyCommandValidationError } from '../../../core/application/commands/currency-commands.js'
import { LedgerConfigValidationError } from '../../../core/application/commands/ledger-config-commands.js'
import { ScanAbortedError } from '../../../core/ingestion/reconciliation/scan-control.js'
import { UnsupportedLedgerSchemaVersion } from '../../../infrastructure/sqlite/ledger-initialization.js'

export type WorkerRpcFallbackCode = Extract<
  WorkerRpcError['code'],
  'query-failed' | 'command-failed' | 'initialization-failed' | 'unavailable'
>

const safeValidationMessages = new Set([
  'model and alias target must be non-empty strings',
  'model must be a non-empty string',
  'prices must be non-negative numbers',
  'invalid ISO 4217 currency code',
])

function classifyFailure(error: unknown): WorkerRpcError['code'] | undefined {
  if (error instanceof UnsupportedLedgerSchemaVersion) return 'unsupported-schema-version'
  if (Schema.isSchemaError(error)) return 'invalid-stored-data'
  if (error instanceof LedgerConfigValidationError || error instanceof CurrencyCommandValidationError) {
    return 'invalid-request'
  }
  if (error instanceof ScanAbortedError) return 'cancelled'

  if (SqlError.isSqlError(error)) {
    switch (error.reason._tag) {
      case 'ConnectionError':
        return 'database-unavailable'
      case 'AuthenticationError':
      case 'AuthorizationError':
        return 'database-access-denied'
      case 'SqlSyntaxError':
        return 'database-query-invalid'
      default:
        return 'database-operation-failed'
    }
  }

  if (error instanceof Error) {
    if (safeValidationMessages.has(error.message)) return 'invalid-request'
    if (error.message === 'scan aborted' || error.message === 'All fibers interrupted without error') return 'cancelled'
    if (error.message === 'db-worker is shutting down') return 'shutting-down'
  }
  return undefined
}

/**
 * Convert a worker failure into the deliberately small, safe RPC error
 * vocabulary. Error text, causes, SQL, paths and request values never cross
 * the worker boundary.
 */
export function workerRpcError(error: unknown, fallbackCode: WorkerRpcFallbackCode): WorkerRpcError {
  if (error instanceof WorkerRpcError) return error
  let code = classifyFailure(error)

  if (code === undefined && Cause.isCause(error)) {
    for (const reason of error.reasons) {
      if (Cause.isFailReason(reason)) {
        if (reason.error instanceof WorkerRpcError) return reason.error
        code = classifyFailure(reason.error)
        if (code !== undefined) break
      } else if (Cause.isInterruptReason(reason)) {
        code = 'cancelled'
        break
      }
    }
  }

  return new WorkerRpcError({
    code: code ?? fallbackCode,
    message: 'The database worker operation failed.',
  })
}
