import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  calculateCost,
  captureModelPricingCatalogue,
  captureScanPricing,
  setLocalModelSavings,
  setModelAliases,
  setPriceOverrides,
} from '../src/main/pipeline/models.js'
import { cachedTurnToClassified, groupIntoTurns, parseAdvisorCalls, parseApiCall } from '../src/main/pipeline/parser.js'
import { createScanPricing } from '../src/main/pipeline/scan-pricing.js'
import type { JournalEntry } from '../src/main/pipeline/types.js'
import { mapFileToLedgerRows } from '../src/main/store/port.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

const model = 'captured-claude-alias'
const baseline = 'captured-baseline'

afterEach(() => {
  setPriceOverrides({})
  setModelAliases({})
  setLocalModelSavings({})
})

function assistantEntry(rawModel = model): JournalEntry {
  return {
    type: 'assistant',
    timestamp: '2026-10-05T09:00:00.000Z',
    sessionId: 'captured-claude-session',
    message: {
      type: 'message',
      role: 'assistant',
      id: 'captured-message',
      model: rawModel,
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 20,
        speed: 'fast',
        cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 20 },
        iterations: [
          {
            type: 'advisor_message',
            model,
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 20,
            cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 20 },
          },
        ],
      },
    },
  }
}

describe('scan-owned pricing', () => {
  it('keeps Claude calls, advisors and turn grouping on the captured aliases, rates and savings mapping', () => {
    setPriceOverrides({ [baseline]: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 } })
    setModelAliases({ [model]: baseline })
    setLocalModelSavings({ 'captured-local-model': baseline })
    const expected = calculateCost(model, 100, 50, 30, 20, 0, 'fast', 10)
    const pricing = captureScanPricing()

    setPriceOverrides({ [baseline]: { input: 100, output: 200, cacheCreation: 300, cacheRead: 400 } })
    setModelAliases({ [model]: 'missing-after-capture' })
    setLocalModelSavings({})

    const entry = assistantEntry()
    expect(parseApiCall(entry, undefined, pricing)?.costUSD).toBe(expected)
    expect(parseAdvisorCalls(entry, pricing).map(call => call.costUSD)).toEqual([expected])
    const turns = groupIntoTurns([entry], new Set(), undefined, pricing)
    expect(turns.flatMap(turn => turn.assistantCalls).map(call => call.costUSD)).toEqual([expected, expected])
    expect(parseApiCall(assistantEntry('captured-local-model'), undefined, pricing)).toMatchObject({
      costUSD: 0,
      savingsUSD: expected,
      savingsBaselineModel: baseline,
      isLocalSavings: true,
    })
    const next = captureScanPricing()
    expect(next.calculateCost(model, 100, 50, 30, 20, 0, 'fast', 10)).toBe(0)
    expect(next.calculateLocalModelSavings('captured-local-model', 100, 50, 30, 20, 0)).toBeNull()
  })

  it('uses captured fallback costs during cache reconstruction and mapping while preserving recorded zero and positive costs', () => {
    setPriceOverrides({ [baseline]: { input: 1, output: 2, cacheRead: 3 } })
    setModelAliases({ [model]: baseline })
    const expected = calculateCost(model, 100, 50, 0, 20, 0)
    const pricing = captureScanPricing()
    setPriceOverrides({ [baseline]: { input: 100, output: 200, cacheRead: 300 } })
    const call = { ...buildFixtureCachedCall(0), provider: 'claude', model }
    const turn = buildFixtureCachedTurn(0, 'Captured cache pricing', {
      calls: [
        { ...call, costUSD: undefined },
        { ...call, costUSD: 0, deduplicationKey: 'saved-zero' },
        { ...call, costUSD: 42, deduplicationKey: 'saved-positive' },
      ],
    })
    expect(cachedTurnToClassified(turn, undefined, pricing).assistantCalls.map(row => row.costUSD)).toEqual([
      expected,
      0,
      42,
    ])
    expect(
      mapFileToLedgerRows(
        {
          provider: 'claude',
          envFingerprint: 'captured-pricing',
          filePath: 'captured.jsonl',
          verdict: 'new',
          cachedFile: buildFixtureCachedFile({ turns: [turn] }),
        },
        pricing,
      ).calls.map(row => row.baseCostUSD),
    ).toEqual([expected, 0, 42])
  })

  it('reports unpriced actual models and leaves unknown savings baselines absent', () => {
    const report = vi.fn()
    const pricing = createScanPricing(captureModelPricingCatalogue(), { local: 'missing-captured-baseline' }, report)
    expect(pricing.calculateCost('missing-captured-model', 1, 1, 0, 0, 0)).toBe(0)
    expect(report).toHaveBeenCalledExactlyOnceWith('missing-captured-model')
    expect(pricing.calculateLocalModelSavings('local', 1, 1, 0, 0, 0)).toBeNull()
    expect(report).toHaveBeenCalledTimes(1)
  })
})
