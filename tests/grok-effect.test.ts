import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { Effect, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ioHooks = vi.hoisted(() => ({
  readdirPath: undefined as string | undefined,
  onReaddirStarted: undefined as (() => void) | undefined,
  releaseReaddir: undefined as (() => void) | undefined,
  onReaderOpen: undefined as (() => void) | undefined,
  onReaderClose: undefined as (() => void) | undefined,
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const reader = actual.createReadStream(...args)
      reader.once('open', () => ioHooks.onReaderOpen?.())
      reader.once('close', () => ioHooks.onReaderClose?.())
      return reader
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]) !== ioHooks.readdirPath) return actual.readdir(...args)
      ioHooks.onReaddirStarted?.()
      await new Promise<void>(resolve => {
        ioHooks.releaseReaddir = resolve
      })
      return actual.readdir(...args)
    },
  }
})

import { Env } from '../src/main/env.js'
import { createGrokProvider } from '../src/main/pipeline/providers/grok.js'
import type { ParsedProviderCall, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const directories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-grok-effect-'))
  directories.push(directory)
  return directory
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value))
}

function writeUpdates(path: string, values: unknown[]): void {
  writeFileSync(path, `${values.map(value => JSON.stringify(value)).join('\n')}\n`)
}

function createSession(root: string, name = 'session-one'): { sessionDir: string; source: SessionSource } {
  const sessionDir = join(root, encodeURIComponent('/work/example'), name)
  mkdirSync(sessionDir, { recursive: true })
  return {
    sessionDir,
    source: { path: join(sessionDir, 'updates.jsonl'), project: 'example', provider: 'grok' },
  }
}

async function parseStream(
  source: SessionSource,
  seen = new Set<string>(),
  context?: { signal?: AbortSignal; pricing?: ScanPricing },
): Promise<ParsedProviderCall[]> {
  const parser = createGrokProvider().createSessionParser(source, seen, undefined, context)
  const stream = parser.parseStream
  if (!stream) throw new Error('Grok parser must expose parseStream')
  return Array.from(await Effect.runPromise(Stream.runCollect(stream())))
}

