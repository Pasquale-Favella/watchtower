import * as Schema from 'effect/Schema'

import { decodeSchema } from './schema-decoder.js'

export type ContractResult<A> = { ok: true; data: A } | { ok: false; error: string }

/** Decodes retained shell responses without exposing values from invalid payloads. */
export function parsePayload<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  label: string,
  raw: unknown,
): ContractResult<S['Type']> {
  const parsed = decodeSchema(schema, raw)
  if (parsed.ok) return { ok: true, data: parsed.value }
  return { ok: false, error: `Invalid ${label} payload (${parsed.path}: ${parsed.message})` }
}

/** Drops malformed shell events and records only the contract label and location. */
export function parseEvent<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  label: string,
  raw: unknown,
): S['Type'] | null {
  const parsed = decodeSchema(schema, raw)
  if (parsed.ok) return parsed.value
  try {
    const api = globalThis as typeof globalThis & {
      api?: { notifyNotice?: (label: string, location: string) => Promise<unknown> }
    }
    void api.api?.notifyNotice?.(label, parsed.path)?.catch(() => {})
  } catch {
    // Logging cannot prevent shell-event delivery.
  }
  return null
}
