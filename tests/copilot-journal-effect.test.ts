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
