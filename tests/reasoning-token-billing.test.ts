import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { billableOutputTokens, OUTPUT_INCLUSIVE_REASONING_PROVIDERS } from '../src/main/pipeline/billable-output.js'
import { calculateCost } from '../src/main/pipeline/models.js'
import { cachedTurnToClassified } from '../src/main/pipeline/parser.js'
import { codex } from '../src/main/pipeline/providers/codex.js'
import { buildFixtureCachedCall } from './fixtures/cached-file.js'

// Reasoning is billed once, not twice (pricing-input correctness).
//
// The usage contracts split into two families. Anthropic and OpenAI report a
// reasoning count that is a BREAKDOWN of the output count — the reasoning
// tokens are already inside `outputTokens`/`completion_tokens` — so adding
// `reasoningTokens` on top bills them a second time. Gemini-shaped providers
// (`thoughtsTokenCount`, Hermes' `reasoning_tokens`, anything this app
// estimates from characters) report a genuinely separate counter, and the fold
// is correct there.
//
// `billableOutputTokens` is the single answer to that question, so the numbers
// below are hand-written expectations from the contracts, not values
// recomputed by the code under test.

describe('billableOutputTokens', () => {
  it('returns output alone for a provider whose output already includes reasoning', () => {
    // claude: Anthropic bills thinking as output.
    expect(billableOutputTokens('claude', 500, 200)).toBe(500)
    // codex + copilot: the OpenAI subset contract.
    expect(billableOutputTokens('codex', 246098, 115614)).toBe(246098)
    expect(billableOutputTokens('copilot', 300, 120)).toBe(300)
  })

  it('returns the sum for a provider whose reasoning sits outside its output', () => {
    // gemini, hermes, qwen, kiro, cursor-agent, droid, antigravity, mux,
    // open-design, lingtai-tui and the OpenCode-family stores all report a
    // separate counter, so the fold is what makes them whole.
    expect(billableOutputTokens('gemini', 100, 40)).toBe(140)
    expect(billableOutputTokens('hermes', 100, 40)).toBe(140)
    expect(billableOutputTokens('opencode', 100, 40)).toBe(140)
  })

  it('treats an unknown provider as output-exclusive, so no reported reasoning is dropped', () => {
    // A provider added later with no entry here keeps today's behavior rather
    // than silently losing its reasoning tokens from the bill.
    expect(billableOutputTokens('a-provider-that-does-not-exist-yet', 100, 40)).toBe(140)
  })

  it('is total over the non-finite and negative counts calculateCost already clamps', () => {
    // The helper adds no arithmetic of its own; calculateCost's per-operand
    // clamp (ADR 0010) is the single place negatives/NaN/Infinity price to 0.
    expect(billableOutputTokens('claude', -5, -5)).toBe(-5)
    expect(billableOutputTokens('gemini', Number.NaN, 1)).toBeNaN()
    expect(billableOutputTokens('gemini', 10, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    expect(calculateCost('gpt-5', 100, billableOutputTokens('gemini', -5, Number.NaN), 0, 0, 0)).toBeGreaterThanOrEqual(
      0,
    )
  })
})

describe('OUTPUT_INCLUSIVE_REASONING_PROVIDERS', () => {
  it('refuses runtime mutation so a later change cannot reprice history in place', () => {
    // `Object.freeze` alone does not seal a Set (its contents live in an
    // internal slot, not own properties), so the set overrides the mutators.
    // `ReadonlySet` blocks it at compile time; this proves it at runtime.
    expect(() => (OUTPUT_INCLUSIVE_REASONING_PROVIDERS as Set<string>).add('a-new-provider')).toThrow(TypeError)
    expect(() => (OUTPUT_INCLUSIVE_REASONING_PROVIDERS as Set<string>).delete('claude')).toThrow(TypeError)
    expect(() => (OUTPUT_INCLUSIVE_REASONING_PROVIDERS as Set<string>).clear()).toThrow(TypeError)
    expect(OUTPUT_INCLUSIVE_REASONING_PROVIDERS.has('claude')).toBe(true)
  })

  it('holds exactly the providers with a documented output-inclusive contract', () => {
    expect([...OUTPUT_INCLUSIVE_REASONING_PROVIDERS].sort()).toEqual(['claude', 'codex', 'copilot'])
  })
})

// The codex case below points the pricing engine's cache-dir seam at a temp
// directory, so it MUST be undone here: `resolveCacheDir()` falls back to
// `process.env['WATCHTOWER_CACHE_DIR']` on every pricing call, and an env var
// left set by one suite decides where a LATER suite in the same worker writes
// its cache. `tests/price-engine-seams.test.ts` and `tests/pricing-effect.test.ts`
// already clean up in an `afterEach`; this file did not, which meant the value
// survived into whatever ran next and made this suite's own ordering a factor
// in someone else's result.
afterEach(() => {
  delete process.env['WATCHTOWER_CACHE_DIR']
})

describe('codex through the real parser path', () => {
  it('bills the reported output alone instead of output + reasoning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-reasoning-codex-'))
    process.env['WATCHTOWER_CACHE_DIR'] = mkdtempSync(join(tmpdir(), 'tr-reasoning-cache-'))
    const filePath = join(dir, 'rollout-2026-07-20.jsonl')
    // A Codex rollout `token_count` event in the OpenAI shape: 30 output tokens
    // of which 10 are reasoning, so the two are nested, not additive.
    const lines = [
      {
        type: 'session_meta',
        timestamp: '2026-07-20T10:00:00.000Z',
        payload: { session_id: 'sess-reasoning', cwd: '/work/demo', model: 'gpt-5' },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-20T10:00:01.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship the widget' }] },
      },
      {
        type: 'event_msg',
        timestamp: '2026-07-20T10:00:02.000Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              total_tokens: 100,
              input_tokens: 60,
              cached_input_tokens: 0,
              output_tokens: 30,
              reasoning_output_tokens: 10,
            },
            last_token_usage: {
              input_tokens: 60,
              cached_input_tokens: 0,
              output_tokens: 30,
              reasoning_output_tokens: 10,
            },
          },
        },
      },
    ]
    writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'))

    const parser = codex.createSessionParser({ path: filePath, project: 'demo', provider: 'codex' }, new Set())
    const calls = []
    for await (const call of parser.parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    // Token extraction is untouched: both counters are reported as observed.
    expect(call.outputTokens).toBe(30)
    expect(call.reasoningTokens).toBe(10)

    // The billed output is 30, not 40. `gpt-5` prices output at 1e-5/token, so
    // the 10 double-counted tokens are the whole 0.0001 gap.
    const billed = billableOutputTokens('codex', call.outputTokens, call.reasoningTokens)
    expect(billed).toBe(30)
    expect(call.costUSD).toBeCloseTo(calculateCost('gpt-5', 60, 30, 0, 0, 0), 12)
    expect(call.costUSD).not.toBeCloseTo(calculateCost('gpt-5', 60, 40, 0, 0, 0), 12)

    // And the same answer survives the cache round-trip, where the parser
    // re-derives cost from the cached counters (the seam the old
    // `provider === 'claude'` ternary guarded).
    const turn = {
      timestamp: '2026-07-20T10:00:02.000Z',
      sessionId: 'sess-reasoning',
      userMessage: 'ship the widget',
      calls: [
        {
          ...buildFixtureCachedCall(0),
          provider: 'codex',
          model: 'gpt-5',
          costUSD: undefined,
          usage: {
            ...buildFixtureCachedCall(0).usage,
            inputTokens: 60,
            outputTokens: 30,
            reasoningTokens: 10,
            cacheReadInputTokens: 0,
          },
        },
      ],
    }
    const classified = cachedTurnToClassified(turn)
    const roundTripped = classified.assistantCalls[0]!
    expect(roundTripped.usage.outputTokens).toBe(30)
    expect(roundTripped.usage.reasoningTokens).toBe(10)
    expect(roundTripped.costUSD).toBeCloseTo(calculateCost('gpt-5', 60, 30, 0, 0, 0), 12)
    expect(roundTripped.costUSD).not.toBeCloseTo(calculateCost('gpt-5', 60, 40, 0, 0, 0), 12)
  })
})

