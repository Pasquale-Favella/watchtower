/** Text for a copy action, or a read of it that may fail. */
export type CopySource = string | (() => Promise<string>)

/**
 * What "Copy delegated task result" copies. The list carries only a preview, so until the whole result is loaded a
 * copy reads it first. A failed read rejects, and the preview is never copied in its place.
 */
export function resultCopySource({
  fullResultText,
  hasRecordResult,
  fallbackText,
  loadFullResult,
}: {
  /** The whole result, once the record has loaded. */
  readonly fullResultText: string | null | undefined
  /** Whether the Delegation record holds a result, which the list then carries as a preview. */
  readonly hasRecordResult: boolean
  /** Text of a tool call with no Delegation record. */
  readonly fallbackText: string | null
  readonly loadFullResult: (() => Promise<string>) | undefined
}): CopySource | null {
  if (fullResultText != null) return fullResultText
  if (!hasRecordResult) return fallbackText
  return loadFullResult ?? (() => Promise.reject(new Error('The full result is not available.')))
}

/** Reads the whole result of a Delegation record, failing with a readable message when it cannot. */
export async function readFullResult(read: () => Promise<{ readonly resultText: string | null }>): Promise<string> {
  let record: { readonly resultText: string | null }
  try {
    record = await read()
  } catch (cause) {
    throw new Error(cause instanceof Error && cause.message ? cause.message : 'The full result could not be loaded.')
  }
  if (record.resultText === null) throw new Error('The delegated task has no result to copy.')
  return record.resultText
}
