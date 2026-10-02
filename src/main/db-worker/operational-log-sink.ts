import { sanitizeOperationalRecord } from '../../shared/logging.js'
import type { OperationalLogSink } from '../operational-log.js'
import type { DbWorkerEvent } from './protocol.js'

/** Forward sanitized records to the main-owned writer over the existing channel. */
export function makeWorkerOperationalLogSink(emit: (event: DbWorkerEvent) => void): OperationalLogSink {
  return {
    emit(level, logEvent, fields) {
      const record = sanitizeOperationalRecord(logEvent, fields, 'worker')
      const safeFields: Record<string, string | number> = {}
      for (const [key, value] of Object.entries(record)) {
        if (key !== 'context' && key !== 'event' && (typeof value === 'string' || typeof value === 'number')) {
          safeFields[key] = value
        }
      }
      emit({ event: 'oplog', level, logEvent, fields: safeFields })
    },
  }
}
