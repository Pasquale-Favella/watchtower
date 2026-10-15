import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fsReadState = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock('fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('fs/promises')>()
  return {
    ...original,
    readFile: (...args: Parameters<typeof original.readFile>) => {
      fsReadState.paths.push(String(args[0]))
      return original.readFile(...args)
    },
  }
})

import { Env } from '../src/main/env.js'
import { createKiroProvider } from '../src/main/pipeline/providers/kiro.js'
import type { Provider, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'watchtower-kiro-effect-'))
  roots.push(root)
  return root
}

function parserStream(parser: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!parser.parseStream) throw new Error('Kiro parser did not expose its native stream')
  return parser.parseStream
}

function nativeDiscovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Kiro provider did not expose native discovery')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

async function collect(parser: SessionParser) {
  return Array.from(await Effect.runPromise(Stream.runCollect(parserStream(parser)())))
}

function source(path: string): SessionSource {
  return { path, project: 'fixture-project', provider: 'kiro' }
}

describe('Kiro native Effect provider', () => {
  it('discovers CLI, workspace, and v2 sources in the established root order', async () => {
    const root = tempDir()
    const agent = join(root, 'agent')
    const workspaceStorage = join(root, 'workspace-storage')
    const cli = join(root, 'sessions', 'cli')
    const v2 = join(root, 'sessions')
    const wsHash = 'a'.repeat(32)
    mkdirSync(join(agent, wsHash), { recursive: true })
    mkdirSync(join(agent, 'workspace-sessions', 'L3dvcmsvZGVtbw'), { recursive: true })
    mkdirSync(cli, { recursive: true })
    const v2Session = join(v2, 'workspace', 'sess_one')
    mkdirSync(v2Session, { recursive: true })

    writeFileSync(join(cli, 'cli.jsonl'), '{"kind":"Prompt","data":{"content":[]}}\n')
    writeFileSync(join(agent, wsHash, 'one.chat'), '{}')
    writeFileSync(
      join(agent, 'workspace-sessions', 'L3dvcmsvZGVtbw', 'workspace.json'),
      JSON.stringify({ sessionId: 'ws' }),
    )
    writeFileSync(join(v2Session, 'messages.jsonl'), '')

    const provider = createKiroProvider(agent, workspaceStorage, cli, v2)
    const found = await Effect.runPromise(nativeDiscovery(provider))
    expect(found.map(item => item.path)).toEqual([
      join(cli, 'cli.jsonl'),
      join(agent, wsHash, 'one.chat'),
      join(agent, 'workspace-sessions', 'L3dvcmsvZGVtbw', 'workspace.json'),
      join(v2Session, 'messages.jsonl'),
    ])
    expect(await provider.discoverSessions()).toEqual(found)
  })

  it('parses v2 events from the bounded native line stream and preserves reasoning billing', async () => {
    const root = tempDir()
    const sessionDir = join(root, 'sess_one')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ id: 'session-one', modelId: 'claude-sonnet-4.5' }))
    const stamp = '2026-01-01T00:00:00.000Z'
    const messages = [
      { type: 'user', content: 'prompt' },
      { type: 'turn_start', executionId: 'execution-one' },
      { type: 'assistant', content: 'reasoning text', operationType: 'Reasoning' },
      { type: 'assistant', content: 'answer' },
      { type: 'turn_end' },
    ].map(payload => JSON.stringify({ timestamp: stamp, payload }))
    const path = join(sessionDir, 'messages.jsonl')
    writeFileSync(path, messages.join('\n'))

    const calls = await collect(createKiroProvider().createSessionParser(source(path), new Set()))
    expect(calls).toMatchObject([
      {
        provider: 'kiro',
        model: 'claude-sonnet-4-5',
        reasoningTokens: 4,
        outputTokens: 2,
        inputTokens: 2,
        userMessage: 'prompt',
        timestamp: stamp,
      },
    ])
  })

  it('fails discovery when the supplied scan signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      Effect.runPromise(nativeDiscovery(createKiroProvider(tempDir()), controller.signal)),
    ).rejects.toMatchObject({
      _tag: 'ScanAbortedError',
    })
  })

  it('omits a workspace call with a malformed selected model and reports it to the tally hook', async () => {
    const root = tempDir()
    const path = join(root, 'workspace-session.json')
    writeFileSync(
      path,
      JSON.stringify({
        sessionId: 'workspace-one',
        selectedModel: 42,
        history: [
          { message: { role: 'user', content: 'prompt' } },
          { message: { role: 'assistant', content: 'response' } },
        ],
      }),
    )
    let unparsed = 0
    const parser = createKiroProvider().createSessionParser(source(path), new Set())
    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser)(Effect.sync(() => (unparsed += 1)))))
    expect(calls).toHaveLength(0)
    expect(unparsed).toBe(1)
  })

  it('ignores malformed optional v2 credits and keeps estimated pricing for both turns', async () => {
    const root = tempDir()
    const sessionDir = join(root, 'sess_credit')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'session.json'),
      JSON.stringify({ id: 'credit-session', modelId: 'claude-sonnet-4' }),
    )
    const stamp = '2026-01-01T00:00:00.000Z'
    const payloads = [
      { type: 'user', content: 'first prompt' },
      { type: 'turn_start', executionId: 'bad-credit' },
      { type: 'assistant', content: 'first response' },
      { type: 'usage_summary', promptTurnSummaries: [{ usage: 'bad' }] },
      { type: 'turn_end' },
      { type: 'user', content: 'second prompt' },
      { type: 'turn_start', executionId: 'good-credit' },
      { type: 'assistant', content: 'second response' },
      { type: 'turn_end' },
    ]
    const path = join(sessionDir, 'messages.jsonl')
    writeFileSync(path, payloads.map(payload => JSON.stringify({ timestamp: stamp, payload })).join('\n'))

    let unparsed = 0
    const parser = createKiroProvider().createSessionParser(source(path), new Set())
    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser)(Effect.sync(() => (unparsed += 1)))))
    expect(calls).toMatchObject([
      { deduplicationKey: 'kiro-v2:credit-session:bad-credit', userMessage: 'first prompt', costIsEstimated: true },
      { deduplicationKey: 'kiro-v2:credit-session:good-credit', userMessage: 'second prompt', costIsEstimated: true },
    ])
    expect(unparsed).toBe(0)
  })

  it('ignores malformed optional CLI credits and keeps estimated pricing', async () => {
    const root = tempDir()
    const path = join(root, 'cli.jsonl')
    const entries = [
      { kind: 'Prompt', data: { content: [{ kind: 'text', data: 'prompt' }] } },
      { kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'response' }] } },
    ]
    writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n'))
    writeFileSync(
      join(root, 'cli.json'),
      JSON.stringify({
        session_id: 'cli-session',
        cwd: root,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        session_state: {
          conversation_metadata: {
            user_turn_metadatas: [
              {
                end_timestamp: '2026-01-01T00:00:00.000Z',
                metering_usage: [
                  { value: 2, unit: 'credit' },
                  { value: 'bad', unit: 'credit' },
                ],
              },
            ],
          },
        },
      }),
    )

    let unparsed = 0
    const parser = createKiroProvider().createSessionParser(source(path), new Set())
    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser)(Effect.sync(() => (unparsed += 1)))))
    expect(calls).toMatchObject([{ deduplicationKey: 'kiro-cli:cli-session:0', costIsEstimated: true }])
    expect(unparsed).toBe(0)
  })

  it('preserves CLI numeric-string credit summation', async () => {
    const root = tempDir()
    const path = join(root, 'cli.jsonl')
    writeFileSync(
      path,
      [
        { kind: 'Prompt', data: { content: [{ kind: 'text', data: 'prompt' }] } },
        { kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'response' }] } },
      ]
        .map(entry => JSON.stringify(entry))
        .join('\n'),
    )
    writeFileSync(
      join(root, 'cli.json'),
      JSON.stringify({
        session_id: 'cli-numeric-string',
        cwd: root,
        created_at: '2026-01-01T00:00:00.000Z',
        session_state: {
          conversation_metadata: {
            user_turn_metadatas: [
              {
                end_timestamp: '2026-01-01T00:00:00.000Z',
                metering_usage: [
                  { value: '2', unit: 'credit' },
                  { value: '3', unit: 'credit' },
                ],
              },
            ],
          },
        },
      }),
    )

    const parser = createKiroProvider().createSessionParser(source(path), new Set())
    const calls = await collect(parser)
    expect(calls).toMatchObject([
      { deduplicationKey: 'kiro-cli:cli-numeric-string:0', costUSD: 0.92, costIsEstimated: false },
    ])
  })

  it.each([
    { name: 'missing', content: undefined },
    { name: 'empty', content: '' },
    { name: 'invalid JSONL', content: '{not-json' },
  ])('does not read or tally malformed companion metadata for $name CLI logs', async ({ content }) => {
    const root = tempDir()
    const path = join(root, 'cli.jsonl')
    if (content !== undefined) writeFileSync(path, content)
    const companionPath = join(root, 'cli.json')
    writeFileSync(
      companionPath,
      JSON.stringify({ session_id: 'bad-meta', session_state: { rts_model_state: { model_info: { model_id: 42 } } } }),
    )
    fsReadState.paths.length = 0
    let unparsed = 0
    const parser = createKiroProvider().createSessionParser(source(path), new Set())
    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser)(Effect.sync(() => (unparsed += 1)))))

    expect(calls).toHaveLength(0)
    expect(unparsed).toBe(0)
    expect(fsReadState.paths.filter(readPath => readPath === companionPath)).toHaveLength(0)
  })

  it('reads valid CLI companion metadata once after the first decoded source line', async () => {
    const root = tempDir()
    const path = join(root, 'cli.jsonl')
    writeFileSync(
      path,
      [
        { kind: 'Prompt', data: { content: [{ kind: 'text', data: 'prompt' }] } },
        { kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'response' }] } },
      ]
        .map(entry => JSON.stringify(entry))
        .join('\n'),
    )
    const companionPath = join(root, 'cli.json')
    writeFileSync(
      companionPath,
      JSON.stringify({
        session_id: 'single-meta-read',
        created_at: '2026-01-01T00:00:00.000Z',
        session_state: {
          conversation_metadata: { user_turn_metadatas: [{ end_timestamp: '2026-01-01T00:00:00.000Z' }] },
        },
      }),
    )
    fsReadState.paths.length = 0
    const parser = createKiroProvider().createSessionParser(source(path), new Set())
    const calls = await collect(parser)

    expect(calls).toHaveLength(1)
    expect(fsReadState.paths.filter(readPath => readPath === companionPath)).toHaveLength(1)
  })

  it.each([
    {
      name: 'unused malformed model alias',
      fields: { modelId: 42, metadata: { modelId: 'claude-sonnet-4' } },
      expected: { model: 'claude-sonnet-4' },
    },
    {
      name: 'malformed unused metered usage counter',
      fields: { modelId: 'claude-sonnet-4', usageSummary: [{ usage: 'bad' }] },
      expected: { model: 'claude-sonnet-4', costIsEstimated: true },
    },
  ])('keeps a modern call when $name is unused by the baseline fallback', async ({ fields, expected }) => {
    const root = tempDir()
    const path = join(root, 'execution.json')
    writeFileSync(
      path,
      JSON.stringify({
        executionId: 'execution-one',
        sessionId: 'session-one',
        startTime: 1_767_225_600_000,
        prompt: 'prompt',
        response: 'response',
        ...fields,
      }),
    )
    let unparsed = 0
    const parser = createKiroProvider().createSessionParser(source(path), new Set())
    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser)(Effect.sync(() => (unparsed += 1)))))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject(expected)
    expect(unparsed).toBe(0)
  })

  it('prices and admits only the consumed CLI turn', async () => {
    const root = tempDir()
    const path = join(root, 'cli.jsonl')
    const turns = [
      { kind: 'Prompt', data: { content: [{ kind: 'text', data: 'first prompt' }] } },
      { kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'first response' }] } },
      { kind: 'Prompt', data: { content: [{ kind: 'text', data: 'second prompt' }] } },
      { kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'second response' }] } },
    ]
    writeFileSync(path, turns.map(turn => JSON.stringify(turn)).join('\n'))
    writeFileSync(
      join(root, 'cli.json'),
      JSON.stringify({
        session_id: 'cli-head',
        cwd: root,
        created_at: '2026-01-01T00:00:00.000Z',
        session_state: {
          conversation_metadata: {
            user_turn_metadatas: [
              { end_timestamp: '2026-01-01T00:00:00.000Z' },
              { end_timestamp: '2026-01-01T00:01:00.000Z' },
            ],
          },
        },
      }),
    )
    const seen = new Set<string>()
    let prices = 0
    const pricing: ScanPricing = {
      calculateCost() {
        prices++
        if (prices > 1) throw new Error('later turn was priced')
        return 3
      },
      calculateLocalModelSavings: () => null,
    }
    const parser = createKiroProvider().createSessionParser(source(path), seen, undefined, { pricing })
    const head = await Effect.runPromise(Stream.runHead(parserStream(parser)()))

    expect(head).toMatchObject({ _tag: 'Some', value: { deduplicationKey: 'kiro-cli:cli-head:0', costUSD: 3 } })
    expect(prices).toBe(1)
    expect(seen).toEqual(new Set(['kiro-cli:cli-head:0']))
  })

  it('prices and admits only the consumed v2 turn', async () => {
    const root = tempDir()
    const sessionDir = join(root, 'sess_runhead')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ id: 'v2-head', modelId: 'claude-sonnet-4' }))
    const events = ['first', 'second'].flatMap((name, index) => [
      { timestamp: `2026-01-01T00:0${index}:00.000Z`, payload: { type: 'user', content: `${name} prompt` } },
      {
        timestamp: `2026-01-01T00:0${index}:00.000Z`,
        payload: { type: 'turn_start', executionId: `${name}-turn` },
      },
      { timestamp: `2026-01-01T00:0${index}:00.000Z`, payload: { type: 'assistant', content: `${name} response` } },
      { timestamp: `2026-01-01T00:0${index}:00.000Z`, payload: { type: 'turn_end' } },
    ])
    const path = join(sessionDir, 'messages.jsonl')
    writeFileSync(path, events.map(event => JSON.stringify(event)).join('\n'))
    const seen = new Set<string>()
    let prices = 0
    const pricing: ScanPricing = {
      calculateCost() {
        prices++
        if (prices > 1) throw new Error('later v2 turn was priced')
        return 4
      },
      calculateLocalModelSavings: () => null,
    }
    const parser = createKiroProvider().createSessionParser(source(path), seen, undefined, { pricing })
    const head = await Effect.runPromise(Stream.runHead(parserStream(parser)()))

    expect(head).toMatchObject({
      _tag: 'Some',
      value: { deduplicationKey: 'kiro-v2:v2-head:first-turn', costUSD: 4 },
    })
    expect(prices).toBe(1)
    expect(seen).toEqual(new Set(['kiro-v2:v2-head:first-turn']))
  })
})
