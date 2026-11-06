import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reader = vi.hoisted(() => ({ failAfterPrefix: false }))

vi.mock('../src/infrastructure/ingestion/fs-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/infrastructure/ingestion/fs-utils.js')>()
  return {
    ...actual,
    readSessionLinesStream: (...args: Parameters<typeof actual.readSessionLinesStream>) => {
      const stream = actual.readSessionLinesStream(...args)
      return reader.failAfterPrefix
        ? Stream.concat(stream, Stream.fail(new actual.SessionLineReadError({ cause: new Error('read failed') })))
        : stream
    },
  }
})

import { createCopilotProvider } from '../src/infrastructure/provider-adapters/copilot.js'
import type { ParsedProviderCall, SessionSource } from '../src/infrastructure/provider-adapters/types.js'

let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
  reader.failAfterPrefix = false
})

function makeSource(): SessionSource {
  if (!root) root = mkdtempSync(join(tmpdir(), 'watchtower-copilot-journal-effect-'))
  return {
    path: join(root, 'session.jsonl'),
    project: 'copilot-journal',
    provider: 'copilot',
    sourceType: 'chatsession',
  } as SessionSource
}

async function collect(
  parser: ReturnType<ReturnType<typeof createCopilotProvider>['createSessionParser']>,
): Promise<ParsedProviderCall[]> {
  if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
  const calls = await Effect.runPromise(Stream.runCollect(parser.parseStream()))
  return Array.from(calls)
}