afterEach(() => {
  ioHooks.readdirPath = undefined
  ioHooks.onReaddirStarted = undefined
  ioHooks.releaseReaddir = undefined
  ioHooks.onReaderOpen = undefined
  ioHooks.onReaderClose = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Grok native Effect provider', () => {
  it('discovers valid sessions through its native Effect and preserves decoded project identity', async () => {
    const root = tempDirectory()
    const session = createSession(root)
    writeJson(join(session.sessionDir, 'summary.json'), { info: { id: 'session-id', cwd: '/projects/decoded name' } })
    mkdirSync(join(root, 'not-a-directory.json'))

    const discover = createGrokProvider(root).discoverSessionsEffect
    if (!discover) throw new Error('Grok provider must expose native discovery')
    const found = await Effect.runPromise(discover().pipe(Effect.provide(Env.layer)))
    expect(found).toEqual([{ path: session.source.path, project: 'decoded name', provider: 'grok' }])
  })

  it('streams updates into compaction-aware estimates, validates consumed fields independently, and captures pricing', async () => {
    const root = tempDirectory()
    const { sessionDir, source } = createSession(root)
    writeJson(join(sessionDir, 'summary.json'), {
      info: { id: 'grok-session', cwd: '/work/project' },
      current_model_id: 42,
      updated_at: '2026-04-01T12:30:00Z',
      session_summary: 'user request',
      ignored_extension: { anything: true },
    })
    writeJson(join(sessionDir, 'signals.json'), {
      primaryModelId: false,
      modelsUsed: ['fallback-model', 17],
      toolsUsed: [4],
    })
    writeUpdates(source.path, [
      { params: { _meta: { totalTokens: 100, promptId: 'turn-1' } } },
      { params: { _meta: { totalTokens: 130, promptId: 'turn-1' } } },
      {
        params: {
          _meta: { totalTokens: 'bad-counter' },
          update: { sessionUpdate: 'tool_call', title: 'run_terminal_command', rawInput: { command: 'git status' } },
          ignored: 'extension field',
        },
      },
      { params: { _meta: { totalTokens: 140, promptId: 'turn-2' } } },
      { params: { _meta: { totalTokens: 150, promptId: 'turn-2' } } },
      {
        params: {
          _meta: { totalTokens: 150, promptId: 'turn-2' },
          update: { sessionUpdate: 23, title: 'must-not-parse' },
        },
      },
      { params: { _meta: { totalTokens: 60, promptId: 'turn-3' } } },
      { params: { _meta: { totalTokens: 80, promptId: 'turn-3' } } },
      {
        params: {
          _meta: { totalTokens: 80, promptId: 'turn-3' },
          update: { sessionUpdate: 'tool_call', title: 'spawn_subagent', rawInput: { subagent_type: 'explore' } },
        },
      },
      '{malformed json',
    ])

    const calculations: unknown[][] = []
    const pricing: ScanPricing = {
      calculateCost: (...args) => {
        calculations.push(args)
        return 7.25
      },
      calculateLocalModelSavings: () => null,
    }
    const calls = await parseStream(source, new Set(), { pricing })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call).toMatchObject({
      provider: 'grok',
      model: 'fallback-model',
      inputTokens: 230,
      outputTokens: 60,
      cacheReadInputTokens: 70,
      cachedInputTokens: 70,
      costUSD: 7.25,
      costIsEstimated: true,
      tools: ['Bash', 'Agent'],
      bashCommands: ['git'],
      subagentTypes: ['explore'],
      timestamp: '2026-04-01T12:30:00Z',
      deduplicationKey: `grok:${sessionDir}:2026-04-01T12:30:00Z:grok-session`,
      userMessage: 'user request',
      sessionId: 'grok-session',
      project: 'example',
      projectPath: '/work/project',
    })
    expect(calculations).toEqual([['fallback-model', 230, 60, 0, 70, 0]])
  })

  it('keeps valid legacy defaults when optional metadata is null and admits each consumed dedup key once', async () => {
    const root = tempDirectory()
    const { sessionDir, source } = createSession(root)
    writeJson(join(sessionDir, 'summary.json'), {
      info: { id: null, cwd: null },
      created_at: null,
      current_model_id: null,
      generated_title: 'generated title',
    })
    writeUpdates(source.path, [
      { params: { _meta: { totalTokens: 50, promptId: 'turn' } } },
      { params: { _meta: { totalTokens: 75, promptId: 'turn' } } },
    ])

    const seen = new Set<string>()
    const first = await parseStream(source, seen)
    const repeated = await parseStream(source, seen)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      model: 'grok-build',
      inputTokens: 75,
      outputTokens: 25,
      cacheReadInputTokens: 0,
      timestamp: '',
      sessionId: basename(sessionDir),
      userMessage: 'generated title',
    })
    expect(repeated).toEqual([])
  })

  it('preserves the exact caller abort reason at the native discovery boundary', async () => {
    const root = tempDirectory()
    const controller = new AbortController()
    const reason = new ScanAbortedError({ message: 'stop Grok scan' })
    controller.abort(reason)

    const discover = createGrokProvider(root).discoverSessionsEffect
    if (!discover) throw new Error('Grok provider must expose native discovery')
    await expect(
      Effect.runPromise(discover({ signal: controller.signal }).pipe(Effect.provide(Env.layer))),
    ).rejects.toBe(reason)
  })

  it('does not finish an interrupted discovery until its pending filesystem call settles', async () => {
    const root = tempDirectory()
    const controller = new AbortController()
    const reason = new ScanAbortedError({ message: 'stop during Grok directory read' })
    ioHooks.readdirPath = root
    const readdirStarted = new Promise<void>(resolve => {
      ioHooks.onReaddirStarted = resolve
    })
    const discover = createGrokProvider(root).discoverSessionsEffect
    if (!discover) throw new Error('Grok provider must expose native discovery')
    let settled = false
    const pending = Effect.runPromise(discover({ signal: controller.signal }).pipe(Effect.provide(Env.layer))).finally(
      () => {
        settled = true
      },
    )
    const outcome = pending.then(
      () => null,
      error => error,
    )

    await readdirStarted
    controller.abort(reason)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    ioHooks.releaseReaddir?.()
    expect(await outcome).toBe(reason)
    expect(settled).toBe(true)
  })

  it('closes the owned update reader before the completed Effect returns', async () => {
    const root = tempDirectory()
    const { sessionDir, source } = createSession(root)
    writeJson(join(sessionDir, 'summary.json'), { info: { id: 'reader-close' } })
    writeUpdates(source.path, [
      { params: { _meta: { totalTokens: 10, promptId: 'turn' } } },
      { params: { _meta: { totalTokens: 20, promptId: 'turn' } } },
    ])

    let opened = 0
    let closed = 0
    ioHooks.onReaderOpen = () => {
      opened++
    }
    ioHooks.onReaderClose = () => {
      closed++
    }
    expect(await parseStream(source)).toHaveLength(1)
    expect(opened).toBe(1)
    expect(closed).toBe(1)
    rmSync(source.path)
  })

  it('closes the acquired update reader before returning the caller abort reason', async () => {
    const root = tempDirectory()
    const { sessionDir, source } = createSession(root)
    writeJson(join(sessionDir, 'summary.json'), { info: { id: 'cancel-during-read' } })
    writeUpdates(source.path, [{ params: { _meta: { totalTokens: 100, promptId: 'turn' } } }])
    const controller = new AbortController()
    const reason = new ScanAbortedError({ message: 'stop while reading updates' })
    let closed = 0
    ioHooks.onReaderOpen = () => controller.abort(reason)
    ioHooks.onReaderClose = () => {
      closed++
    }
    const pending = parseStream(source, new Set(), { signal: controller.signal })

    await expect(pending).rejects.toBe(reason)
    expect(closed).toBe(1)
    rmSync(source.path)
  })
})
