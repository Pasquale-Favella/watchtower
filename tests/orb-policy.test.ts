import { describe, expect, it } from 'vitest'

import { containsPoint, createHeldRequest, createPeekGate, offsetAnchor } from '../src/main/orb-policy.js'

describe('orb geometry helpers', () => {
  it('offsets a drag anchor in whole DIPs', () => {
    expect(offsetAnchor({ x: 100, y: 200 }, 10.4, -20.6)).toEqual({ x: 110, y: 179 })
  })

  it('hit-tests a rect with exclusive right/bottom edges', () => {
    const rect = { x: 10, y: 20, width: 64, height: 64 }
    expect(containsPoint(rect, { x: 10, y: 20 })).toBe(true)
    expect(containsPoint(rect, { x: 73, y: 83 })).toBe(true)
    expect(containsPoint(rect, { x: 74, y: 50 })).toBe(false)
    expect(containsPoint(rect, { x: 50, y: 84 })).toBe(false)
    expect(containsPoint(rect, { x: 9, y: 50 })).toBe(false)
  })
})

describe('createHeldRequest — an open held until the orb shows', () => {
  it('returns a fresh held request once', () => {
    let now = 0
    const held = createHeldRequest<'open' | 'peek'>(3_000, () => now)
    held.hold('peek')
    now = 2_000
    expect(held.take()).toBe('peek')
    expect(held.take()).toBeNull()
  })

  it('drops a stale request instead of replaying it later', () => {
    let now = 0
    const held = createHeldRequest<'open'>(3_000, () => now)
    held.hold('open')
    now = 60_000
    expect(held.take()).toBeNull()
  })

  it('keeps only the latest request, and clear discards it', () => {
    const held = createHeldRequest<'open' | 'peek'>(3_000, () => 0)
    held.hold('peek')
    held.hold('open')
    expect(held.take()).toBe('open')
    held.hold('peek')
    held.clear()
    expect(held.take()).toBeNull()
  })
})

describe('createPeekGate — the first-close peek', () => {
  it('fires once both have happened, in either order', () => {
    const closeFirst = createPeekGate()
    expect(closeFirst.closed()).toBe(false)
    expect(closeFirst.dataReady()).toBe(true)

    const dataFirst = createPeekGate()
    expect(dataFirst.dataReady()).toBe(false)
    expect(dataFirst.closed()).toBe(true)
  })

  it('fires only once per session', () => {
    const gate = createPeekGate()
    gate.dataReady()
    expect(gate.closed()).toBe(true)
    expect(gate.closed()).toBe(false)
    expect(gate.dataReady()).toBe(false)
  })

  it('never fires without a close (data alone is not a reason to peek)', () => {
    const gate = createPeekGate()
    expect(gate.dataReady()).toBe(false)
    expect(gate.dataReady()).toBe(false)
  })
})
