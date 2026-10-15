import * as Schema from 'effect/Schema'

/** Stable cancellation signal shared by the scan owner and the plain parser. */
export class ScanAbortedError extends Schema.TaggedError<ScanAbortedError>()('ScanAbortedError', {
  message: Schema.String,
}) {}

export function abortedScanError(): ScanAbortedError {
  return new ScanAbortedError({ message: 'scan aborted' })
}

export function scanAbortError(signal: AbortSignal): ScanAbortedError {
  return signal.reason instanceof ScanAbortedError ? signal.reason : abortedScanError()
}

export function isScanAbortedError(error: unknown): error is ScanAbortedError {
  return (
    error instanceof ScanAbortedError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ScanAbortedError')
  )
}

/** Throws the scan's stable typed sentinel at a parser cancellation point. */
export function throwIfScanAborted(signal?: AbortSignal): void {
  // The parser is Promise-based; this tagged throw becomes its rejection and
  // is translated into the Effect error channel only at the scan boundary.
  // eslint-disable-next-line no-restricted-syntax
  if (signal?.aborted) throw scanAbortError(signal)
}
