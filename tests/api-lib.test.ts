import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  fetchCadence,
  fetchPayload,
  fetchScanStatus,
  fetchSetCadence,
  fetchViews,
  parsePayload,
} from '../src/renderer/src/shared/lib/api.js'
import { zodDecoder } from '../src/renderer/src/shared/lib/schema-decoder.js'

const scanStatusSchema = z.object({ scanned: z.boolean() })

/** Stub the preload surface for the fetch wrappers' IPC-call sites. The
 * renderer-lib modules themselves never touch `window` at load time — only
 * inside the fetch wrappers — so a test-time global works without jsdom. */
function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

describe('renderer parse seam (ADR 0005)', () => {
  it('parsePayload passes a valid payload through untouched', () => {
    const result = parsePayload(zodDecoder(scanStatusSchema), 'scan status', { scanned: true })
    expect(result).toEqual({ ok: true, data: { scanned: true } })
  })

  it('parsePayload names the channel and failing field on a bad payload', () => {
    const result = parsePayload(zodDecoder(scanStatusSchema), 'scan status', { scanned: 'nope' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid scan status payload/)
      expect(result.error).toMatch(/scanned/)
    }
  })

  it('fetchPayload turns an IPC rejection into an error state, never a throw', async () => {
    const result = await fetchPayload('scan status', zodDecoder(scanStatusSchema), () =>
      Promise.reject(new Error('boom')),
    )
    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('fetchScanStatus trips on a schema-invalid window.api payload', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve({ scanned: 'yes' }) })
    const result = await fetchScanStatus()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid scan status payload/)
    }
  })

  it('fetchScanStatus passes a schema-valid payload through', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve({ scanned: true }) })
    const result = await fetchScanStatus()
    expect(result).toEqual({ ok: true, data: { scanned: true } })
  })

  it('fetchViews accepts a null payload (a valid nullable view)', async () => {
    mockWindow({ getViews: () => Promise.resolve(null) })
    const result = await fetchViews()
    expect(result).toEqual({ ok: true, data: null })
  })

  it('cadence get and set wrappers reject non-string IPC values', async () => {
    mockWindow({ getCadence: () => Promise.resolve(5), setCadence: () => Promise.resolve(null) })

    const getResult = await fetchCadence()
    const setResult = await fetchSetCadence('anything')

    expect(getResult).toEqual({
      ok: false,
      error: 'Invalid cadence payload (payload: has an unexpected type)',
    })
    expect(setResult).toEqual({
      ok: false,
      error: 'Invalid cadence payload (payload: has an unexpected type)',
    })
  })
})
