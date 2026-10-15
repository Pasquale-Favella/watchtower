import * as Schema from 'effect/Schema'

const resumeCursorSchema = Schema.Struct({
  v: Schema.Literal(1),
  instanceId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
})

type ResumeCursor = Schema.Schema.Type<typeof resumeCursorSchema>

export function encodeResumeCursor(input: { instanceId: string; sessionId: string }): string {
  const cursor: ResumeCursor = { v: 1, instanceId: input.instanceId, sessionId: input.sessionId }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeResumeCursor(raw: unknown, instanceId: string): string | undefined {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) return undefined
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(resumeCursorSchema))(decoded)
    if (parsed._tag === 'Failure' || parsed.success.instanceId !== instanceId) return undefined
    return parsed.success.sessionId
  } catch {
    return undefined
  }
}