describe('refactor regression: a non-set provider still gets the fold', () => {
  it('keeps summing reasoning for opencode, whose counters are separate', () => {
    const turn = {
      timestamp: '2026-07-01T09:00:00.000Z',
      sessionId: 'sess-0',
      userMessage: 'Refactor the auth module',
      // The shared fixture: opencode / demo-model, output 50 + reasoning 5.
      calls: [buildFixtureCachedCall(0)],
    }
    const classified = cachedTurnToClassified(turn)
    const call = classified.assistantCalls[0]!

    // The fixture pins a recorded costUSD, so the re-derivation is bypassed;
    // assert the fold itself, which is the contract the refactor had to keep.
    expect(billableOutputTokens('opencode', call.usage.outputTokens, call.usage.reasoningTokens)).toBe(55)
    expect(call.usage.outputTokens).toBe(50)
    expect(call.usage.reasoningTokens).toBe(5)
  })

  it('re-derives the same cost for a non-set provider whose cost was not recorded', () => {
    const base = buildFixtureCachedCall(0)
    const turn = {
      timestamp: '2026-07-01T09:00:00.000Z',
      sessionId: 'sess-0',
      userMessage: 'Refactor the auth module',
      calls: [{ ...base, costUSD: undefined }],
    }
    const call = cachedTurnToClassified(turn).assistantCalls[0]!
    // demo-model output 50 + reasoning 5 = 55 billed output tokens.
    expect(call.costUSD).toBeCloseTo(calculateCost('demo-model', 100, 55, 0, 20, 0), 12)
  })
})
