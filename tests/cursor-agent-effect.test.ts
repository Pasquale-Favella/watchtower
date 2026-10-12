import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Stream } from 'effect'
import { mkdir, writeFile } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ stats: [] as string[] }))
const streamHooks = vi.hoisted(() => ({
  pausePath: undefined as string | undefined,
  onOpenStarted: undefined as (() => void) | undefined,
  releaseOpen: undefined as (() => void) | undefined,
  opened: [] as string[],
  closed: [] as string[],
  fileByDescriptor: new Map<number, string>(),
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    createReadStream: (
      path: Parameters<typeof actual.createReadStream>[0],
      options?: Parameters<typeof actual.createReadStream>[1],
    ) => {
      const streamOptions = typeof options === 'object' && options !== null ? options : {}
      return actual.createReadStream(path, {
        ...streamOptions,
        fs: {
          ...actual,
          open: (filePath, flags, mode, callback) => {
            const open = () => {
              const complete = (error: NodeJS.ErrnoException | null, descriptor: number) => {
                if (!error) {
                  streamHooks.opened.push(String(filePath))
                  streamHooks.fileByDescriptor.set(descriptor, String(filePath))
                }
                if (typeof mode === 'function') mode(error, descriptor)
                else callback?.(error, descriptor)
              }
              if (typeof mode === 'function') actual.open(filePath, flags, complete)
              else actual.open(filePath, flags, mode, complete)
            }
            if (streamHooks.pausePath === String(filePath)) {
              streamHooks.pausePath = undefined
              streamHooks.releaseOpen = open
              streamHooks.onOpenStarted?.()
              return
            }
            open()
          },
          close: (descriptor, callback) => {
            streamHooks.closed.push(streamHooks.fileByDescriptor.get(descriptor) ?? '')
            return actual.close(descriptor, callback)
          },
        },
      })
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      io.stats.push(String(args[0]))
      return actual.stat(...args)
    },
  }
})

import { Env } from '../src/main/env.js'
import { createCursorAgentProvider } from '../src/main/pipeline/providers/cursor-agent.js'
import type { ParsedProviderCall, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-cursor-agent-effect-'))
  io.stats.length = 0
  streamHooks.pausePath = undefined
  streamHooks.onOpenStarted = undefined
  streamHooks.releaseOpen = undefined
  streamHooks.opened.length = 0
  streamHooks.closed.length = 0
  streamHooks.fileByDescriptor.clear()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function write(path: string, value: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, value)
}

function source(path: string): SessionSource {
  return { path, project: 'fixture-project', provider: 'cursor-agent' }
}

function nativeParser(parser: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!parser.parseStream) throw new Error('Cursor Agent parser did not expose parseStream')
  return parser.parseStream
}

async function collect(parser: SessionParser, onUnparsedCall?: Effect.Effect<void>): Promise<ParsedProviderCall[]> {
  return Effect.runPromise(Stream.runCollect(nativeParser(parser)(onUnparsedCall)))
}