describe('Copilot chat journal Effect parser', () => {
  it('discards a read prefix before pricing or admitting any reconstructed request', async () => {
    const source = makeSource()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      source.path,
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: 'chat-session',
          requests: [
            { requestId: 'one', modelId: 'gpt-4.1', result: { metadata: { promptTokens: 1, outputTokens: 2 } } },
          ],
        },
      }),
    )
    reader.failAfterPrefix = true
    const calculateCost = vi.fn(() => 1)
    const seen = new Set<string>()
    const parser = createCopilotProvider().createSessionParser(source, seen, undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })

    expect(await collect(parser)).toEqual([])
    expect(calculateCost).not.toHaveBeenCalled()
    expect(seen.size).toBe(0)
  })
  it('replays append and nested array set operations and prices decoded requests', async () => {
    const source = makeSource()
    const request = {
      requestId: 'request-1',
      modelId: 'copilot/gpt-4.1',
      timestamp: '2026-10-01T12:00:00.000Z',
      message: { text: 'Fix the issue' },
      result: { metadata: { promptTokens: 12, outputTokens: 4, toolCallRounds: [{ toolName: 'bash' }] } },
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      source.path,
      [
        JSON.stringify({ kind: 0, v: { sessionId: 'chat-session', creationDate: 1790856000000, requests: [] } }),
        JSON.stringify({ kind: 2, v: [request] }),
        JSON.stringify({ kind: 1, k: ['requests', 0, 'result', 'metadata', 'outputTokens'], v: 9 }),
        JSON.stringify({ kind: 1, k: ['__proto__', 'polluted'], v: true }),
      ].join('\n'),
    )

    const calls = await collect(createCopilotProvider().createSessionParser(source, new Set()))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'chat-session',
      model: 'gpt-4.1',
      inputTokens: 12,
      outputTokens: 9,
      tools: ['Bash'],
      userMessage: 'Fix the issue',
      deduplicationKey: 'copilot-chatsession:chat-session:request-1',
    })
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('omits malformed selected model and token counters after admission and tallies them', async () => {
    const source = makeSource()
    const requests = [
      { requestId: 'bad-model', modelId: 42, result: { metadata: { promptTokens: 1, outputTokens: 2 } } },
      {
        requestId: 'bad-counter',
        result: { metadata: { resolvedModel: 'gpt-4.1', promptTokens: Infinity, outputTokens: 2 } },
      },
      { requestId: 'unknown-model', result: { metadata: { promptTokens: 1, outputTokens: 2 } } },
    ]
    const { writeFile } = await import('node:fs/promises')
    await writeFile(source.path, JSON.stringify({ kind: 0, v: { sessionId: 'chat-session', requests } }))

    let rejected = 0
    const parser = createCopilotProvider().createSessionParser(source, new Set())
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
    const calls = await Effect.runPromise(Stream.runCollect(parser.parseStream(Effect.sync(() => rejected++))))

    expect(Array.from(calls)).toHaveLength(1)
    expect(Array.from(calls)[0]?.model).toBe('unknown')
    expect(rejected).toBe(2)
  })

  it('sums modelTotals into input without the cached part, plus cache reads and output', async () => {
    // An agent-mode request makes one call per tool round; metadata holds only the
    // LAST one. `modelTotals` sums every round, cache-inclusive input included.
    const source = makeSource()
    const request = {
      requestId: 'totals',
      modelId: 'copilot/gpt-4.1',
      result: { metadata: { promptTokens: 10, outputTokens: 2 } },
      modelTotals: [
        { model: 'gpt-4.1', inputTokens: 1_000, cachedTokens: 700, outputTokens: 40 },
        { model: 'gpt-4.1', inputTokens: 500, cachedTokens: 300, outputTokens: 10 },
      ],
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(source.path, JSON.stringify({ kind: 0, v: { sessionId: 'chat-session', requests: [request] } }))

    const [call] = await collect(createCopilotProvider().createSessionParser(source, new Set()))

    expect(call).toMatchObject({ inputTokens: 500, cacheReadInputTokens: 1_000, outputTokens: 50 })
  })

  it('prices the request at copilotCredits when it carries GitHub’s figure', async () => {
    // 1.5 credits = $0.015, exact, where the last-round prompt could not price it.
    const source = makeSource()
    const request = {
      requestId: 'credits',
      modelId: 'copilot/gpt-4.1',
      copilotCredits: 1.5,
      result: { metadata: { promptTokens: 10, outputTokens: 2 } },
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(source.path, JSON.stringify({ kind: 0, v: { sessionId: 'chat-session', requests: [request] } }))

    const [call] = await collect(createCopilotProvider().createSessionParser(source, new Set()))
    expect(call?.costUSD).toBeCloseTo(0.015, 10)
  })

  it('reads a pre-1.109 flat .json chat session as one document', async () => {
    const source = makeSource()
    const flat = { ...source, path: source.path.replace(/\.jsonl$/, '.json') }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      flat.path,
      JSON.stringify({
        sessionId: 'flat-session',
        creationDate: 1790856000000,
        requests: [
          {
            requestId: 'legacy-1',
            modelId: 'copilot/gpt-4.1',
            timestamp: '2026-10-01T12:00:00.000Z',
            result: { metadata: { promptTokens: 11, outputTokens: 3 } },
          },
        ],
      }),
    )

    const [call] = await collect(createCopilotProvider().createSessionParser(flat, new Set()))
    expect(call).toMatchObject({
      sessionId: 'flat-session',
      model: 'gpt-4.1',
      inputTokens: 11,
      outputTokens: 3,
    })
  })

  it('resolves models from auto-mode responses, result metadata, and the session selection', async () => {
    const source = makeSource()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      source.path,
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: 'model-fallbacks',
          inputState: { selectedModel: { metadata: { version: 'copilot/claude-sonnet-4-6' } } },
          requests: [
            {
              requestId: 'auto-mode',
              modelId: 'auto',
              response: [{ kind: 'autoModeResolution', resolvedModel: 'copilot/gpt-4o' }],
              result: { metadata: { promptTokens: 1, outputTokens: 2 } },
            },
            {
              requestId: 'session-model',
              result: { metadata: { promptTokens: 1, outputTokens: 2 } },
            },
            {
              requestId: 'result-model',
              result: {
                model: 'github.copilot-chat/gemini-2.0-flash',
                metadata: { promptTokens: 1, outputTokens: 2 },
              },
            },
          ],
        },
      }),
    )

    const calls = await collect(createCopilotProvider().createSessionParser(source, new Set()))

    expect(calls.map(call => call.model)).toEqual(['gpt-4o', 'claude-sonnet-4-6', 'gemini-2.0-flash'])
  })

  it('infers an auto model family from chat-session tool-call IDs', async () => {
    const source = makeSource()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      source.path,
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: 'tool-call-model',
          requests: [
            {
              requestId: 'anthropic-tool',
              response: [{ kind: 'toolInvocationSerialized', toolCallId: 'tooluse_abc123' }],
              result: { metadata: { promptTokens: 1, outputTokens: 2 } },
            },
          ],
        },
      }),
    )

    const calls = await collect(createCopilotProvider().createSessionParser(source, new Set()))

    expect(calls.map(call => call.model)).toEqual(['copilot-anthropic-auto'])

    const openAiSource = { ...source, path: source.path.replace('session.jsonl', 'openai-session.jsonl') }
    await writeFile(
      openAiSource.path,
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: 'openai-tool-call-model',
          requests: [
            {
              requestId: 'openai-tool',
              result: {
                metadata: {
                  promptTokens: 1,
                  outputTokens: 2,
                  toolCallRounds: [{ toolCalls: [{ id: 'call_abc123' }] }],
                },
              },
            },
          ],
        },
      }),
    )

    const openAiCalls = await collect(createCopilotProvider().createSessionParser(openAiSource, new Set()))

    expect(openAiCalls.map(call => call.model)).toEqual(['copilot-openai-auto'])
  })

  it("uses another request's concrete model when the current request is in auto mode", async () => {
    const source = makeSource()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      source.path,
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: 'sibling-model-fallback',
          requests: [
            {
              requestId: 'selected',
              modelId: 'copilot/gpt-4.1',
              result: { metadata: { promptTokens: 1, outputTokens: 2 } },
            },
            {
              requestId: 'automatic',
              modelId: 'auto',
              result: { metadata: { promptTokens: 1, outputTokens: 2 } },
            },
          ],
        },
      }),
    )

    const calls = await collect(createCopilotProvider().createSessionParser(source, new Set()))

    expect(calls.map(call => call.model)).toEqual(['gpt-4.1', 'gpt-4.1'])
  })

  it('validates the model and output counter selected by the parser', async () => {
    const source = makeSource()
    const requests = [
      {
        requestId: 'fallback-model',
        modelId: 'copilot/gpt-4.1',
        result: { metadata: { resolvedModel: 42, promptTokens: 1, outputTokens: 2 } },
      },
      {
        requestId: 'metadata-output',
        modelId: 'copilot/gpt-4.1',
        completionTokens: Infinity,
        result: { metadata: { resolvedModel: 'gpt-4.1', promptTokens: 1, outputTokens: 9 } },
      },
    ]
    const { writeFile } = await import('node:fs/promises')
    await writeFile(source.path, JSON.stringify({ kind: 0, v: { sessionId: 'chat-session', requests } }))

    let rejected = 0
    const parser = createCopilotProvider().createSessionParser(source, new Set())
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
    const calls = await Effect.runPromise(Stream.runCollect(parser.parseStream(Effect.sync(() => rejected++))))

    expect(Array.from(calls)).toHaveLength(2)
    expect(Array.from(calls).map(call => [call.model, call.outputTokens])).toEqual([
      ['gpt-4.1', 2],
      ['gpt-4.1', 9],
    ])
    expect(rejected).toBe(0)
  })
})
