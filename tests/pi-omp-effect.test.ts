import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Stream } from 'effect'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  afterRead: undefined as (() => void) | undefined,
  finalized: false,
}))

vi.mock('../src/main/pipeline/fs-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/fs-utils.js')>()
  return {
    ...actual,
    readSessionLinesStream: (...args: Parameters<typeof actual.readSessionLinesStream>) => {
      const source = actual.readSessionLinesStream(...args)
      return source.pipe(
        Stream.tap(() => Effect.sync(() => hooks.afterRead?.())),
        Stream.ensuring(Effect.sync(() => (hooks.finalized = true))),
      )
    },
  }
})

import { createOmpProvider, createPiProvider } from '../src/main/pipeline/providers/pi.js'
import type { ProviderScanContext, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'watchtower-pi-omp-effect-'))
  hooks.afterRead = undefined
  hooks.finalized = false
})

afterEach(async () => {
  hooks.afterRead = undefined
  await rm(root, { recursive: true, force: true })
})

const session = (cwd = '/work/project', id = 'session-1') => JSON.stringify({ type: 'session', id, cwd })

async function createSessionFile(base: string, name: string, contents: string): Promise<string> {
  const directory = join(base, 'encoded-project')
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, contents)
  return path
}

async function collect(source: SessionSource, provider = createPiProvider(root)) {
  const parser = provider.createSessionParser(source, new Set())
  const parseStream = parser.parseStream
  if (!parseStream) throw new Error('Pi parser is missing its native Stream')
  return Array.from(await Effect.runPromise(Stream.runCollect(parseStream())))
}

function discover(provider: ReturnType<typeof createPiProvider>, context?: ProviderScanContext) {
  const discoverEffect = provider.discoverSessionsEffect
  if (!discoverEffect) throw new Error('Pi provider is missing native discovery')
  return Effect.runPromise(discoverEffect(context))
}

describe('Pi and OMP Effect workflows', () => {
  it.each([
    ['pi', createPiProvider],
    ['omp', createOmpProvider],
  ] as const)('%s discovers only files whose first record is a session', async (name, makeProvider) => {
    const dir = join(root, name)
    const validPath = await createSessionFile(dir, 'valid.jsonl', `${session('/work/checkout')}\n`)
    const fallbackPath = await createSessionFile(
      dir,
      'fallback.jsonl',
      `${JSON.stringify({ type: 'session', cwd: null })}\n`,
    )
    await createSessionFile(dir, 'wrong-first.jsonl', `${JSON.stringify({ type: 'message' })}\n${session()}\n`)
    await createSessionFile(dir, 'bad-first.jsonl', '{not json}\n')

    const provider = makeProvider(dir)
    const expectedSources = [
      {
        path: validPath,
        project: 'checkout',
        provider: name,
        workingDirectory: '/work/checkout',
      },
      { path: fallbackPath, project: 'encoded-project', provider: name },
    ]
    const nativeSources = await discover(provider)
    expect(nativeSources).toHaveLength(expectedSources.length)
    expect(nativeSources).toEqual(expect.arrayContaining(expectedSources))
    const promiseSources = await provider.discoverSessions()
    expect(promiseSources).toHaveLength(expectedSources.length)
    expect(promiseSources).toEqual(expect.arrayContaining(expectedSources))
  })

  it('decodes each nonempty JSONL record with Schema and preserves call extraction', async () => {
    const path = await createSessionFile(
      root,
      'parse.jsonl',
      [
        session('/work/project', 'real-session'),
        '{malformed}',
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
        JSON.stringify({
          type: 'message',
          id: 'fallback-id',
          timestamp: '2026-10-01T00:00:00Z',
          message: {
            role: 'assistant',
            content: [
              null,
              42,
              'malformed sibling',
              { type: 'toolCall', name: 'read', arguments: { path: '/work/.agents/skills/clean/SKILL.md' } },
              { type: 'toolCall', name: 'bash', arguments: { command: 'git status --short' } },
            ],
            usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 },
          },
        }),
        JSON.stringify({
          type: 'message',
          message: { role: 'assistant', usage: { input: 'bad-token-count', output: 20 } },
        }),
        JSON.stringify({
          type: 'message',
          id: null,
          timestamp: null,
          message: {
            role: 'assistant',
            model: null,
            responseId: null,
            content: null,
            usage: { input: null, output: 2, cacheRead: null },
          },
        }),
      ].join('\n'),
    )
    const source: SessionSource = { path, project: 'project', provider: 'pi', workingDirectory: '/work/project' }
    const calls = await collect(source)

    expect(calls).toHaveLength(2)
    expect(calls.at(0)).toMatchObject({
      provider: 'pi',
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
      tools: ['Skill', 'Bash'],
      skills: ['clean'],
      bashCommands: ['git'],
      deduplicationKey: `pi:${path}:fallback-id`,
      sessionId: 'real-session',
      projectPath: '/work/project',
      workingDirectory: '/work/project',
      userMessage: 'hello',
    })
    expect(calls[1]).toMatchObject({
      model: 'gpt-5',
      deduplicationKey: `pi:${path}:5`,
      inputTokens: 0,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  })

  it('preserves the abort reason and closes the line stream on interruption', async () => {
    const path = await createSessionFile(
      root,
      'cancel.jsonl',
      `${session()}\n${JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 1, output: 1 } } })}\n`,
    )
    const reason = new ScanAbortedError({ message: 'stop Pi scan' })
    const controller = new AbortController()
    const source: SessionSource = { path, project: 'project', provider: 'pi' }
    const parser = createPiProvider(root).createSessionParser(source, new Set(), undefined, {
      signal: controller.signal,
    })
    hooks.afterRead = () => controller.abort(reason)

    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('Pi parser is missing its native Stream')
    await expect(Effect.runPromise(Stream.runCollect(parseStream()))).rejects.toBe(reason)
    expect(hooks.finalized).toBe(true)
  })

  it('preserves the discovery abort reason', async () => {
    const reason = new ScanAbortedError({ message: 'stop Pi discovery' })
    const controller = new AbortController()
    controller.abort(reason)

    await expect(discover(createPiProvider(root), { signal: controller.signal })).rejects.toBe(reason)
  })
})
