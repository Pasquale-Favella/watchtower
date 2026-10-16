import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCopilotProvider } from '../src/main/pipeline/providers/copilot.js'
import type { ParsedProviderCall, SessionSource } from '../src/main/pipeline/providers/types.js'

const hooks = vi.hoisted(() => ({ failPath: '' }))

vi.mock('../src/main/pipeline/fs-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/fs-utils.js')>()
  const { Stream } = await import('effect')
  return {
    ...actual,
    readSessionLinesStream: (
      path: string,
      shouldSkipHead?: Parameters<typeof actual.readSessionLinesStream>[1],
      options?: Parameters<typeof actual.readSessionLinesStream>[2],
    ) => {
      if (path === hooks.failPath) {
        return Stream.concat(
          Stream.make(
            JSON.stringify({
              type: 'assistant.message',
              data: { messageId: 'partial', model: 'gpt-4.1', outputTokens: 4 },
            }),
          ),
          Stream.fail(new Error('source read failed')),
        )
      }
      return actual.readSessionLinesStream(path, shouldSkipHead, options)
    },
  }
})

let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
  hooks.failPath = ''
})

async function makeSource(sessionKind: 'cli' | 'transcript' = 'cli'): Promise<SessionSource> {
  root = mkdtempSync(join(tmpdir(), 'watchtower-copilot-jsonl-effect-'))
  const directory = join(root, 'session')
  await mkdir(directory, { recursive: true })
  return {
    path: join(directory, 'events.jsonl'),
    project: 'copilot-jsonl',
    provider: 'copilot',
    sourceType: 'jsonl',
    sessionKind,
  } as SessionSource
}

async function collect(source: SessionSource, onUnparsedCall?: Effect.Effect<void>): Promise<ParsedProviderCall[]> {
  const parser = createCopilotProvider().createSessionParser(source, new Set())
  if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
  return Array.from(await Effect.runPromise(Stream.runCollect(parser.parseStream(onUnparsedCall))))
}

