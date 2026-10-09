import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ readerEvents: [] as string[] }))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      const path = String(args[0])
      hooks.readerEvents.push(`open:${path}`)
      stream.once('close', () => hooks.readerEvents.push(`close:${path}`))
      return stream
    },
  }
})

import { mkdir, writeFile } from 'node:fs/promises'

import { Env } from '../src/main/env.js'
import { createMistralVibeProvider } from '../src/main/pipeline/providers/mistral-vibe.js'
import type { Provider, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-mistral-vibe-effect-'))
  hooks.readerEvents.length = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function writeSession(path: string, metadata: unknown, messages: string[]): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'meta.json'), JSON.stringify(metadata))
  await writeFile(join(path, 'messages.jsonl'), messages.join('\n'))
}

function nativeDiscovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Mistral Vibe Effect discovery is unavailable')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

function parser(path: string, seen = new Set<string>(), signal?: AbortSignal): SessionParser {
  return createMistralVibeProvider(root).createSessionParser(
    { path, project: 'session', provider: 'mistral-vibe' } satisfies SessionSource,
    seen,
    undefined,
    signal ? { signal } : undefined,
  )
}

async function collect(parserValue: SessionParser) {
  if (!parserValue.parseStream) throw new Error('Mistral Vibe parser has no native stream')
  return [...(await Effect.runPromise(Stream.runCollect(parserValue.parseStream())))]
}

