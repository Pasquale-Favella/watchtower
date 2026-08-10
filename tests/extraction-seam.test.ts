import { describe, expect, it, vi } from 'vitest'
import { parsedProviderCallSchema } from '../src/shared/schemas/providers.js'
import { parseOrSkip } from '../src/shared/schemas/extract.js'

const validCall = {
  provider: 'demo',
  model: 'demo-model',
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 20,
  cachedInputTokens: 0,
  reasoningTokens: 5,
  webSearchRequests: 0,
  costUSD: 0.42,
  tools: ['Edit'],
  bashCommands: [],
  timestamp: '2026-07-01T09:00:00.000Z',
  speed: 'standard',
  deduplicationKey: 'call-1',
  userMessage: 'refactor auth',
  sessionId: 'sess-0',
}

describe('extraction seam under zod (ADR 0003: loose + skip-and-report)', () => {
  it('accepts a valid provider call; unknown extra keys are stripped, never fatal', () => {
    const parsed = parsedProviderCallSchema.parse({
      ...validCall,
      // A new provider version added columns this build does not know about:
      // loose schema must tolerate them and strip them from the result.
      newFieldFromNextVersion: 'hello',
      nested: { anything: true },
    })
    expect(parsed).toMatchObject({ provider: 'demo', model: 'demo-model', speed: 'standard' })
    expect(parsed).not.toHaveProperty('newFieldFromNextVersion')
  })

  it('a declared field failing its type is skipped and counted, never thrown', () => {
    const tally = { count: 0 }
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const bad = parseOrSkip(parsedProviderCallSchema, { ...validCall, costUSD: 'not-a-number' }, tally, 'demo session /x.jsonl')
    expect(bad).toBeNull()
    expect(tally.count).toBe(1)
    expect(stderr).toHaveBeenCalled()

    // A subsequent valid call still parses — one bad row never poisons the stream.
    const good = parseOrSkip(parsedProviderCallSchema, validCall, tally, 'demo session /x.jsonl')
    expect(good).not.toBeNull()
    expect(tally.count).toBe(1)

    stderr.mockRestore()
  })

  it('an invalid enum value (speed) is a declared-field failure, not an unknown-key case', () => {
    const tally = { count: 0 }
    const parsed = parseOrSkip(parsedProviderCallSchema, { ...validCall, speed: 'turbo' }, tally, 'demo session /x.jsonl')
    expect(parsed).toBeNull()
    expect(tally.count).toBe(1)
  })

  it('missing required fields fail loudly with a countable issue', () => {
    const tally = { count: 0 }
    const { userMessage, ...missing } = validCall
    const parsed = parseOrSkip(parsedProviderCallSchema, missing, tally, 'demo session /x.jsonl')
    expect(parsed).toBeNull()
    expect(tally.count).toBe(1)
    void userMessage
  })
})
