import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  backlogBudget,
  createDeltaCoalescer,
  drain,
  nextDeadline,
  offer,
  tick,
} from '@/core/domain/execution/delta-coalescer.js'
import { type AgentDriverEvent, agentDriverEventSchema } from '@/shared/schemas/execution.js'

describe('execution delta coalescing policy', () => {
  it('merges consecutive text for an item without mutating earlier state', () => {
    const initial = createDeltaCoalescer()
    const first = offer(initial, { kind: 'textDelta', text: 'hello ', itemId: 'message' }, 10)
    const second = offer(first.state, { kind: 'textDelta', text: 'world', itemId: 'message' }, 20)
    expect(first.flush).toEqual([])
    expect(second.flush).toEqual([])
    expect(drain(second.state).flush).toEqual([{ kind: 'textDelta', text: 'hello world', itemId: 'message' }])
    expect(drain(first.state).flush).toEqual([{ kind: 'textDelta', text: 'hello ', itemId: 'message' }])
    expect(drain(initial).flush).toEqual([])
  })

  it('bounds UTF-8 bytes and emits an oversized delta intact after the pending text', () => {
    const initial = createDeltaCoalescer({ maxBufferedBytes: 5 })
    const first = offer(initial, { kind: 'textDelta', text: 'é' }, 0)
    const second = offer(first.state, { kind: 'textDelta', text: '猫' }, 1)
    expect(second.flush).toEqual([])
    const third = offer(second.state, { kind: 'textDelta', text: '🙂' }, 2)
    expect(third.flush).toEqual([{ kind: 'textDelta', text: 'é猫' }])
    const oversized = offer(third.state, { kind: 'textDelta', text: '🙂🙂' }, 3)
    expect(oversized.flush).toEqual([
      { kind: 'textDelta', text: '🙂' },
      { kind: 'textDelta', text: '🙂🙂' },
    ])
    expect(drain(oversized.state).flush).toEqual([])
  })

  it('flushes at the first-buffered deadline without postponing it on append', () => {
    const initial = createDeltaCoalescer({ maxBufferedAgeMs: 50 })
    expect(nextDeadline(initial)).toBeUndefined()
    const first = offer(initial, { kind: 'reasoningDelta', text: 'a' }, 100)
    const second = offer(first.state, { kind: 'reasoningDelta', text: 'b' }, 149)
    expect(nextDeadline(second.state)).toBe(150)
    expect(tick(second.state, 149).flush).toEqual([])
    expect(tick(second.state, 150).flush).toEqual([{ kind: 'reasoningDelta', text: 'ab' }])
    const expired = offer(second.state, { kind: 'reasoningDelta', text: 'c' }, 150)
    expect(expired.flush).toEqual([{ kind: 'reasoningDelta', text: 'ab' }])
    expect(nextDeadline(expired.state)).toBe(200)
    const drained = drain(expired.state)
    expect(drained.flush).toEqual([{ kind: 'reasoningDelta', text: 'c' }])
    expect(nextDeadline(drained.state)).toBeUndefined()
    expect(drain(drained.state).flush).toEqual([])
    expect(tick(initial, 1000).flush).toEqual([])
  })

  it('bounds buffered event count even when every delta has zero bytes', () => {
    const initial = createDeltaCoalescer({ maxBufferedEvents: 2 })
    const first = offer(initial, { kind: 'textDelta', text: '' }, 0)
    const second = offer(first.state, { kind: 'textDelta', text: '' }, 0)
    expect(first.flush).toEqual([])
    expect(second.flush).toEqual([{ kind: 'textDelta', text: '' }])
    expect(nextDeadline(second.state)).toBeUndefined()
    const single = offer(createDeltaCoalescer({ maxBufferedEvents: 1 }), { kind: 'reasoningDelta', text: 'a' }, 0)
    expect(single.flush).toEqual([{ kind: 'reasoningDelta', text: 'a' }])
    expect(drain(single.state).flush).toEqual([])
  })

  it('signals backpressure at or beyond an external unpersisted-byte budget', () => {
    expect(backlogBudget(4, 10)).toEqual({ remainingBytes: 6, shouldBackpressure: false })
    expect(backlogBudget(10, 10)).toEqual({ remainingBytes: 0, shouldBackpressure: true })
    expect(backlogBudget(15, 10)).toEqual({ remainingBytes: 0, shouldBackpressure: true })
    expect(() => backlogBudget(-1, 10)).toThrow()
    expect(() => backlogBudget(1, 0)).toThrow()
  })

  it.each(['textDelta', 'reasoningDelta'] as const)('merges %s with absent item IDs', kind => {
    const first = offer(createDeltaCoalescer(), { kind, text: 'one' }, 0)
    const second = offer(first.state, { kind, text: ' two' }, 1)
    expect(second.flush).toEqual([])
    const merged = drain(second.state).flush
    expect(merged).toEqual([{ kind, text: 'one two' }])
    expect(Schema.decodeUnknownSync(agentDriverEventSchema)(merged[0])).toEqual(merged[0])
  })

  it('flushes at every kind or item boundary without combining nonconsecutive items', () => {
    const input: ReadonlyArray<AgentDriverEvent> = [
      { kind: 'textDelta', text: 'a' },
      { kind: 'reasoningDelta', text: 'b' },
      { kind: 'reasoningDelta', text: 'c', itemId: 'item' },
      { kind: 'reasoningDelta', text: 'd', itemId: 'other' },
      { kind: 'textDelta', text: 'e', itemId: 'other' },
      { kind: 'textDelta', text: 'f' },
    ]
    let state = createDeltaCoalescer()
    for (const [index, event] of input.entries()) {
      const result = offer(state, event, index)
      expect(result.flush).toEqual(index === 0 ? [] : [input[index - 1]])
      state = result.state
    }
    expect(drain(state).flush).toEqual([{ kind: 'textDelta', text: 'f' }])
  })

  const criticalEvents: ReadonlyArray<AgentDriverEvent> = [
    { kind: 'turnStarted', nativeTurnId: 'turn' },
    { kind: 'turnCompleted', nativeTurnId: 'turn' },
    { kind: 'turnInterrupted' },
    { kind: 'turnFailed', message: 'failed' },
    { kind: 'toolStarted', toolCallId: 'tool', name: 'read', input: 'file' },
    { kind: 'toolUpdated', toolCallId: 'tool', output: 'data' },
    { kind: 'toolCompleted', toolCallId: 'tool', error: 'failure' },
    {
      kind: 'requestPending',
      request: { requestId: 'request', runId: 'run', generation: 1, kind: 'approval', prompt: '?', questions: [] },
    },
    { kind: 'requestResolved', requestId: 'request', decision: { kind: 'approve' } },
    { kind: 'usageReported', semantics: 'final', scope: 'run', inputTokens: 10 },
    { kind: 'nativeNotice', message: 'notice' },
  ].map(event => Schema.decodeUnknownSync(agentDriverEventSchema)(event))

  it.each(criticalEvents)('emits $kind immediately, after pending text, and never merges it', event => {
    const delta: AgentDriverEvent = { kind: 'textDelta', text: 'before', itemId: 'item' }
    const pending = offer(createDeltaCoalescer(), delta, 0)
    const result = offer(pending.state, event, 1)
    expect(result.flush).toEqual([delta, event])
    expect(result.flush[1]).toBe(event)
    expect(nextDeadline(result.state)).toBeUndefined()
    const repeated = offer(result.state, event, 2)
    expect(repeated.flush).toEqual([event])
    expect(drain(repeated.state).flush).toEqual([])
    expect(Schema.decodeUnknownSync(agentDriverEventSchema)(event)).toEqual(event)
  })

  it('measures the merged UTF-8 text accurately when a surrogate pair crosses delta boundaries', () => {
    const initial = createDeltaCoalescer({ maxBufferedBytes: 4 })
    const first = offer(initial, { kind: 'textDelta', text: '\ud83d' }, 0)
    const second = offer(first.state, { kind: 'textDelta', text: '\ude42' }, 1)
    expect(second.flush).toEqual([])
    expect(drain(second.state).flush).toEqual([{ kind: 'textDelta', text: '🙂' }])
  })

  it('emits a lone oversized delta without scheduling a deadline or splitting a code point', () => {
    const result = offer(createDeltaCoalescer({ maxBufferedBytes: 1 }), { kind: 'reasoningDelta', text: '猫🙂' }, 0)
    expect(result.flush).toEqual([{ kind: 'reasoningDelta', text: '猫🙂' }])
    expect(nextDeadline(result.state)).toBeUndefined()
  })

  it('preserves order when expiry coincides with a critical fact or an oversized delta', () => {
    const pending = offer(createDeltaCoalescer({ maxBufferedBytes: 2 }), { kind: 'textDelta', text: 'a' }, 0)
    expect(offer(pending.state, { kind: 'turnCompleted' }, 50).flush).toEqual([
      { kind: 'textDelta', text: 'a' },
      { kind: 'turnCompleted' },
    ])
    expect(offer(pending.state, { kind: 'textDelta', text: '猫' }, 50).flush).toEqual([
      { kind: 'textDelta', text: 'a' },
      { kind: 'textDelta', text: '猫' },
    ])
    const expired = tick(pending.state, 500)
    expect(expired.flush).toEqual([{ kind: 'textDelta', text: 'a' }])
    expect(nextDeadline(expired.state)).toBeUndefined()
  })

  it.each(['maxBufferedBytes', 'maxBufferedAgeMs', 'maxBufferedEvents'] as const)(
    'rejects invalid %s limits rather than silently disabling a bound',
    limit => {
      for (const invalid of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => createDeltaCoalescer({ [limit]: invalid })).toThrow()
      }
    },
  )

  it('preserves lossless per-item text, critical facts, and ordering across seeded randomized sequences', () => {
    let seed = 0x178
    const random = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % bound
    }
    const texts = ['', 'a', 'é', '猫', '🙂', '\ud83d', '\ude42', 'long text beyond small caps']
    const items = [undefined, '', 'one', 'two']
    const decode = Schema.decodeUnknownSync(agentDriverEventSchema)
    const summary = (events: ReadonlyArray<AgentDriverEvent>) => {
      const byItem = new Map<string, string>()
      const trace: unknown[] = []
      for (const event of events) {
        if (event.kind === 'textDelta' || event.kind === 'reasoningDelta') {
          const key = JSON.stringify([event.kind, event.itemId ?? null])
          byItem.set(key, (byItem.get(key) ?? '') + event.text)
          for (const codeUnit of event.text.split('')) trace.push([key, codeUnit])
        } else {
          trace.push(event)
        }
      }
      return { byItem, trace }
    }

    for (let sequence = 0; sequence < 100; sequence++) {
      const config = {
        maxBufferedBytes: 1 + random(64),
        maxBufferedAgeMs: 1 + random(50),
        maxBufferedEvents: 1 + random(8),
      }
      let state = createDeltaCoalescer(config)
      let nowMs = 0
      const input: AgentDriverEvent[] = []
      const output: AgentDriverEvent[] = []
      for (let index = 0; index < 200; index++) {
        nowMs += random(12)
        const event: AgentDriverEvent =
          random(5) === 0
            ? criticalEvents[random(criticalEvents.length)]
            : {
                kind: random(2) === 0 ? 'textDelta' : 'reasoningDelta',
                text: texts[random(texts.length)],
                itemId: items[random(items.length)],
              }
        input.push(event)
        const result = offer(state, event, nowMs)
        output.push(...result.flush)
        state = result.state
        if (random(4) === 0) {
          nowMs += random(60)
          const timed = tick(state, nowMs)
          output.push(...timed.flush)
          state = timed.state
        }
        if (random(20) === 0) {
          const drained = drain(state)
          output.push(...drained.flush)
          state = drained.state
        }
      }
      output.push(...drain(state).flush)
      expect(output.map(event => decode(event))).toEqual(output)
      expect(summary(output)).toEqual(summary(input))
    }
  })
})