describe('Mistral Vibe Effect provider', () => {
  it('discovers sorted sessions and agent sessions only when both sidecar files exist', async () => {
    const sessionsDir = join(root, 'sessions')
    await writeSession(join(sessionsDir, 'session-b'), { session_id: 'b' }, [])
    await writeSession(join(sessionsDir, 'session-a'), { environment: { working_directory: '/work/a' } }, [])
    await writeSession(join(sessionsDir, 'session-a', 'agents', 'agent-b'), {}, [])
    await writeSession(join(sessionsDir, 'session-a', 'agents', 'agent-a'), {}, [])
    await mkdir(join(sessionsDir, 'missing-sidecar'), { recursive: true })
    await writeFile(join(sessionsDir, 'missing-sidecar', 'meta.json'), '{}')

    const sources = await Effect.runPromise(nativeDiscovery(createMistralVibeProvider(sessionsDir)))

    expect(sources.map(source => [source.path, source.project])).toEqual([
      [join(sessionsDir, 'session-a'), 'a'],
      [join(sessionsDir, 'session-a', 'agents', 'agent-a'), 'agent-a'],
      [join(sessionsDir, 'session-a', 'agents', 'agent-b'), 'agent-b'],
      [join(sessionsDir, 'session-b'), 'session-b'],
    ])
  })

  it('matches the Promise adapter and preserves allocations, turns, tools, and valid message siblings', async () => {
    const path = join(root, 'session-one')
    const metadata = {
      session_id: 'session-one',
      start_time: 'start',
      stats: { session_prompt_tokens: 7, session_completion_tokens: 5, session_cost: 2 },
      config: { active_model: 'mistral-vibe-cli-latest' },
    }
    const messages = [
      JSON.stringify({ role: 'user', content: 'first request' }),
      '{malformed json',
      JSON.stringify({ role: 'assistant', message_id: 'assistant-one', timestamp: 'one' }),
      JSON.stringify({ role: 42, message_id: 'invalid-role' }),
      JSON.stringify({
        role: 'user',
        content: [{ text: 'second request' }],
      }),
      JSON.stringify({
        role: 'assistant',
        message_id: 'assistant-two',
        tool_calls: [
          { function: { name: 'bash', arguments: { command: 'git status' } } },
          { function: { name: 17 } },
          null,
        ],
      }),
    ]
    await writeSession(path, metadata, messages)

    const provider = createMistralVibeProvider(root)
    const source = { path, project: 'session-one', provider: 'mistral-vibe' } satisfies SessionSource
    const native = provider.createSessionParser(source, new Set())
    const legacy = provider.createSessionParser(source, new Set())
    const calls = await collect(native)
    const legacyCalls = []
    for await (const call of legacy.parse()) legacyCalls.push(call)

    expect(calls).toEqual(legacyCalls)
    expect(calls).toMatchObject([
      {
        model: 'mistral-vibe-cli-latest',
        inputTokens: 4,
        outputTokens: 3,
        costUSD: 1,
        timestamp: 'one',
        turnId: 'session-one:turn-0',
        userMessage: 'first request',
      },
      {
        model: 'mistral-vibe-cli-latest',
        inputTokens: 3,
        outputTokens: 2,
        costUSD: 1,
        timestamp: 'start',
        turnId: 'session-one:turn-1',
        userMessage: 'second request',
        tools: ['Bash'],
        bashCommands: ['git'],
      },
    ])
  })

  it('skips malformed metadata and emits one deduplicated fallback when no assistant message exists', async () => {
    const invalidPath = join(root, 'invalid')
    const fallbackPath = join(root, 'fallback')
    await writeSession(invalidPath, {}, [])
    await writeFile(join(invalidPath, 'meta.json'), '{invalid')
    await writeSession(
      fallbackPath,
      { session_id: 'fallback-session', title: 'fallback title', stats: { session_prompt_tokens: 9 } },
      [JSON.stringify({ role: 'user', content: 'first user prompt' })],
    )

    expect(await collect(parser(invalidPath))).toEqual([])
    const seen = new Set<string>()
    expect(await collect(parser(fallbackPath, seen))).toHaveLength(1)
    expect(await collect(parser(fallbackPath, seen))).toEqual([])
  })

  it('closes the message reader before yielding and records dedupe only for consumed calls', async () => {
    const path = join(root, 'partial')
    await writeSession(
      path,
      { session_id: 'partial-session', stats: { session_prompt_tokens: 2, session_completion_tokens: 2 } },
      [
        JSON.stringify({ role: 'assistant', message_id: 'first' }),
        JSON.stringify({ role: 'assistant', message_id: 'second' }),
      ],
    )
    const seen = new Set<string>()
    const parserValue = parser(path, seen)
    if (!parserValue.parseStream) throw new Error('Mistral Vibe parser has no native stream')

    const calls = await Effect.runPromise(Stream.runCollect(parserValue.parseStream().pipe(Stream.take(1))))

    expect(calls).toHaveLength(1)
    expect(seen).toEqual(new Set(['mistral-vibe:partial-session:first']))
    expect(hooks.readerEvents).toEqual([
      `open:${join(path, 'messages.jsonl')}`,
      `close:${join(path, 'messages.jsonl')}`,
    ])
  })

  it('preserves the caller cancellation error identity at discovery and parse boundaries', async () => {
    const controller = new AbortController()
    const failure = new ScanAbortedError({ message: 'caller stopped' })
    controller.abort(failure)
    const provider = createMistralVibeProvider(root)
    const parserValue = parser(join(root, 'session'), new Set(), controller.signal)
    if (!parserValue.parseStream) throw new Error('Mistral Vibe parser has no native stream')

    const discoveryExit = await Effect.runPromiseExit(nativeDiscovery(provider, controller.signal))
    const parserExit = await Effect.runPromiseExit(Stream.runCollect(parserValue.parseStream()))

    expect(discoveryExit._tag).toBe('Failure')
    expect(parserExit._tag).toBe('Failure')
    if (discoveryExit._tag === 'Failure') {
      expect(discoveryExit.cause.reasons[0]).toMatchObject({ _tag: 'Fail' })
      if (discoveryExit.cause.reasons[0]?._tag === 'Fail') expect(discoveryExit.cause.reasons[0].error).toBe(failure)
    }
    if (parserExit._tag === 'Failure') {
      expect(parserExit.cause.reasons[0]).toMatchObject({ _tag: 'Fail' })
      if (parserExit.cause.reasons[0]?._tag === 'Fail') expect(parserExit.cause.reasons[0].error).toBe(failure)
    }
  })
})
