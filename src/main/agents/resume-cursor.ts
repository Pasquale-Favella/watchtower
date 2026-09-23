import { z } from 'zod'

const resumeCursorSchema = z.object({
  v: z.literal(1),
  instanceId: z.string().min(1),
  sessionId: z.string().min(1),
})

type ResumeCursor = z.infer<typeof resumeCursorSchema>

export function encodeResumeCursor(input: { instanceId: string; sessionId: string }): string {
  const cursor: ResumeCursor = { v: 1, instanceId: input.instanceId, sessionId: input.sessionId }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeResumeCursor(raw: unknown, instanceId: string): string | undefined {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) return undefined
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = resumeCursorSchema.safeParse(JSON.parse(decoded))
    if (!parsed.success || parsed.data.instanceId !== instanceId) return undefined
    return parsed.data.sessionId
  } catch {
    return undefined
  }
}