describe('Cursor Agent native Effect path', () => {
  it('discovers recursive transcripts, keeps JSONL precedence, and keeps subagents as separate sources', async () => {
    const uuidDir = join(root, 'projects', 'work-project', 'agent-transcripts', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    await write(join(uuidDir, 'conversation.txt'), 'user: <user_query>legacy</user_query>\nA: legacy answer')
    await write(
      join(uuidDir, 'conversation.jsonl'),
      `${JSON.stringify({ role: 'user', message: { content: 'jsonl prompt' } })}\n${JSON.stringify({ role: 'assistant', message: { content: 'jsonl answer' } })}`,
    )
    await write(join(uuidDir, 'subagents', 'child.txt'), 'user: <user_query>child</user_query>\nA: child answer')
    await write(
      join(root, 'projects', 'agent-transcripts', 'legacy.txt'),
      'user: <user_query>root</user_query>\nA: root answer',
    )

    const provider = createCursorAgentProvider(root)
    const discover = provider.discoverSessionsEffect
    if (!discover) throw new Error('Cursor Agent provider did not expose native discovery')
    const sources = await Effect.runPromise(discover().pipe(Effect.provide(Env.layer)))

    expect(sources.map(item => item.path).sort()).toEqual(
      [
        join(uuidDir, 'subagents', 'child.txt'),
        join(uuidDir, 'conversation.jsonl'),
        join(root, 'projects', 'agent-transcripts', 'legacy.txt'),
      ].sort(),
    )
    expect(sources.map(item => item.project)).toEqual(expect.arrayContaining(['project', 'transcripts']))
    const seen = new Set<string>()
    const calls: ParsedProviderCall[] = []
    for (const item of sources) {
      calls.push(...(await collect(provider.createSessionParser(item, seen))))
    }
    expect(calls).toHaveLength(3)
    expect(new Set(calls.map(call => call.deduplicationKey)).size).toBe(3)
  })

  it('streams JSONL calls, keeps valid content siblings, and tallies malformed consumed fields', async () => {
    const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const path = join(root, `${id}.jsonl`)
    await write(
      path,
      [
        '{invalid json',
        JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'prompt' }, { future: true }] } }),
        JSON.stringify({
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: 7 },
              { type: 'text', text: 'answer' },
              { type: 'tool_use', name: 'BASH' },
            ],
          },
          futureSibling: { ignored: true },
        }),
      ].join('\n'),
    )
    const tally = vi.fn(() => Effect.sync(() => undefined))
    const calls = await collect(
      createCursorAgentProvider(root).createSessionParser(source(path), new Set()),
      Effect.suspend(() => tally()),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userMessage: 'prompt', tools: ['cursor:bash'], sessionId: id })
    expect(calls[0]?.outputTokens).toBeGreaterThan(0)
    expect(tally).toHaveBeenCalledOnce()
  })

  it('retains legacy text grouping and warns only once for unrecognized files', async () => {
    const path = join(root, 'legacy.txt')
    await write(
      path,
      'user: <user_query>first prompt</user_query>\r\nA: [Thinking] reason\r\nanswer\r\nabc\r\n\r\nd\r\n[Tool call] Shell',
    )
    const provider = createCursorAgentProvider(root)
    const calls = await collect(provider.createSessionParser(source(path), new Set()))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userMessage: 'first prompt', tools: ['cursor:shell'] })
    expect(calls[0]?.reasoningTokens).toBeGreaterThan(0)
    expect(calls[0]?.outputTokens).toBe(4)
  })

  it('uses consumed summary fields without the mtime fallback or unused title validation', async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const path = join(root, `${id}.txt`)
    await write(path, 'user: <user_query>prompt</user_query>\nA: answer')
    const dbDir = join(root, 'ai-tracking')
    await mkdir(dbDir, { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dbDir, 'ai-code-tracking.db'))
    db.exec('CREATE TABLE conversation_summaries (conversationId TEXT, model TEXT, title TEXT, updatedAt TEXT)')
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run(
      id,
      'summary-model',
      'fixture',
      '2026-10-01T00:00:00.000Z',
    )
    db.exec("UPDATE conversation_summaries SET title = CAST(X'FF' AS TEXT)")
    db.close()

    const calls = await collect(createCursorAgentProvider(root).createSessionParser(source(path), new Set()))

    expect(calls[0]?.timestamp).toBe('2026-10-01T00:00:00.000Z')
    expect(calls[0]?.model).toBe('summary-model')
    expect(io.stats.filter(item => item === path)).toHaveLength(0)
  })

  it('reads mtime only when no summary timestamp is available and a call can be emitted', async () => {
    const path = join(root, 'fallback.txt')
    await write(path, 'user: <user_query>prompt</user_query>\nA: answer')
    await collect(createCursorAgentProvider(root).createSessionParser(source(path), new Set()))
    expect(io.stats.filter(item => item === path)).toHaveLength(1)

    const unrecognizedPath = join(root, 'unrecognized.txt')
    await write(unrecognizedPath, 'no known transcript markers')
    await collect(createCursorAgentProvider(root).createSessionParser(source(unrecognizedPath), new Set()))
    expect(io.stats.filter(item => item === unrecognizedPath)).toHaveLength(0)
  })

  it('does not turn invalid selected model metadata into the automatic fallback', async () => {
    const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    const path = join(root, `${id}.txt`)
    await write(path, 'user: <user_query>prompt</user_query>\nA: answer')
    const dbDir = join(root, 'ai-tracking')
    await mkdir(dbDir, { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dbDir, 'ai-code-tracking.db'))
    db.exec('CREATE TABLE conversation_summaries (conversationId TEXT, model, title TEXT, updatedAt TEXT)')
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run(id, 12, 'fixture', '2026-10-01')
    db.close()
    const tally = vi.fn(() => Effect.void)

    const calls = await collect(
      createCursorAgentProvider(root).createSessionParser(source(path), new Set()),
      Effect.suspend(() => tally()),
    )

    expect(calls).toEqual([])
    expect(tally).toHaveBeenCalledOnce()
  })

  it('stops parsing and closes the transcript reader when the consumer takes one call', async () => {
    const path = join(root, 'early-stop.txt')
    await write(
      path,
      'user: <user_query>first prompt</user_query>\nA: first answer\nuser: <user_query>second prompt</user_query>\nA: second answer',
    )
    const calculateCost = vi.fn(() => 1)
    const parser = createCursorAgentProvider(root).createSessionParser(source(path), new Set(), undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    const stream = nativeParser(parser)
    const calls = await Effect.runPromise(stream().pipe(Stream.take(1), Stream.runCollect))

    expect(calls).toHaveLength(1)
    expect(calculateCost).toHaveBeenCalledOnce()
    expect(streamHooks.opened).toEqual([path])
    expect(streamHooks.closed).toEqual([path])
  })

  it('drains a pending stream open and releases its file on abort', async () => {
    const path = join(root, 'abort.txt')
    await write(path, 'user: <user_query>prompt</user_query>\nA: answer')
    streamHooks.pausePath = path
    let markOpenStarted!: () => void
    const openStarted = new Promise<void>(resolve => (markOpenStarted = resolve))
    streamHooks.onOpenStarted = markOpenStarted
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'stop transcript read' })
    const calculateCost = vi.fn(() => 1)
    const parser = createCursorAgentProvider(root).createSessionParser(source(path), new Set(), undefined, {
      signal: controller.signal,
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    const running = Effect.runPromise(Stream.runCollect(nativeParser(parser)()))
    const rejection = expect(running).rejects.toBe(abort)

    await openStarted
    controller.abort(abort)
    streamHooks.releaseOpen?.()
    await rejection

    expect(calculateCost).not.toHaveBeenCalled()
    expect(streamHooks.opened).toEqual([path])
    expect(streamHooks.closed).toEqual([path])
  })
})
