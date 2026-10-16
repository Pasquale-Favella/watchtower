import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { setModelAliases, setPriceOverrides } from '../src/main/pipeline/models.js'
import { createLingTaiTuiProvider } from '../src/main/pipeline/providers/lingtai-tui.js'
import { createMistralVibeProvider } from '../src/main/pipeline/providers/mistral-vibe.js'
import { createMuxProvider } from '../src/main/pipeline/providers/mux.js'
import { createOpenDesignProvider } from '../src/main/pipeline/providers/open-design.js'
import type {
  ParsedProviderCall,
  Provider,
  SessionParser,
  SessionSource,
} from '../src/main/pipeline/providers/types.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const tempDirs: string[] = []
const MODEL = 'project-captured-pricing-alias'
const FIRST_MODEL = 'project-captured-pricing-first'
const NEXT_MODEL = 'project-captured-pricing-next'

afterEach(() => {
  setModelAliases({})
  setPriceOverrides({})
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-project-pricing-'))
  tempDirs.push(dir)
  return dir
}

function configure(target = FIRST_MODEL): void {
  setModelAliases({ [MODEL]: target })
  setPriceOverrides({
    [FIRST_MODEL]: { input: 500_000, output: 500_000 },
    [NEXT_MODEL]: { input: 1_000_000, output: 1_000_000 },
  })
}

async function collect(parser: SessionParser): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

type Fixture = { provider: Provider; source: SessionSource }
type ProviderVariant = { name: string; create(root: string): Fixture }

const variants: ProviderVariant[] = [
  {
    name: 'LingTai token ledger',
    create(root) {
      const agentDir = join(root, 'lingtai-home', 'agent-one')
      const logsDir = join(agentDir, 'logs')
      mkdirSync(logsDir, { recursive: true })
      writeFileSync(join(agentDir, '.agent.json'), JSON.stringify({ agent_id: 'agent-one', llm: { model: MODEL } }))
      const path = join(logsDir, 'token_ledger.jsonl')
      writeFileSync(
        path,
        `${JSON.stringify({ source: 'main', em_id: 'em-1', run_id: 'run-1', ts: '2025-01-01T00:00:00Z', input: 10, output: 6, thinking: 2, cached: 2, model: MODEL })}\n`,
      )
      return {
        provider: createLingTaiTuiProvider({ lingtaiHomeOverride: join(root, 'lingtai-home') }),
        source: { path, project: 'agent-one', provider: 'lingtai-tui' },
      }
    },
  },
  {
    name: 'Mistral Vibe session directory',
    create(root) {
      const sessionDir = join(root, 'sessions', 'session-one')
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          session_id: 'session-one',
          start_time: '2025-01-01T00:00:00Z',
          stats: { session_prompt_tokens: 10, session_completion_tokens: 6 },
          config: { active_model: MODEL },
        }),
      )
      writeFileSync(
        join(sessionDir, 'messages.jsonl'),
        [
          JSON.stringify({ role: 'user', content: 'prompt text' }),
          JSON.stringify({ role: 'assistant', content: 'assistant response', message_id: 'assistant-one' }),
        ].join('\n'),
      )
      return {
        provider: createMistralVibeProvider(join(root, 'sessions')),
        source: { path: sessionDir, project: 'session-one', provider: 'mistral-vibe' },
      }
    },
  },
  {
    name: 'Mux chat log',
    create(root) {
      const path = join(root, 'sessions', 'workspace-one', 'chat.jsonl')
      mkdirSync(join(root, 'sessions', 'workspace-one'), { recursive: true })
      writeFileSync(
        path,
        [
          JSON.stringify({ role: 'user', parts: [{ type: 'text', text: 'prompt text' }] }),
          JSON.stringify({
            id: 'assistant-one',
            role: 'assistant',
            parts: [],
            metadata: {
              model: MODEL,
              timestamp: 1_735_689_600_000,
              usage: { inputTokens: 10, outputTokens: 6, reasoningTokens: 2, cachedInputTokens: 2 },
            },
          }),
        ].join('\n'),
      )
      return {
        provider: createMuxProvider(root),
        source: { path, project: 'workspace-one', provider: 'mux' },
      }
    },
  },
  {
    name: 'Open Design event log',
    create(root) {
      const path = join(root, 'namespace-one', 'data', 'runs', 'run-one', 'events.jsonl')
      mkdirSync(join(root, 'namespace-one', 'data', 'runs', 'run-one'), { recursive: true })
      writeFileSync(
        path,
        [
          JSON.stringify({ event: 'start', data: { model: MODEL } }),
          JSON.stringify({
            id: 'usage-one',
            event: 'agent',
            data: {
              type: 'usage',
              usage: { input_tokens: 10, output_tokens: 6, cached_read_tokens: 2, thought_tokens: 2 },
            },
            timestamp: '2025-01-01T00:00:00Z',
          }),
        ].join('\n'),
      )
      return {
        provider: createOpenDesignProvider(root),
        source: { path, project: 'namespace-one', provider: 'open-design' },
      }
    },
  },
]

