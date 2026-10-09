import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ParsedProviderCall } from '../src/main/pipeline/providers/types.js'

let root = ''
let priorCacheDir = ''

beforeEach(async () => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'watchtower-codex-cache-effect-'))
  const { appPaths, initAppPaths } = await import('../src/main/env.js')
  priorCacheDir = appPaths().cacheDir
  initAppPaths({ cacheDir: join(root, 'cache') })
})

afterEach(async () => {
  const { initAppPaths } = await import('../src/main/env.js')
  initAppPaths({ cacheDir: priorCacheDir })
  rmSync(root, { recursive: true, force: true })
})

function call(path: string): ParsedProviderCall {
  return {
    provider: 'codex',
    model: 'gpt-5',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    tools: [],
    bashCommands: [],
    timestamp: '2026-10-01T00:00:00.000Z',
    speed: 'standard',
    deduplicationKey: `codex:${path}`,
    userMessage: '',
    sessionId: 'effect-cache-session',
  }
}

describe('Codex result cache Effects', () => {
  it('uses Effect lookup and write APIs with one reusable source fingerprint', async () => {
    const { flushCodexCacheEffect, lookupCachedCodexResultsEffect, writeCachedCodexResultsEffect } =
      await import('../src/main/pipeline/codex-cache.js')
    const path = join(root, 'session.jsonl')
    await writeFile(path, 'session')
    const lookup = lookupCachedCodexResultsEffect(path)
    const cold = await Effect.runPromise(Effect.scoped(lookup))

    expect(cold.calls).toBeNull()
    expect(cold.fingerprint).not.toBeNull()
    if (!cold.fingerprint) throw new Error('Expected source fingerprint')

    const expected = [call(path)]
    await Effect.runPromise(
      Effect.scoped(writeCachedCodexResultsEffect(path, 'effect-project', expected, cold.fingerprint)),
    )
    const warm = await Effect.runPromise(Effect.scoped(lookupCachedCodexResultsEffect(path)))
    expect(warm.calls).toEqual(expected)
    await Effect.runPromise(Effect.scoped(flushCodexCacheEffect(undefined)))

    const persisted = JSON.parse(await readFile(join(root, 'cache', 'codex-results.json'), 'utf-8')) as {
      version: number
      files: Record<string, { calls: ParsedProviderCall[] }>
    }
    expect(persisted.version).toBe(8)
    expect(persisted.files[path]?.calls).toEqual(expected)

    // Reload a fresh module so this assertion exercises the persisted Schema,
    // rather than the in-memory entry populated above.
    vi.resetModules()
    const { initAppPaths } = await import('../src/main/env.js')
    initAppPaths({ cacheDir: join(root, 'cache') })
    const reloaded = await import('../src/main/pipeline/codex-cache.js')
    expect(await Effect.runPromise(reloaded.lookupCachedCodexResultsEffect(path))).toEqual({
      calls: expected,
      fingerprint: cold.fingerprint,
    })
  })

  it('treats malformed cache entries as a cache miss and reparses the session', async () => {
    const { createCodexProvider } = await import('../src/main/pipeline/providers/codex.js')
    const path = join(root, 'session-malformed-cache.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { session_id: 'malformed-cache-session', cwd: '/project', originator: 'Codex', model: 'gpt-5' },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-10-01T00:00:01.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 4, output_tokens: 2 },
              total_token_usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
            },
          },
        }),
      ].join('\n'),
    )
    const cacheDir = join(root, 'cache')
    await mkdir(cacheDir, { recursive: true })
    const stat = await (await import('node:fs/promises')).stat(path)
    await writeFile(
      join(cacheDir, 'codex-results.json'),
      JSON.stringify({
        version: 8,
        files: {
          [path]: {
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
            project: 'bad-cache',
            calls: [{ provider: 'codex', model: 12 }],
          },
        },
      }),
    )

    const parser = createCodexProvider('/unused').createSessionParser(
      { path, project: 'reparsed-project', provider: 'codex' },
      new Set(),
    )
    const calls: ParsedProviderCall[] = []
    for await (const parsed of parser.parse()) calls.push(parsed)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionId).toBe('malformed-cache-session')
    expect(calls[0]?.model).toBe('gpt-5')
  })
})
