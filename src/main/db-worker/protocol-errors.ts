import * as Cause from 'effect/Cause'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'

import { UnsupportedLedgerSchemaVersion } from '../store/ledger-initialization.js'

const SAFE_VALIDATION_MESSAGES = new Set([
  'model and alias target must be non-empty strings',
  'model must be a non-empty string',
  'prices must be non-negative numbers',
  'invalid ISO 4217 currency code',
  'scan aborted',
])

const UNKNOWN_FAILURE = 'The database operation failed.'

function typedFailureMessage(error: unknown): string | undefined {
  if (error instanceof UnsupportedLedgerSchemaVersion) {
    return 'The ledger database schema version is not supported.'
  }
  if (Schema.isSchemaError(error)) return 'Stored ledger data is invalid.'

  if (SqlError.isSqlError(error)) {
    switch (error.reason._tag) {
      case 'ConnectionError':
        return 'Unable to open the ledger database.'
      case 'AuthenticationError':
      case 'AuthorizationError':
        return 'Access to the ledger database was denied.'
      case 'SqlSyntaxError':
        return 'The ledger query is invalid.'
      default:
        return 'The ledger database operation failed.'
    }
  }

  return undefined
}

/**
 * Maps worker failures to short, non-sensitive protocol messages. Effect's
 * Promise runner normally rejects with the original typed error, but this
 * also handles an Exit Cause if a caller explicitly forwards one.
 */
export function workerProtocolError(error: unknown): string {
  const directTypedMessage = typedFailureMessage(error)
  if (directTypedMessage !== undefined) return directTypedMessage

  if (Cause.isCause(error)) {
    for (const reason of error.reasons) {
      if (Cause.isFailReason(reason)) {
        const typedMessage = typedFailureMessage(reason.error)
        if (typedMessage !== undefined) return typedMessage
        if (reason.error instanceof Error && SAFE_VALIDATION_MESSAGES.has(reason.error.message)) {
          return reason.error.message
        }
      }
      if (Cause.isDieReason(reason)) return 'An unexpected database worker failure occurred.'
      if (Cause.isInterruptReason(reason)) return 'The database operation was interrupted.'
    }
    return UNKNOWN_FAILURE
  }

  if (error instanceof Error) {
    if (SAFE_VALIDATION_MESSAGES.has(error.message)) return error.message
    if (error.message === 'db-worker is shutting down') return 'The database worker is shutting down.'
    if (error.message === 'All fibers interrupted without error') return 'The database operation was interrupted.'
  }

  return UNKNOWN_FAILURE
}
