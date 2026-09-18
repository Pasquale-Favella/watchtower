export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogContext = 'main' | 'worker' | 'sidecar' | 'renderer'

const LOG_CONTEXTS = new Set<string>(['main', 'worker', 'sidecar', 'renderer'])
const ALLOWED_STRING_FIELDS = [
  'op',
  'code',
  'provider',
  'file',
  'method',
  'route',
  'kind',
  'label',
  'location',
  'model',
] as const
const ALLOWED_COUNT_FIELDS = ['count', 'ported', 'unparsed', 'failed'] as const

export function sanitizeOperationalRecord(
  event: string,
  fields: Record<string, unknown>,
  context: string,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    context: LOG_CONTEXTS.has(context) ? context : 'main',
    event,
  }
  for (const key of ALLOWED_STRING_FIELDS) {
    const value = fields[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    const safeValue = key === 'file' ? trimmed.split(/[\\/]/).pop() ?? '' : trimmed
    const capped = safeValue.slice(0, 200)
    if (capped) record[key] = capped
  }
  for (const key of ALLOWED_COUNT_FIELDS) {
    const value = fields[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) record[key] = value
  }
  return record
}

export function errorCodeFor(err: unknown, fallback = 'failed'): string {
  if (err instanceof Error && err.name && err.name !== 'Error') {
    const slug = err.name
      .replace(/Error$/, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
    if (slug) return slug
  }
  return fallback
}

export function errnoCodeFor(err: unknown, fallback = 'failed'): string {
  const errno = err && typeof err === 'object' && 'code' in err
    ? (err as { code?: unknown }).code
    : undefined
  if (typeof errno === 'string' && errno.trim()) return errno
  return errorCodeFor(err, fallback)
}