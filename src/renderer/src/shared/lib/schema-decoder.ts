import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; path: string; message: string }

const unexpectedDecoderFailure: DecodeResult<never> = {
  ok: false,
  path: 'payload',
  message: 'could not be validated',
}

/** Synchronously decodes a schema and reports only its first location and safe message. */
export function decodeSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): DecodeResult<S['Type']> {
  try {
    const result = Schema.decodeUnknownResult(schema)(input)
    if (result._tag === 'Success') return { ok: true, value: result.success }

    const first = firstIssue(result.failure.issue)
    return {
      ok: false,
      path: first.path.length ? first.path.map(formatPathPart).join('.') : 'payload',
      message: first.message,
    }
  } catch {
    return unexpectedDecoderFailure
  }
}

function firstIssue(issue: SchemaIssue.Issue): { path: ReadonlyArray<PropertyKey>; message: string } {
  switch (issue._tag) {
    case 'Pointer':
      return prependPath(issue.path, firstIssue(issue.issue))
    case 'Encoding':
      return firstIssue(issue.issue)
    case 'Filter':
      return firstIssue(issue.issue)
    case 'Composite':
    case 'AnyOf':
      return issue.issues.length
        ? firstIssue(issue.issues[0])
        : { path: [], message: 'does not match the expected shape' }
    case 'MissingKey':
      return { path: [], message: 'is missing' }
    case 'UnexpectedKey':
      return { path: [], message: 'has an unexpected field' }
    case 'InvalidType':
      return { path: [], message: 'has an unexpected type' }
    case 'InvalidValue':
      return { path: [], message: 'has an invalid value' }
    case 'Forbidden':
      return { path: [], message: 'is not allowed' }
    case 'OneOf':
      return { path: [], message: 'does not match the expected shape' }
  }
}

function prependPath(
  prefix: ReadonlyArray<PropertyKey>,
  issue: { path: ReadonlyArray<PropertyKey>; message: string },
): { path: ReadonlyArray<PropertyKey>; message: string } {
  return { ...issue, path: [...prefix, ...issue.path] }
}

function formatPathPart(part: PropertyKey): string {
  return typeof part === 'string' || typeof part === 'number' ? String(part) : '[key]'
}
