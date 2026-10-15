import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ firstLineReaderEvents: [] as string[] }))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      const path = String(args[0])
      hooks.firstLineReaderEvents.push(`open:${path}`)
      stream.once('close', () => hooks.firstLineReaderEvents.push(`close:${path}`))
      return stream
    },
  }
})

import { appPaths, Env, initAppPaths } from '../src/main/env.js'
import { createCodexProvider } from '../src/main/pipeline/providers/codex.js'
import type { Provider } from '../src/main/pipeline/providers/types.js'

let root = ''
let priorCacheDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-codex-discovery-effect-'))
  priorCacheDir = appPaths().cacheDir
  initAppPaths({ cacheDir: join(root, 'cache') })
  hooks.firstLineReaderEvents.length = 0
})

afterEach(() => {
  initAppPaths({ cacheDir: priorCacheDir })
  rmSync(root, { recursive: true, force: true })
})

async function writeSession(path: string, cwd: string, originator = 'Codex CLI'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd, originator, session_id: 'discovery-session' } })}\n{}`,
  )
}

function nativeDiscovery(provider: Provider): ReturnType<NonNullable<Provider['discoverSessionsEffect']>> {
  if (!provider.discoverSessionsEffect) throw new Error('Codex Effect discovery is unavailable')
  return provider.discoverSessionsEffect()
}

describe('Codex Effect discovery', () => {
  it('recursively discovers dated and archived sessions and filters invalid names and headers', async () => {
    const codexHome = join(root, 'codex-home')
    const dated = join(codexHome, 'sessions', '2026', '10', '08', 'rollout-valid.jsonl')
    const archived = join(codexHome, 'archived_sessions', 'rollout-archived.jsonl')
    const invalidOrigin = join(codexHome, 'sessions', '2026', '10', '08', 'rollout-other.jsonl')
    const ignoredName = join(codexHome, 'sessions', '2026', '10', '08', 'other.jsonl')
    await writeSession(dated, '/work/project-one')
    await writeSession(archived, 'C:\\work\\project-two')
    await writeSession(invalidOrigin, '/work/other', 'not-codex')
    await writeSession(ignoredName, '/work/ignored')

    const provider = createCodexProvider(codexHome)
    const sources = await Effect.runPromise(nativeDiscovery(provider).pipe(Effect.provide(Env.layer)))

    expect(sources).toEqual([
      {
        path: dated,
        project: 'work-project-one',
        provider: 'codex',
        workingDirectory: '/work/project-one',
      },
      {
        path: archived,
        project: 'C:-work-project-two',
        provider: 'codex',
        workingDirectory: 'C:\\work\\project-two',
      },
    ])
  })

  it('uses the home configured after provider construction', async () => {
    const codexHome = join(root, 'late-codex-home')
    const session = join(codexHome, 'sessions', '2026', '10', '08', 'rollout-late.jsonl')
    await writeSession(session, '/late/project')
    const provider = createCodexProvider()

    initAppPaths({ cacheDir: join(root, 'cache'), codexHome })
    await expect(Effect.runPromise(nativeDiscovery(provider).pipe(Effect.provide(Env.layer)))).resolves.toMatchObject([
      { path: session, project: 'late-project' },
    ])
  })

  it('closes each first-line reader before opening the next session reader', async () => {
    const codexHome = join(root, 'ordered-codex-home')
    const first = join(codexHome, 'sessions', '2026', '10', '08', 'rollout-first.jsonl')
    const second = join(codexHome, 'sessions', '2026', '10', '08', 'rollout-second.jsonl')
    await writeSession(first, '/work/first')
    await writeSession(second, '/work/second')

    const sources = await Effect.runPromise(
      nativeDiscovery(createCodexProvider(codexHome)).pipe(Effect.provide(Env.layer)),
    )

    expect(sources).toHaveLength(2)
    expect(hooks.firstLineReaderEvents).toEqual(
      sources.flatMap(source => [`open:${source.path}`, `close:${source.path}`]),
    )
  })
})