describe('Copilot JSONL Effect parser', () => {
  it('preserves finite negative output counters at the pricing and extraction boundary', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4.1' } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'negative', outputTokens: -3 } }),
      ].join('\n'),
    )
    const calculateCost = vi.fn(() => 1)
    const parser = createCopilotProvider().createSessionParser(source, new Set(), undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
    const calls = await Effect.runPromise(Stream.runCollect(parser.parseStream()))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.outputTokens).toBe(-3)
    expect(calculateCost).toHaveBeenCalledWith('gpt-4.1', 0, -3, 0, 0, 0)
  })
  it('validates selected fields once, ignores unused alternatives, and prices only admitted calls', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4.1' } }),
        JSON.stringify({
          type: 'assistant.message',
          timestamp: '2026-10-01T12:00:00.000Z',
          data: { messageId: 'bad-model', model: 42, outputTokens: 2 },
        }),
        JSON.stringify({
          type: 'assistant.message',
          timestamp: '2026-10-01T12:00:01.000Z',
          data: { messageId: 'bad-counter', outputTokens: Number.POSITIVE_INFINITY },
        }),
        JSON.stringify({
          type: 'assistant.message',
          timestamp: '2026-10-01T12:00:02.000Z',
          data: {
            messageId: 'valid',
            outputTokens: 7,
            inputTokens: Number.POSITIVE_INFINITY,
            toolRequests: [{ name: 'bash', arguments: { command: 'npm test' }, unknownKey: true }],
          },
        }),
      ].join('\n'),
    )
    const calculateCost = vi.fn(() => 1)
    let unparsed = 0
    const parser = createCopilotProvider().createSessionParser(source, new Set(), undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
    const calls = Array.from(
      await Effect.runPromise(Stream.runCollect(parser.parseStream(Effect.sync(() => unparsed++)))),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: 'gpt-4.1', outputTokens: 7, bashCommands: ['npm'] })
    expect(unparsed).toBe(2)
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(calculateCost).toHaveBeenCalledWith('gpt-4.1', 0, 7, 0, 0, 0)
  })

  it('sums resumed shutdown legs, subtracts cache tokens, and excludes output from rollups', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({
          type: 'session.shutdown',
          data: {
            modelMetrics: {
              'gpt-4.1': { usage: { inputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 3, reasoningTokens: 2 } },
            },
          },
        }),
        JSON.stringify({
          type: 'session.shutdown',
          data: {
            modelMetrics: {
              'gpt-4.1': { usage: { inputTokens: 27, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 1 } },
            },
          },
        }),
      ].join('\n'),
    )

    let unparsed = 0
    const parser = createCopilotProvider().createSessionParser(source, new Set())
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
    const calls = Array.from(
      await Effect.runPromise(Stream.runCollect(parser.parseStream(Effect.sync(() => unparsed++)))),
    )

    expect(unparsed).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: 'gpt-4.1',
      inputTokens: 53,
      cacheReadInputTokens: 9,
      cacheCreationInputTokens: 5,
      outputTokens: 0,
      reasoningTokens: 3,
      costIsEstimated: false,
    })
  })

  it('infers transcript model from tool IDs after reading the full line stream', async () => {
    const source = await makeSource('transcript')
    await writeFile(
      source.path,
      [
        JSON.stringify({
          type: 'assistant.message',
          data: { messageId: 'one', toolRequests: [{ toolCallId: 'call_a' }] },
        }),
        JSON.stringify({
          type: 'assistant.message',
          data: { messageId: 'two', toolRequests: [{ toolCallId: 'toolu_b' }] },
        }),
        JSON.stringify({
          type: 'assistant.message',
          timestamp: '2026-10-01T12:00:00.000Z',
          data: { messageId: 'three', toolRequests: [{ toolCallId: 'call_c' }] },
        }),
      ].join('\n'),
    )

    const calls = await collect(source)

    expect(calls.map(call => call.model)).toEqual(['copilot-openai-auto', 'copilot-openai-auto', 'copilot-openai-auto'])
  })

  it('propagates a valid per-message model through a zero-output message', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'initial-model' } }),
        JSON.stringify({
          type: 'assistant.message',
          data: { messageId: 'zero', model: 'next-model', outputTokens: 0 },
        }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'next', outputTokens: 5 } }),
      ].join('\n'),
    )
    const seenKeys = new Set<string>()
    const calculateCost = vi.fn(() => 1)
    const parser = createCopilotProvider().createSessionParser(source, seenKeys, undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')

    const calls = Array.from(await Effect.runPromise(Stream.runCollect(parser.parseStream())))

    expect(calls.map(call => call.model)).toEqual(['next-model'])
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(calculateCost).toHaveBeenCalledWith('next-model', 0, 5, 0, 0, 0)
    expect(seenKeys).not.toContain('copilot:session:zero')
  })

  it('propagates a valid per-message model through an externally seen duplicate', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'initial-model' } }),
        JSON.stringify({
          type: 'assistant.message',
          data: { messageId: 'duplicate', model: 'next-model', outputTokens: 3 },
        }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'next', outputTokens: 5 } }),
      ].join('\n'),
    )
    const seenKeys = new Set(['copilot:session:duplicate'])
    const calculateCost = vi.fn(() => 1)
    const parser = createCopilotProvider().createSessionParser(source, seenKeys, undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')

    const calls = Array.from(await Effect.runPromise(Stream.runCollect(parser.parseStream())))

    expect(calls.map(call => call.model)).toEqual(['next-model'])
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(calculateCost).toHaveBeenCalledWith('next-model', 0, 5, 0, 0, 0)
  })

  it('tallies a malformed selected model even when its message has zero output', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'initial-model' } }),
        JSON.stringify({
          type: 'assistant.message',
          data: { messageId: 'bad-zero-output', model: 42, outputTokens: 0 },
        }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'next', outputTokens: 5 } }),
      ].join('\n'),
    )
    const seenKeys = new Set<string>()
    const calculateCost = vi.fn(() => 1)
    let unparsed = 0
    const parser = createCopilotProvider().createSessionParser(source, seenKeys, undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')

    const calls = Array.from(
      await Effect.runPromise(Stream.runCollect(parser.parseStream(Effect.sync(() => unparsed++)))),
    )

    expect(calls.map(call => call.model)).toEqual(['initial-model'])
    expect(unparsed).toBe(1)
    expect(seenKeys).toEqual(new Set(['copilot:session:bad-zero-output', 'copilot:session:next']))
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(calculateCost).toHaveBeenCalledWith('initial-model', 0, 5, 0, 0, 0)
  })

  it('rejects a malformed user message once and does not attach it to the next call', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4.1' } }),
        JSON.stringify({ type: 'user.message', data: { content: { text: 'not a string' } } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'bad-user', outputTokens: 2 } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'next', outputTokens: 3 } }),
      ].join('\n'),
    )
    const calculateCost = vi.fn(() => 1)
    let unparsed = 0
    const parser = createCopilotProvider().createSessionParser(source, new Set(), undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')

    const calls = Array.from(
      await Effect.runPromise(Stream.runCollect(parser.parseStream(Effect.sync(() => unparsed++)))),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ deduplicationKey: 'copilot:session:next', userMessage: '' })
    expect(unparsed).toBe(1)
    expect(calculateCost).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-string timestamp before pricing', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4.1' } }),
        JSON.stringify({
          type: 'assistant.message',
          timestamp: { value: 'not a string' },
          data: { messageId: 'bad-timestamp', outputTokens: 2 },
        }),
      ].join('\n'),
    )
    const calculateCost = vi.fn(() => 1)
    let unparsed = 0
    const parser = createCopilotProvider().createSessionParser(source, new Set(), undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')

    const calls = Array.from(
      await Effect.runPromise(Stream.runCollect(parser.parseStream(Effect.sync(() => unparsed++)))),
    )

    expect(calls).toEqual([])
    expect(unparsed).toBe(1)
    expect(calculateCost).not.toHaveBeenCalled()
  })

  it('keeps a malformed truthy subagent selection invalid until a valid selection', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4.1' } }),
        JSON.stringify({ type: 'subagent.selected', data: { agentName: { name: 'not a string' } } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'bad-agent', outputTokens: 2 } }),
        JSON.stringify({ type: 'subagent.selected', data: { agentName: 'worker' } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'good-agent', outputTokens: 3 } }),
      ].join('\n'),
    )
    const calculateCost = vi.fn(() => 1)
    let unparsed = 0
    const parser = createCopilotProvider().createSessionParser(source, new Set(), undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')

    const calls = Array.from(
      await Effect.runPromise(Stream.runCollect(parser.parseStream(Effect.sync(() => unparsed++)))),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ deduplicationKey: 'copilot:session:good-agent', subagentTypes: ['worker'] })
    expect(unparsed).toBe(1)
    expect(calculateCost).toHaveBeenCalledTimes(1)
  })

  it('preserves template-string deduplication for a missing message ID', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4.1' } }),
        JSON.stringify({ type: 'assistant.message', data: { outputTokens: 2 } }),
      ].join('\n'),
    )

    const calls = await collect(source)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.deduplicationKey).toBe('copilot:session:undefined')
  })

  it('does not price or admit later candidates until each candidate is pulled', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      [
        JSON.stringify({ type: 'session.start', data: { selectedModel: 'gpt-4.1' } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'first', outputTokens: 2 } }),
        JSON.stringify({ type: 'assistant.message', data: { messageId: 'second', outputTokens: 3 } }),
      ].join('\n'),
    )
    const seenKeys = new Set<string>()
    const calculateCost = vi.fn(() => 1)
    const parser = createCopilotProvider().createSessionParser(source, seenKeys, undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')
    const iterator = Stream.toAsyncIterable(parser.parseStream())[Symbol.asyncIterator]()

    const first = await iterator.next()

    expect(first.done).toBe(false)
    expect(seenKeys).toEqual(new Set(['copilot:session:first']))
    expect(calculateCost).toHaveBeenCalledTimes(1)
    await iterator.return?.()
  })

  it('emits no prefix, seen keys, or prices when the source read fails after a line', async () => {
    const source = await makeSource()
    hooks.failPath = source.path
    const seenKeys = new Set<string>()
    const calculateCost = vi.fn(() => 1)
    const parser = createCopilotProvider().createSessionParser(source, seenKeys, undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')

    const calls = Array.from(await Effect.runPromise(Stream.runCollect(parser.parseStream())))

    expect(calls).toEqual([])
    expect(seenKeys).toEqual(new Set())
    expect(calculateCost).not.toHaveBeenCalled()
  })

  it('does not mask a callback defect as a source read failure', async () => {
    const source = await makeSource()
    await writeFile(
      source.path,
      JSON.stringify({
        type: 'assistant.message',
        data: { messageId: 'bad-model', model: 42, outputTokens: 2 },
      }),
    )
    const defect = new Error('callback defect')
    const parser = createCopilotProvider().createSessionParser(source, new Set())
    if (!parser.parseStream) throw new Error('Copilot parser has no Effect stream')

    await expect(Effect.runPromise(Stream.runCollect(parser.parseStream(Effect.die(defect))))).rejects.toBe(defect)
  })
})
