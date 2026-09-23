import { describe, expect, it } from 'vitest'

import { decodeResumeCursor, encodeResumeCursor } from '../src/main/agents/resume-cursor.js'

describe('opaque resume cursor', () => {
  it('round-trips an instance-bound session id', () => {
    const cursor = encodeResumeCursor({ instanceId: 'claude', sessionId: 'sess_1' })
    expect(decodeResumeCursor(cursor, 'claude')).toBe('sess_1')
  })

  it('rejects a cursor from another instance', () => {
    const cursor = encodeResumeCursor({ instanceId: 'claude', sessionId: 'sess_1' })
    expect(decodeResumeCursor(cursor, 'codex')).toBeUndefined()
  })

  it.each([undefined, null, 42, '', 'not-base64', 'eyJ2IjoyLCJpbnN0YW5jZUlkIjoiY2xhdWRlIiwic2Vzc2lvbklkIjoic2Vzc18xIn0'])('returns undefined for invalid input without throwing: %s', raw => {
    expect(() => decodeResumeCursor(raw, 'claude')).not.toThrow()
    expect(decodeResumeCursor(raw, 'claude')).toBeUndefined()
  })
})
