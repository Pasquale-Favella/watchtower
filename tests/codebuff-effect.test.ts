import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Cause, Effect, Exit, Option, Stream } from 'effect'
import { mkdir, writeFile } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeIo = vi.hoisted(() => ({
  home: '',
  reads: [] as string[],
  stats: [] as string[],
  readdirs: [] as string[],
  pendingPath: undefined as string | undefined,
  readStarted: undefined as (() => void) | undefined,
  releaseRead: undefined as ((value: string) => void) | undefined,
}))

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => nativeIo.home || actual.homedir() }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      nativeIo.readdirs.push(String(args[0]))
      return actual.readdir(...args)
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      nativeIo.stats.push(String(args[0]))
      return actual.stat(...args)
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0])
      nativeIo.reads.push(path)
      if (path !== nativeIo.pendingPath) return actual.readFile(...args)
      nativeIo.readStarted?.()
      return new Promise<string>(resolve => {
        nativeIo.releaseRead = resolve
      }) as ReturnType<typeof actual.readFile>
    },
  }
})

import { type AppPaths, appPaths, Env } from '../src/infrastructure/config/environment.js'
import { createCodebuffProvider } from '../src/infrastructure/provider-adapters/codebuff.js'
import type { Provider, SessionParser, SessionSource } from '../src/infrastructure/provider-adapters/types.js'
import { ScanAbortedError } from '../src/core/ingestion/reconciliation/scan-control.js'
import type { ScanPricing } from '../src/core/domain/pricing/scan-pricing.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-codebuff-effect-'))
  nativeIo.home = join(root, 'home')
  nativeIo.reads.length = 0
  nativeIo.stats.length = 0
  nativeIo.readdirs.length = 0
  nativeIo.pendingPath = undefined
  nativeIo.readStarted = undefined
  nativeIo.releaseRead = undefined
})

afterEach(() => {
  nativeIo.pendingPath = undefined
  nativeIo.readStarted = undefined
  nativeIo.releaseRead = undefined
  rmSync(root, { recursive: true, force: true })
})

function pathsWithCodebuffOverride(value: string | undefined): AppPaths {
  const current = appPaths()
  return {
    ...current,
    overrides: { ...current.overrides, CODEBUFF_DATA_DIR: value },
  }
}

function source(path: string): SessionSource {
  return { path, project: 'fixture', provider: 'codebuff' }
}

function parser(value: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!value.parseStream) throw new Error('Codebuff parser did not expose its native stream')
  return value.parseStream
}

function discovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Codebuff provider did not expose native discovery')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

function pricing(calculateCost: ScanPricing['calculateCost']): ScanPricing {
  return { calculateCost, calculateLocalModelSavings: () => null }
}

async function writeChat(
  baseDir: string,
  project: string,
  chatId: string,
  messages: unknown,
  runState?: unknown,
): Promise<string> {
  const chatDir = join(baseDir, 'projects', project, 'chats', chatId)
  await mkdir(chatDir, { recursive: true })
  await writeFile(join(chatDir, 'chat-messages.json'), JSON.stringify(messages))
  if (runState !== undefined) await writeFile(join(chatDir, 'run-state.json'), JSON.stringify(runState))
  return chatDir
}

