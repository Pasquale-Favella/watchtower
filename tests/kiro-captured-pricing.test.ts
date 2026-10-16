import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { setModelAliases, setPriceOverrides } from '../src/main/pipeline/models.js'
import { createKiroProvider } from '../src/main/pipeline/providers/kiro.js'
import type { ParsedProviderCall, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const tempDirs: string[] = []
const MODEL = 'kiro-captured-pricing-alias'
const FIRST_MODEL = 'kiro-captured-pricing-first'
const NEXT_MODEL = 'kiro-captured-pricing-next'

afterEach(() => {
  setModelAliases({})
  setPriceOverrides({})
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-kiro-pricing-'))
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

type Variant = {
  name: string
  source(root: string): SessionSource
}

const variants: Variant[] = [
  {
    name: 'chat history files',
    source(root) {
      const path = join(root, 'chat.chat')
      writeFileSync(
        path,
        JSON.stringify({
          executionId: 'chat-execution',
          actionId: 'chat-action',
          chat: [
            { role: 'human', content: 'prompt text' },
            { role: 'bot', content: 'assistant response' },
          ],
          metadata: { modelId: MODEL, workflowId: 'chat-workflow', startTime: 1_750_000_000_000 },
        }),
      )
      return { path, project: 'project', provider: 'kiro' }
    },
  },
  {
    name: 'modern execution files',
    source(root) {
      const path = join(root, 'execution.json')
      writeFileSync(
        path,
        JSON.stringify({
          executionId: 'modern-execution',
          sessionId: 'modern-session',
          modelId: MODEL,
          startTime: 1_750_000_000_000,
          prompt: 'prompt text',
          response: 'assistant response',
        }),
      )
      return { path, project: 'project', provider: 'kiro' }
    },
  },
  {
    name: 'CLI JSONL sessions',
    source(root) {
      const path = join(root, 'session.jsonl')
      writeFileSync(
        path,
        [
          JSON.stringify({ kind: 'Prompt', data: { content: [{ kind: 'text', data: 'prompt text' }] } }),
          JSON.stringify({
            kind: 'AssistantMessage',
            data: { content: [{ kind: 'text', data: 'assistant response' }] },
          }),
        ].join('\n'),
      )
      writeFileSync(
        join(root, 'session.json'),
        JSON.stringify({
          session_id: 'cli-session',
          cwd: root,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          session_state: {
            rts_model_state: { model_info: { model_id: MODEL } },
            conversation_metadata: {
              user_turn_metadatas: [{ end_timestamp: '2025-01-01T00:00:00Z' }],
            },
          },
        }),
      )
      return { path, project: 'project', provider: 'kiro' }
    },
  },
  {
    name: 'workspace session files',
    source(root) {
      const path = join(root, 'workspace-session.json')
      writeFileSync(
        path,
        JSON.stringify({
          sessionId: 'workspace-session',
          selectedModel: MODEL,
          history: [
            { message: { role: 'user', content: 'prompt text' } },
            { message: { role: 'assistant', content: 'assistant response' } },
          ],
        }),
      )
      return { path, project: 'project', provider: 'kiro' }
    },
  },
  {
    name: 'v2 event logs',
    source(root) {
      const sessionDir = join(root, 'sess_v2')
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ id: 'v2-session', modelId: MODEL }))
      const path = join(sessionDir, 'messages.jsonl')
      const stamp = '2025-01-01T00:00:00.000Z'
      const entries = [
        { type: 'user', content: 'prompt text' },
        { type: 'turn_start', executionId: 'v2-execution' },
        { type: 'assistant', content: 'assistant response' },
        { type: 'turn_end' },
      ].map(payload => JSON.stringify({ timestamp: stamp, payload }))
      writeFileSync(path, entries.join('\n'))
      return { path, project: 'project', provider: 'kiro' }
    },
  },
]

describe('Kiro captured scan pricing', () => {
  it.each(variants)(
    'captures one pricing snapshot for $name before parsing begins',
    async ({ source: buildSource }) => {
      const root = tempDir()
      const source = buildSource(root)
      const provider = createKiroProvider(root, root, root, root)
      configure()
      const firstParser = provider.createSessionParser(source, new Set())

      // Change the alias after the parser factory captures pricing but before its
      // first filesystem read; this parser must retain the earlier target.
      configure(NEXT_MODEL)
      const first = await collect(firstParser)
      const next = await collect(provider.createSessionParser(source, new Set()))

      const firstCost = first[0]?.costUSD ?? 0
      const nextCost = next[0]?.costUSD ?? 0
      expect(first).toHaveLength(1)
      expect(next).toHaveLength(1)
      expect(firstCost).toBeGreaterThan(0)
      expect(nextCost).toBe(firstCost * 2)
    },
  )

  it('uses the scan pricing capability supplied in parser context', async () => {
    const root = tempDir()
    const modernExecution = variants.find(variant => variant.name === 'modern execution files')
    if (!modernExecution) throw new Error('Missing modern execution fixture')
    const source = modernExecution.source(root)
    const calculateCost = vi.fn(() => 29)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const parser = createKiroProvider(root, root, root, root).createSessionParser(source, new Set(), undefined, {
      pricing,
    })

    await expect(collect(parser)).resolves.toMatchObject([{ costUSD: 29 }])
    expect(calculateCost).toHaveBeenCalledTimes(1)
  })
})
