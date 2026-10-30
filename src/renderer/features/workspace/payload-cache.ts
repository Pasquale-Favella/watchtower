/** Budgets count serialized UTF-8 JSON bytes and records, not JavaScript heap size. */
/** Largest JSON payload body the reader will reassemble and display. */
export const MAX_DISPLAY_PAYLOAD_BYTES = 8 * 1024 * 1024
/** Maximum combined serialized payload size retained for one Conversation. */
export const MAX_CACHED_PAYLOAD_BYTES = 16 * 1024 * 1024
/** Maximum number of full payload records retained for one Conversation. */
export const MAX_CACHED_PAYLOAD_ENTRIES = 16
/** Recent evicted-key markers retained for explicit reload affordances. */
export const MAX_RELEASED_PAYLOAD_MARKERS = 128

export interface PayloadCacheEntry<Value> {
  readonly value: Value
  readonly bytes: number
}

export interface PayloadCache<Value> {
  readonly entries: ReadonlyMap<string, PayloadCacheEntry<Value>>
  readonly releasedKeys: ReadonlySet<string>
  readonly bytes: number
}

export interface PayloadCacheLimits {
  readonly maxEntryBytes: number
  readonly maxBytes: number
  readonly maxEntries: number
}

export const DEFAULT_PAYLOAD_CACHE_LIMITS: PayloadCacheLimits = {
  maxEntryBytes: MAX_DISPLAY_PAYLOAD_BYTES,
  maxBytes: MAX_CACHED_PAYLOAD_BYTES,
  maxEntries: MAX_CACHED_PAYLOAD_ENTRIES,
}

export function payloadExceedsDisplayLimit(
  currentBytes: number,
  chunkBytes: number,
  advertisedCharacters: number,
  limitBytes = MAX_DISPLAY_PAYLOAD_BYTES,
): boolean {
  return advertisedCharacters > limitBytes || currentBytes + chunkBytes > limitBytes
}

function recordReleasedKey(keys: Set<string>, key: string): void {
  keys.delete(key)
  keys.add(key)
  while (keys.size > MAX_RELEASED_PAYLOAD_MARKERS) {
    const oldestKey = keys.values().next().value
    if (oldestKey === undefined) break
    keys.delete(oldestKey)
  }
}

export function createPayloadCache<Value>(): PayloadCache<Value> {
  return { entries: new Map(), releasedKeys: new Set(), bytes: 0 }
}

/** Insert as most-recently-used; retain release markers so evictions stay visible. */
export function rememberPayload<Value>(
  cache: PayloadCache<Value>,
  key: string,
  value: Value,
  bytes: number,
  protectedKey: string | null = key,
  limits: PayloadCacheLimits = DEFAULT_PAYLOAD_CACHE_LIMITS,
): PayloadCache<Value> {
  if (bytes > limits.maxEntryBytes) {
    if (cache.entries.has(key)) return cache
    const releasedKeys = new Set(cache.releasedKeys)
    recordReleasedKey(releasedKeys, key)
    return { ...cache, releasedKeys }
  }

  const entries = new Map(cache.entries)
  const releasedKeys = new Set(cache.releasedKeys)
  const prior = entries.get(key)
  let totalBytes = cache.bytes - (prior?.bytes ?? 0)
  entries.delete(key)
  entries.set(key, { value, bytes })
  releasedKeys.delete(key)
  totalBytes += bytes

  while (entries.size > limits.maxEntries || totalBytes > limits.maxBytes) {
    const oldestEvictable = [...entries.keys()].find(candidate => candidate !== protectedKey)
    if (oldestEvictable === undefined) {
      entries.delete(key)
      totalBytes -= bytes
      recordReleasedKey(releasedKeys, key)
      break
    }
    const evicted = entries.get(oldestEvictable)
    entries.delete(oldestEvictable)
    totalBytes -= evicted?.bytes ?? 0
    recordReleasedKey(releasedKeys, oldestEvictable)
  }
  return { entries, releasedKeys, bytes: totalBytes }
}

export function readPayload<Value>(cache: PayloadCache<Value>, key: string): Value | null {
  return cache.entries.get(key)?.value ?? null
}

export function wasPayloadReleased<Value>(cache: PayloadCache<Value>, key: string): boolean {
  return cache.releasedKeys.has(key)
}
