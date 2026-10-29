import { Result } from 'effect'
import { describe, expect, it } from 'vitest'

import { v2RowsToLegacyShape } from '../src/infrastructure/provider-adapters/opencode-family-sqlite.js'
import {
  buildAssistantCallResult,
  decodeMessageJson,
  decodeMessageValue,
  decodePartJson,
  decodeV2ModelReferenceValue,
} from '../src/infrastructure/provider-adapters/session-message.js'

describe('OpenCode consumed message schemas', () => {
  it('retains the v2 nonnumeric cost omission before empty-call admission', () => {
    const { messages } = v2RowsToLegacyShape([
      {
        session_id: 'session-a',
        id: 'message-a',
        type: 'assistant',
        seq: 1,
        time_created: 1,
        data: JSON.stringify({ cost: 'unused-invalid-cost' }),
      },
    ])
    const data = messages[0]?.decodedData
    expect(data).toBeDefined()
    if (!data) throw new Error('v2 message was not decoded')
    expect(data.cost).toBeUndefined()
    const call = Result.getOrThrow(
      buildAssistantCallResult({
        providerName: 'opencode',
        dedupKey: 'message-a',
        sessionId: 'session-a',
        data,
        parts: [],
        timeCreatedMs: 1,
        userMessage: '',
        pricing: { calculateCost: () => 0, calculateLocalModelSavings: () => null },
      }),
    )
    expect(call).toBeNull()
  })
  it('uses the modelID alias first and ignores malformed unselected aliases and vendor siblings', () => {
    const decoded = decodeMessageJson(
      JSON.stringify({
        role: 'assistant',
        modelID: 'chosen-model',
        model: { vendor: 'unused malformed alias' },
        tokens: { input: 5 },
        vendorExtension: { future: true },
      }),
    )

    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) expect(decoded.success).toMatchObject({ role: 'assistant', modelID: 'chosen-model' })
  })

  it('rejects a malformed selected model and a malformed selected token counter', () => {
    expect(
      Result.isFailure(decodeMessageJson(JSON.stringify({ role: 'assistant', modelID: 4, model: 'fallback' }))),
    ).toBe(true)
    expect(
      Result.isFailure(
        decodeMessageJson(JSON.stringify({ role: 'assistant', tokens: { input: 'bad' }, usage: { input_tokens: 9 } })),
      ),
    ).toBe(true)
  })

  it('uses each usage fallback independently and preserves finite negative counters', () => {
    const decoded = decodeMessageJson(
      JSON.stringify({
        role: 'assistant',
        tokens: { input: -2, output: null, cache: { read: null } },
        usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      }),
    )

    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.tokens).toEqual({ input: -2, output: 8, reasoning: 0, cache: { read: 3, write: 4 } })
    }
  })

  it('strips unrelated part siblings while retaining nested tool input strings', () => {
    const malformed = decodePartJson(JSON.stringify({ type: 4, vendorOnly: true }))
    const valid = decodePartJson(
      JSON.stringify({
        type: 'tool',
        tool: 'bash',
        state: {
          input: {
            command: 'gh pr view',
            nested: { url: 'https://github.com/a/b/pull/1' },
            deep: { hidden: { x: 'ignored' } },
          },
        },
        vendorOnly: true,
      }),
    )

    expect(Result.isFailure(malformed)).toBe(true)
    expect(Result.isSuccess(valid)).toBe(true)
    if (Result.isSuccess(valid)) {
      expect(valid.success.state?.input).toEqual({
        command: 'gh pr view',
        nested: { url: 'https://github.com/a/b/pull/1' },
        deep: { hidden: { x: 'ignored' } },
      })
    }
  })

  it('validates the consumed OpenCode 2.x model reference and strips its vendor siblings', () => {
    const valid = decodeV2ModelReferenceValue({ id: 'model-a', providerID: 'openai', variant: 'thinking' })
    const malformed = decodeV2ModelReferenceValue({ id: 4, providerID: 'openai' })

    expect(Result.isSuccess(valid)).toBe(true)
    if (Result.isSuccess(valid)) expect(valid.success).toEqual({ id: 'model-a', providerID: 'openai' })
    expect(Result.isFailure(malformed)).toBe(true)
  })

  it('ignores an invalid recorded cost when calculated pricing is positive', () => {
    const decoded = decodeMessageJson(
      JSON.stringify({ role: 'assistant', modelID: 'model-a', cost: 'unused-invalid-cost', tokens: { input: 1 } }),
    )
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isFailure(decoded)) return

    const call = buildAssistantCallResult({
      providerName: 'opencode',
      dedupKey: 'session:message',
      sessionId: 'session',
      data: decoded.success,
      parts: [],
      timeCreatedMs: 1,
      userMessage: '',
      pricing: { calculateCost: () => 0.5, calculateLocalModelSavings: () => null },
    })

    expect(Result.isSuccess(call)).toBe(true)
    if (Result.isSuccess(call)) expect(call.success?.costUSD).toBe(0.5)
  })

  it('keeps an empty call when a malformed recorded cost made the old all-zero gate pass', () => {
    const decoded = decodeMessageJson(JSON.stringify({ role: 'assistant', cost: 'invalid-cost' }))
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isFailure(decoded)) return
    let pricingCalls = 0
    const call = buildAssistantCallResult({
      providerName: 'opencode',
      dedupKey: 'session:message',
      sessionId: 'session',
      data: decoded.success,
      parts: [],
      timeCreatedMs: 1,
      userMessage: '',
      pricing: {
        calculateCost: () => {
          pricingCalls++
          return 0
        },
        calculateLocalModelSavings: () => null,
      },
    })

    expect(Result.isSuccess(call) && call.success?.costUSD).toBe(0)
    expect(pricingCalls).toBe(1)
  })

  it('uses finite positive recorded cost only when calculated pricing is zero', () => {
    const decoded = decodeMessageJson(JSON.stringify({ role: 'assistant', modelID: 'model-a', cost: 0.25 }))
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isFailure(decoded)) return

    const call = buildAssistantCallResult({
      providerName: 'opencode',
      dedupKey: 'session:message',
      sessionId: 'session',
      data: decoded.success,
      parts: [],
      timeCreatedMs: 1,
      userMessage: '',
      pricing: { calculateCost: () => 0, calculateLocalModelSavings: () => null },
    })
    const nonFinite = decodeMessageValue({ role: 'assistant', modelID: 'model-a', cost: Number.POSITIVE_INFINITY })
    expect(Result.isSuccess(nonFinite)).toBe(true)
    if (Result.isSuccess(nonFinite)) {
      const invalidFallback = buildAssistantCallResult({
        providerName: 'opencode',
        dedupKey: 'session:message',
        sessionId: 'session',
        data: nonFinite.success,
        parts: [],
        timeCreatedMs: 1,
        userMessage: '',
        pricing: { calculateCost: () => 0, calculateLocalModelSavings: () => null },
      })
      expect(Result.isFailure(invalidFallback)).toBe(true)
    }

    expect(Result.isSuccess(call) && call.success?.costUSD).toBe(0.25)
  })
})
