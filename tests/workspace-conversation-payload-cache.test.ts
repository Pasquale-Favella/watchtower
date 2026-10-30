import { describe, expect, it } from 'vitest'

import {
  createPayloadCache,
  MAX_CACHED_PAYLOAD_BYTES,
  MAX_CACHED_PAYLOAD_ENTRIES,
  MAX_DISPLAY_PAYLOAD_BYTES,
  MAX_RELEASED_PAYLOAD_MARKERS,
  payloadExceedsDisplayLimit,
  readPayload,
  rememberPayload,
  wasPayloadReleased,
} from '../src/renderer/features/workspace/payload-cache.js'

const smallLimits = { maxEntryBytes: 8, maxBytes: 5, maxEntries: 2 }

describe('Conversation payload cache', () => {
  it('moves duplicate records to the newest LRU position and releases the oldest record', () => {
    let cache = createPayloadCache<string>()
    cache = rememberPayload(cache, 'a', 'first', 1, 'a', { ...smallLimits, maxBytes: 8 })
    cache = rememberPayload(cache, 'b', 'second', 1, 'b', { ...smallLimits, maxBytes: 8 })
    cache = rememberPayload(cache, 'a', 'updated', 2, 'a', { ...smallLimits, maxBytes: 8 })
    cache = rememberPayload(cache, 'c', 'third', 1, 'c', { ...smallLimits, maxBytes: 8 })

    expect(readPayload(cache, 'a')).toBe('updated')
    expect(readPayload(cache, 'b')).toBeNull()
    expect(readPayload(cache, 'c')).toBe('third')
    expect(wasPayloadReleased(cache, 'b')).toBe(true)
    expect(cache.entries.size).toBe(2)
  })

  it('enforces aggregate byte limits while protecting the active record', () => {
    let cache = createPayloadCache<string>()
    cache = rememberPayload(cache, 'active', 'kept', 4, 'active', smallLimits)
    cache = rememberPayload(cache, 'older', 'discarded', 1, 'active', smallLimits)
    cache = rememberPayload(cache, 'new', 'too much beside active', 2, 'active', smallLimits)

    expect(readPayload(cache, 'active')).toBe('kept')
    expect(readPayload(cache, 'older')).toBeNull()
    expect(readPayload(cache, 'new')).toBeNull()
    expect(wasPayloadReleased(cache, 'older')).toBe(true)
    expect(wasPayloadReleased(cache, 'new')).toBe(true)
    expect(cache.bytes).toBe(4)
  })

  it('rejects an individual body above its limit and marks it for explicit reload', () => {
    const limits = { maxEntryBytes: 4, maxBytes: 8, maxEntries: 2 }
    const cache = rememberPayload(createPayloadCache<string>(), 'large', 'too large', 5, 'large', limits)

    expect(readPayload(cache, 'large')).toBeNull()
    expect(wasPayloadReleased(cache, 'large')).toBe(true)
    expect(cache.bytes).toBe(0)
  })

  it('caps release markers while keeping recent evictions discoverable', () => {
    const limits = { maxEntryBytes: 2, maxBytes: 2, maxEntries: 1 }
    let cache = createPayloadCache<string>()
    for (let index = 0; index <= MAX_RELEASED_PAYLOAD_MARKERS + 1; index++) {
      cache = rememberPayload(cache, `payload-${index}`, 'x', 1, `payload-${index}`, limits)
    }

    expect(cache.releasedKeys.size).toBe(MAX_RELEASED_PAYLOAD_MARKERS)
    expect(wasPayloadReleased(cache, 'payload-0')).toBe(false)
    expect(wasPayloadReleased(cache, 'payload-1')).toBe(true)
    expect(wasPayloadReleased(cache, `payload-${MAX_RELEASED_PAYLOAD_MARKERS}`)).toBe(true)
  })

  it('checks both advertised payload size and accumulated chunk bytes before append', () => {
    expect(payloadExceedsDisplayLimit(7, 2, 9, 8)).toBe(true)
    expect(payloadExceedsDisplayLimit(0, 1, 9, 8)).toBe(true)
    expect(payloadExceedsDisplayLimit(7, 1, 8, 8)).toBe(false)
  })

  it('documents the production display and per-Conversation cache limits', () => {
    expect(MAX_DISPLAY_PAYLOAD_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_CACHED_PAYLOAD_BYTES).toBe(16 * 1024 * 1024)
    expect(MAX_CACHED_PAYLOAD_ENTRIES).toBe(16)
    expect(MAX_RELEASED_PAYLOAD_MARKERS).toBe(128)
  })
})
