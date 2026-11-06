import * as Schema from 'effect/Schema'

import type { AgentDriverEvent } from '@/shared/schemas/execution.js'

const positiveInteger = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

export const deltaCoalescerConfigSchema = Schema.Struct({
  maxBufferedBytes: positiveInteger,
  maxBufferedAgeMs: positiveInteger,
  maxBufferedEvents: positiveInteger,
})
export type DeltaCoalescerConfig = Schema.Schema.Type<typeof deltaCoalescerConfigSchema>

/** 16 KiB bounds pending text, 50 ms bounds idle latency, and 256 events bounds tiny-delta bursts. */
export const defaultDeltaCoalescerConfig: DeltaCoalescerConfig = Object.freeze({
  maxBufferedBytes: 16 * 1024,
  maxBufferedAgeMs: 50,
  maxBufferedEvents: 256,
})

type DeltaEvent = Extract<AgentDriverEvent, { kind: 'textDelta' | 'reasoningDelta' }>

export interface DeltaCoalescerState {
  readonly config: DeltaCoalescerConfig
  readonly pending?: {
    readonly event: DeltaEvent
    readonly firstAt: number
    readonly events: number
  }
}

export interface DeltaCoalescerResult {
  readonly state: DeltaCoalescerState
  readonly flush: ReadonlyArray<AgentDriverEvent>
}

export function createDeltaCoalescer(config: Partial<DeltaCoalescerConfig> = {}): DeltaCoalescerState {
  return {
    config: Schema.decodeUnknownSync(deltaCoalescerConfigSchema)({ ...defaultDeltaCoalescerConfig, ...config }),
  }
}

/** Flush output must still be persisted, in order, before publication or dependent dispatch. */
export function drain(state: DeltaCoalescerState): DeltaCoalescerResult {
  return {
    state: { config: state.config },
    flush: state.pending ? [state.pending.event] : [],
  }
}

export function nextDeadline(state: DeltaCoalescerState): number | undefined {
  return state.pending ? state.pending.firstAt + state.config.maxBufferedAgeMs : undefined
}

/** The caller supplies finite monotonic milliseconds, using the same clock as offer. */
export function tick(state: DeltaCoalescerState, nowMs: number): DeltaCoalescerResult {
  return state.pending && nowMs - state.pending.firstAt >= state.config.maxBufferedAgeMs
    ? drain(state)
    : { state, flush: [] }
}

const encoder = new TextEncoder()

/** Only adjacent same-kind, same-item deltas wait; reaching the event limit flushes immediately. */
export function offer(previous: DeltaCoalescerState, event: AgentDriverEvent, nowMs: number): DeltaCoalescerResult {
  const aged = tick(previous, nowMs)
  const state = aged.state
  const { config, pending } = state
  if (
    (event.kind !== 'textDelta' && event.kind !== 'reasoningDelta') ||
    encoder.encode(event.text).byteLength > config.maxBufferedBytes ||
    config.maxBufferedEvents === 1
  ) {
    return { state: { config }, flush: [...aged.flush, ...drain(state).flush, event] }
  }
  if (pending?.event.kind === event.kind && pending.event.itemId === event.itemId) {
    const merged = { ...pending.event, text: pending.event.text + event.text }
    // Encode the concatenation: a surrogate pair may span native delta boundaries.
    if (encoder.encode(merged.text).byteLength <= config.maxBufferedBytes) {
      const events = pending.events + 1
      if (events >= config.maxBufferedEvents) {
        return { state: { config }, flush: [...aged.flush, merged] }
      }
      return { state: { ...state, pending: { ...pending, event: merged, events } }, flush: aged.flush }
    }
  }
  return {
    state: { config, pending: { event, firstAt: nowMs, events: 1 } },
    flush: [...aged.flush, ...drain(state).flush],
  }
}

const backlogBudgetSchema = Schema.Struct({
  pendingUnpersistedBytes: Schema.Number.check(
    Schema.isFinite(),
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  hardCapBytes: positiveInteger,
})

/**
 * Include all unpersisted payload bytes, including external queues; flushing is not persistence.
 * Check projected totals before enqueueing and await persistence when there is no room.
 */
export function backlogBudget(
  pendingUnpersistedBytes: number,
  hardCapBytes: number,
): { readonly remainingBytes: number; readonly shouldBackpressure: boolean } {
  Schema.decodeUnknownSync(backlogBudgetSchema)({ pendingUnpersistedBytes, hardCapBytes })
  return {
    remainingBytes: Math.max(0, hardCapBytes - pendingUnpersistedBytes),
    shouldBackpressure: pendingUnpersistedBytes >= hardCapBytes,
  }
}