describe('Codebuff native Effect provider', () => {
  it('discovers the default channels in filesystem order and resolves cwd project names', async () => {
    const channels = ['manicode', 'manicode-dev', 'manicode-staging']
    const chatDirs: string[] = []
    for (const channel of channels) {
      const baseDir = join(nativeIo.home, '.config', channel)
      chatDirs.push(
        await writeChat(baseDir, 'sanitized-project', '2026-01-02T03-04-05', [], {
          cwd: '/wrong/precedence',
          sessionState: {
            cwd: '/session/fallback',
            fileContext: { cwd: '/file-context/project' },
            projectContext: { cwd: '/project-context/project' },
          },
        }),
      )
    }

    const found = await Effect.runPromise(discovery(createCodebuffProvider(undefined, pathsWithCodebuffOverride(''))))
    expect(found).toEqual(chatDirs.map(path => ({ path, project: 'project', provider: 'codebuff' })))
    expect(nativeIo.reads).toEqual(chatDirs.map(path => join(path, 'run-state.json')))
    expect(nativeIo.readdirs).toEqual(
      channels.flatMap(channel => {
        const base = join(nativeIo.home, '.config', channel)
        return [join(base, 'projects'), join(base, 'projects', 'sanitized-project', 'chats')]
      }),
    )
  })

  it('captures a snapshot override at provider construction and keeps a raw empty override on the default multi-channel path', async () => {
    const selected = join(root, 'selected')
    const later = join(root, 'later')
    const selectedChat = await writeChat(selected, 'selected-project', 'chat-a', [])
    await writeChat(later, 'later-project', 'chat-b', [])
    const provider = createCodebuffProvider(undefined, pathsWithCodebuffOverride(selected))

    const priorOverride = process.env['CODEBUFF_DATA_DIR']
    process.env['CODEBUFF_DATA_DIR'] = later
    try {
      await expect(Effect.runPromise(discovery(provider))).resolves.toEqual([
        { path: selectedChat, project: 'selected-project', provider: 'codebuff' },
      ])
    } finally {
      if (priorOverride === undefined) delete process.env['CODEBUFF_DATA_DIR']
      else process.env['CODEBUFF_DATA_DIR'] = priorOverride
    }

    const defaultChat = await writeChat(join(nativeIo.home, '.config', 'manicode'), 'default-project', 'chat-c', [])
    const emptyOverrideProvider = createCodebuffProvider(undefined, pathsWithCodebuffOverride(''))
    await expect(Effect.runPromise(discovery(emptyOverrideProvider))).resolves.toContainEqual({
      path: defaultChat,
      project: 'default-project',
      provider: 'codebuff',
    })
  })

  it('treats a truthy whitespace env override as one root even though it resolves to the default path', async () => {
    const defaultChat = await writeChat(join(nativeIo.home, '.config', 'manicode'), 'default-project', 'chat-a', [])
    await writeChat(join(nativeIo.home, '.config', 'manicode-dev'), 'dev-project', 'chat-b', [])
    const provider = createCodebuffProvider(undefined, pathsWithCodebuffOverride('   '))

    await expect(Effect.runPromise(discovery(provider))).resolves.toEqual([
      { path: defaultChat, project: 'default-project', provider: 'codebuff' },
    ])
  })

  it('parses direct and historical usage, preserves raw timestamps and prompts, and maps nested tools', async () => {
    const chatDir = join(root, 'manicode', 'projects', 'demo', 'chats', '2026-01-02T03-04-05')
    await mkdir(chatDir, { recursive: true })
    const chatPath = join(chatDir, 'chat-messages.json')
    await writeFile(
      chatPath,
      JSON.stringify([
        { variant: 'user', content: 'first prompt' },
        {
          id: 'direct-call',
          variant: 'ai',
          credits: 2.5,
          timestamp: 'legacy timestamp',
          content: 'unused sibling',
          metadata: {
            model: 'preferred-model',
            modelId: 'lower-priority-model',
            usage: {
              inputTokens: 'bad',
              input_tokens: 12.8,
              promptTokens: 99,
              outputTokens: null,
              completion_tokens: 5,
              cacheReadInputTokens: 'bad',
              cache_read_input_tokens: 4,
              cacheCreationInputTokens: 2,
              ignored_broken_sibling: { deeply: ['tolerated'] },
            },
            sibling: { invalid: Symbol.for('not-json') },
          },
          blocks: [
            { type: 'tool', toolName: 'suggest_followups' },
            { type: 'agent', blocks: [{ type: 'tool', toolName: 'read_files' }] },
            {
              type: 'agent',
              blocks: [
                { type: 'tool', toolName: 'run_terminal_command', input: { command: 'git status && npm test' } },
              ],
            },
          ],
        },
        { variant: 'user', content: '' },
        {
          id: 'history-call',
          role: 'assistant',
          credits: 0,
          timestamp: null,
          metadata: {
            runState: {
              sessionState: {
                mainAgentState: {
                  messageHistory: [
                    { role: 'assistant', providerOptions: { usage: { inputTokens: 1 } } },
                    {
                      role: 'assistant',
                      providerOptions: {
                        codebuff: { model: 'history-model', usage: { prompt_tokens: 7, completion_tokens: 3 } },
                        usage: { prompt_tokens: 8, completion_tokens: 4 },
                      },
                    },
                  ],
                },
              },
            },
            unrelated: 23,
          },
        },
        { id: 'empty', variant: 'assistant', credits: 0, metadata: { usage: { inputTokens: 0 } } },
      ]),
    )

    const calculateCost = vi.fn((_model: string, _input: number, _output: number, _write: number, _read: number) => 0)
    const seen = new Set<string>()
    const value = createCodebuffProvider(root).createSessionParser(source(chatDir), seen, undefined, {
      pricing: pricing(calculateCost),
    })
    const calls = await Effect.runPromise(Stream.runCollect(parser(value)()))

    expect([...calls]).toEqual([
      {
        provider: 'codebuff',
        model: 'preferred-model',
        inputTokens: 12.8,
        outputTokens: 5,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 4,
        cachedInputTokens: 4,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.025,
        tools: ['Read', 'Bash'],
        bashCommands: ['git', 'npm'],
        timestamp: 'legacy timestamp',
        speed: 'standard',
        deduplicationKey: `codebuff:${chatDir}:direct-call`,
        userMessage: 'first prompt',
        sessionId: 'manicode/2026-01-02T03-04-05',
      },
      {
        provider: 'codebuff',
        model: 'history-model',
        inputTokens: 8,
        outputTokens: 4,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        tools: [],
        bashCommands: [],
        timestamp: new Date(2026, 0, 2, 3, 4, 5).toISOString(),
        speed: 'standard',
        deduplicationKey: `codebuff:${chatDir}:history-call`,
        userMessage: '',
        sessionId: 'manicode/2026-01-02T03-04-05',
      },
    ])
    expect(calculateCost).toHaveBeenNthCalledWith(1, 'preferred-model', 12.8, 5, 2, 4, 0)
    expect(calculateCost).toHaveBeenNthCalledWith(2, 'history-model', 8, 4, 0, 0, 0)
    expect(seen).toEqual(new Set([`codebuff:${chatDir}:direct-call`, `codebuff:${chatDir}:history-call`]))
    expect(nativeIo.stats).toEqual([])
    expect(nativeIo.reads).toEqual([chatPath])
  })

  it('uses the latest assistant history entry with usage and derives a model from agent metadata when needed', async () => {
    const chatDir = join(root, 'fixture', 'chats', 'not-a-timestamp')
    await mkdir(chatDir, { recursive: true })
    await writeFile(
      join(chatDir, 'chat-messages.json'),
      JSON.stringify([
        {
          role: 'assistant',
          metadata: {
            runState: {
              sessionState: {
                mainAgentState: {
                  agentType: 'builder',
                  messageHistory: [
                    { role: 'user', providerOptions: { usage: { inputTokens: 80 } } },
                    { role: 'assistant', providerOptions: { usage: { inputTokens: 0 } } },
                    {
                      role: 'assistant',
                      providerOptions: { usage: { promptTokensDetails: { cachedTokens: 9 } } },
                    },
                  ],
                },
              },
            },
          },
        },
      ]),
    )
    const value = createCodebuffProvider(root).createSessionParser(source(chatDir), new Set(), undefined, {
      pricing: pricing(() => 4),
    })

    const calls = await Effect.runPromise(Stream.runCollect(parser(value)()))
    expect([...calls]).toEqual([
      expect.objectContaining({
        model: 'codebuff-builder',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 9,
        timestamp: '',
        sessionId: 'not-a-timestamp',
      }),
    ])
  })

  it('keeps raw nullish model selection before validation and stringifies numeric agent types', async () => {
    const chatDir = join(root, 'projects', 'fixture', 'chats', 'chat-id')
    await mkdir(chatDir, { recursive: true })
    await writeFile(
      join(chatDir, 'chat-messages.json'),
      JSON.stringify([
        { id: 'bad-direct-model', role: 'assistant', credits: 1, metadata: { model: 42, modelId: 'sibling-model' } },
        {
          id: 'bad-stashed-model',
          role: 'assistant',
          credits: 1,
          metadata: {
            runState: {
              sessionState: {
                mainAgentState: {
                  agentType: 'builder',
                  messageHistory: [
                    {
                      role: 'assistant',
                      providerOptions: { usage: { inputTokens: 2 }, codebuff: { model: 7 } },
                    },
                  ],
                },
              },
            },
          },
        },
        { id: 'empty-selected-model', role: 'assistant', credits: 1, metadata: { model: '', modelId: 'ignored' } },
        {
          id: 'numeric-agent-type',
          role: 'assistant',
          credits: 1,
          metadata: { runState: { sessionState: { mainAgentState: { agentType: 7 } } } },
        },
      ]),
    )

    const seen = new Set<string>()
    let unparsed = 0
    const calculateCost = vi.fn(() => 0)
    const value = createCodebuffProvider(root).createSessionParser(source(chatDir), seen, undefined, {
      pricing: pricing(calculateCost),
    })
    const calls = await Effect.runPromise(
      Stream.runCollect(
        parser(value)(
          Effect.sync(() => {
            unparsed++
          }),
        ),
      ),
    )

    expect([...calls]).toEqual([
      expect.objectContaining({ model: 'codebuff', deduplicationKey: `codebuff:${chatDir}:empty-selected-model` }),
      expect.objectContaining({ model: 'codebuff-7', deduplicationKey: `codebuff:${chatDir}:numeric-agent-type` }),
    ])
    expect(unparsed).toBe(2)
    expect(calculateCost).toHaveBeenCalledTimes(2)
    expect(calculateCost).toHaveBeenNthCalledWith(1, 'codebuff', 0, 0, 0, 0, 0)
    expect(calculateCost).toHaveBeenNthCalledWith(2, 'codebuff-7', 0, 0, 0, 0, 0)
    expect(seen).toEqual(
      new Set([
        `codebuff:${chatDir}:bad-direct-model`,
        `codebuff:${chatDir}:bad-stashed-model`,
        `codebuff:${chatDir}:empty-selected-model`,
        `codebuff:${chatDir}:numeric-agent-type`,
      ]),
    )
  })

  it('returns out-of-range numeric timestamps through the typed Effect error channel', async () => {
    const chatDir = join(root, 'projects', 'fixture', 'chats', 'chat-id')
    await mkdir(chatDir, { recursive: true })
    await writeFile(
      join(chatDir, 'chat-messages.json'),
      '[{"id":"bad-date","role":"assistant","credits":1,"timestamp":1e308}]',
    )
    const value = createCodebuffProvider(root).createSessionParser(source(chatDir), new Set(), undefined, {
      pricing: pricing(() => 0),
    })

    const exit = await Effect.runPromiseExit(Stream.runCollect(parser(value)()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
      expect(error).toBeInstanceOf(RangeError)
    }
  })

  it('marks an eligible call as seen before a pricing callback failure', async () => {
    const chatDir = join(root, 'projects', 'fixture', 'chats', 'chat-id')
    await mkdir(chatDir, { recursive: true })
    await writeFile(
      join(chatDir, 'chat-messages.json'),
      JSON.stringify([{ id: 'call', role: 'assistant', credits: 1 }]),
    )
    const seen = new Set<string>()
    const pricingError = new Error('pricing failed')
    const value = createCodebuffProvider(root).createSessionParser(source(chatDir), seen, undefined, {
      pricing: pricing(() => {
        throw pricingError
      }),
    })

    await expect(Effect.runPromise(Stream.runCollect(parser(value)()))).rejects.toBe(pricingError)
    expect(seen).toEqual(new Set([`codebuff:${chatDir}:call`]))
  })

  it('uses the original array index for a missing message id and rejects non-finite JSON numbers', async () => {
    const chatDir = join(root, 'projects', 'fixture', 'chats', 'chat-id')
    await mkdir(chatDir, { recursive: true })
    await writeFile(
      join(chatDir, 'chat-messages.json'),
      '[null,{"role":"assistant","credits":1},{"role":"assistant","credits":1e999,"metadata":{"usage":{"inputTokens":1e999}}}]',
    )
    const seen = new Set<string>()
    const calculateCost = vi.fn(() => 0)
    const value = createCodebuffProvider(root).createSessionParser(source(chatDir), seen, undefined, {
      pricing: pricing(calculateCost),
    })

    const calls = await Effect.runPromise(Stream.runCollect(parser(value)()))
    expect([...calls]).toEqual([
      expect.objectContaining({
        costUSD: 0.01,
        deduplicationKey: `codebuff:${chatDir}:1`,
      }),
    ])
    expect(calculateCost).toHaveBeenCalledOnce()
    expect(seen).toEqual(new Set([`codebuff:${chatDir}:1`]))
  })

  it('waits for an owned pending read before surfacing the caller abort reason', async () => {
    const chatDir = join(root, 'projects', 'fixture', 'chats', 'chat-id')
    await mkdir(chatDir, { recursive: true })
    const chatPath = join(chatDir, 'chat-messages.json')
    nativeIo.pendingPath = chatPath
    const controller = new AbortController()
    const abortReason = new ScanAbortedError({ message: 'stop Codebuff scan' })
    let signalReadStarted: (() => void) | undefined
    const readStarted = new Promise<void>(resolve => {
      signalReadStarted = resolve
    })
    nativeIo.readStarted = () => signalReadStarted?.()
    const value = createCodebuffProvider(root).createSessionParser(source(chatDir), new Set(), undefined, {
      signal: controller.signal,
      pricing: pricing(() => 0),
    })
    let settled = false
    const result = Effect.runPromiseExit(Stream.runCollect(parser(value)())).then(exit => {
      settled = true
      return exit
    })

    await readStarted
    controller.abort(abortReason)
    await Promise.resolve()
    expect(settled).toBe(false)
    nativeIo.releaseRead?.('[]')

    const exit = await result
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(abortReason)
  })
})
