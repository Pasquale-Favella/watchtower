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

  it.each([
    ['unknown fields', { v: 1, instanceId: 'claude', sessionId: 'sess_1', extra: true }, 'sess_1'],
    ['Unicode session id', { v: 1, instanceId: 'claude', sessionId: 'session-東京' }, 'session-東京'],
    ['untrimmed session id', { v: 1, instanceId: 'claude', sessionId: ' ' }, ' '],
    ['missing version', { instanceId: 'claude', sessionId: 'sess_1' }, undefined],
    ['wrong version', { v: '1', instanceId: 'claude', sessionId: 'sess_1' }, undefined],
    ['missing instance', { v: 1, sessionId: 'sess_1' }, undefined],
    ['empty instance', { v: 1, instanceId: '', sessionId: 'sess_1' }, undefined],
    ['null instance', { v: 1, instanceId: null, sessionId: 'sess_1' }, undefined],
    ['missing session', { v: 1, instanceId: 'claude' }, undefined],
    ['empty session', { v: 1, instanceId: 'claude', sessionId: '' }, undefined],
    ['null session', { v: 1, instanceId: 'claude', sessionId: null }, undefined],
    ['numeric session', { v: 1, instanceId: 'claude', sessionId: 1 }, undefined],
    ['array cursor', [1, 'claude', 'sess_1'], undefined],
    ['null cursor', null, undefined],
  ])('preserves the cursor verdict for %s', (_name, payload, expected) => {
    const cursor = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    expect(decodeResumeCursor(cursor, 'claude')).toBe(expected)
  })

  it.each([
    undefined,
    null,
    42,
    '',
    'not-base64',
    'eyJ2IjoyLCJpbnN0YW5jZUlkIjoiY2xhdWRlIiwic2Vzc2lvbklkIjoic2Vzc18xIn0',
  ])('returns undefined for invalid input without throwing: %s', raw => {
    expect(() => decodeResumeCursor(raw, 'claude')).not.toThrow()
    expect(decodeResumeCursor(raw, 'claude')).toBeUndefined()
  })
})