describe('captured pricing for project/session providers', () => {
  it.each(variants)('$name keeps its captured price and refreshes on the next parser', async ({ create }) => {
    const { provider, source } = create(tempDir())
    configure()
    const firstParser = provider.createSessionParser(source, new Set())

    // The factory has captured pricing; this change happens before parser IO.
    configure(NEXT_MODEL)
    const first = await collect(firstParser)
    const next = await collect(provider.createSessionParser(source, new Set()))
    const firstCost = first[0]?.costUSD ?? 0
    const nextCost = next[0]?.costUSD ?? 0

    expect(first).toHaveLength(1)
    expect(next).toHaveLength(1)
    expect(firstCost).toBeGreaterThan(0)
    expect(nextCost).toBe(firstCost * 2)
  })

  it('all four parsers use the exact pricing capability from scan context', async () => {
    const calculateCost = vi.fn(() => 41)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const context = { pricing }
    const calls: ParsedProviderCall[][] = []

    for (const variant of variants) {
      const { provider, source } = variant.create(tempDir())
      calls.push(await collect(provider.createSessionParser(source, new Set(), undefined, context)))
    }

    expect(calls.map(result => result[0]?.costUSD)).toEqual([41, 41, 41, 41])
    expect(calculateCost).toHaveBeenCalledTimes(4)
  })

  it('keeps Mistral Vibe recorded session cost ahead of captured model pricing', async () => {
    const root = tempDir()
    const mistralVariant = variants.find(variant => variant.name === 'Mistral Vibe session directory')
    if (!mistralVariant) throw new Error('Missing Mistral Vibe fixture')
    const { provider, source } = mistralVariant.create(root)
    writeFileSync(
      join(source.path, 'meta.json'),
      JSON.stringify({
        session_id: 'session-one',
        stats: { session_prompt_tokens: 10, session_completion_tokens: 6, session_cost: 3.25 },
        config: { active_model: MODEL, models: [{ alias: MODEL, input_price: 100, output_price: 100 }] },
      }),
    )
    const calculateCost = vi.fn(() => 99)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const calls = await collect(provider.createSessionParser(source, new Set(), undefined, { pricing }))

    expect(calls.map(call => call.costUSD)).toEqual([3.25])
    expect(calculateCost).not.toHaveBeenCalled()
  })

  it('keeps Mistral Vibe configured model rates ahead of captured pricing', async () => {
    const root = tempDir()
    const mistralVariant = variants.find(variant => variant.name === 'Mistral Vibe session directory')
    if (!mistralVariant) throw new Error('Missing Mistral Vibe fixture')
    const { provider, source } = mistralVariant.create(root)
    writeFileSync(
      join(source.path, 'meta.json'),
      JSON.stringify({
        session_id: 'session-one',
        stats: { session_prompt_tokens: 10, session_completion_tokens: 6 },
        config: {
          active_model: MODEL,
          models: [{ alias: MODEL, input_price: 500_000, output_price: 1_000_000 }],
        },
      }),
    )
    const calculateCost = vi.fn(() => 99)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const calls = await collect(provider.createSessionParser(source, new Set(), undefined, { pricing }))

    expect(calls.map(call => call.costUSD)).toEqual([11])
    expect(calculateCost).not.toHaveBeenCalled()
  })
})
