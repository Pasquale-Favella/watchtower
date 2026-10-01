import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { z } from 'zod'

export type DecoderResult<T> = { ok: true; value: T } | { ok: false; path: string; message: string }

export type Decoder<T> = (input: unknown) => DecoderResult<T>

const unexpectedDecoderFailure: DecoderResult<never> = {
  ok: false,
  path: 'payload',
  message: 'could not be validated',
}

/**
 * Temporary adapter for contracts that still use their authoritative Zod schema.
 * Remove it after the last Zod-backed renderer fetch/event consumer migrates.
 */
export function zodDecoder<T>(schema: z.ZodType<T>): Decoder<T> {
  return function (input: unknown): DecoderResult<T> {
    try {
      const parsed = schema.safeParse(input)
      if (parsed.success) return { ok: true, value: parsed.data }
      const issue = parsed.error.issues[0]
      return {
        ok: false,
        path: issue?.path.length ? issue.path.join('.') : 'payload',
        message: issue?.message ?? 'does not match the expected shape',
      }
    } catch {
      return unexpectedDecoderFailure
    }
  }
}

/** Synchronous renderer adapter for an authoritative Effect Schema contract. */
export function effectSchemaDecoder<S extends Schema.ConstraintDecoder<unknown>>(schema: S): Decoder<S['Type']> {
  return function (input: unknown): DecoderResult<S['Type']> {
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
