import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, type FileSystem } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withProviderFileSystem } from './fixtures/provider-effects.js'

const homes = vi.hoisted(() => ({ home: '' }))

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => homes.home }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat), readdir: vi.fn(actual.readdir) }
})

import { appPaths, Env, initAppPaths } from '../src/main/env.js'
import {
  antigravity,
  discoverAntigravitySessionsEffect,
  getAntigravityStatusLineEventsPath,
} from '../src/main/pipeline/providers/antigravity.js'
import type { Provider } from '../src/main/pipeline/providers/types.js'

let root = ''
let priorCacheDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-antigravity-discovery-effect-'))
  homes.home = join(root, 'home')
  priorCacheDir = appPaths().cacheDir
  initAppPaths({ cacheDir: join(root, 'cache') })
})

afterEach(() => {
  initAppPaths({ cacheDir: priorCacheDir })
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function nativeDiscovery(
  provider: Provider<FileSystem.FileSystem>,
): Provider<FileSystem.FileSystem>['discoverSessionsEffect'] {
  if (!provider.discoverSessionsEffect) throw new Error('Antigravity Effect discovery is unavailable')
  return provider.discoverSessionsEffect
}

describe('Antigravity Effect discovery', () => {
  it('sorts file names within each root and filters extensions and non-files', async () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    await writeFile(join(first, 'z.pb'), '')
    await writeFile(join(first, 'A.DB'), '')
    await mkdir(join(first, 'folder.pb'))
    await writeFile(join(first, 'ignore.json'), '')
    await writeFile(join(second, 'b.pb'), '')
    const sources = await Effect.runPromise(
      discoverAntigravitySessionsEffect([
        { dir: first, project: 'first-project', extensions: ['.pb', '.db'] },
        { dir: second, project: 'second-project', extensions: ['.pb'] },
      ]),
    )

    expect(sources).toEqual([
      { path: join(first, 'A.DB'), project: 'first-project', provider: 'antigravity' },
      { path: join(first, 'z.pb'), project: 'first-project', provider: 'antigravity' },
      { path: join(second, 'b.pb'), project: 'second-project', provider: 'antigravity' },
    ])
  })

  it('adds the statusline file last for default roots only', async () => {
    const home = homes.home
    const conversationDir = join(home, '.gemini', 'antigravity', 'conversations')
    await mkdir(conversationDir, { recursive: true })
    await mkdir(join(root, 'cache'), { recursive: true })
    await writeFile(join(conversationDir, 'conversation.pb'), '')
    await writeFile(getAntigravityStatusLineEventsPath(), '')

    const nativeSources = await Effect.runPromise(
      withProviderFileSystem(nativeDiscovery(antigravity)().pipe(Effect.provide(Env.layer))),
    )
    expect(nativeSources.map(source => source.path)).toEqual([
      join(conversationDir, 'conversation.pb'),
      getAntigravityStatusLineEventsPath(),
    ])
    expect(nativeSources.at(-1)).toEqual({
      path: getAntigravityStatusLineEventsPath(),
      project: 'antigravity-cli',
      provider: 'antigravity',
    })

    const explicitSources = await Effect.runPromise(
      discoverAntigravitySessionsEffect([{ dir: conversationDir, project: 'antigravity', extensions: ['.pb'] }]),
    )
    expect(explicitSources.map(source => source.path)).toEqual([join(conversationDir, 'conversation.pb')])
  })

  it('skips missing roots and per-file stat failures', async () => {
    const directory = join(root, 'root')
    await mkdir(directory)
    await writeFile(join(directory, 'bad.pb'), '')
    await writeFile(join(directory, 'good.pb'), '')
    vi.mocked(stat).mockImplementation(async path => {
      if (String(path).endsWith('bad.pb')) throw new Error('stat failed')
      return await vi.importActual<typeof import('fs/promises')>('fs/promises').then(fs => fs.stat(path))
    })

    const sources = await Effect.runPromise(
      discoverAntigravitySessionsEffect([
        { dir: join(root, 'missing'), project: 'missing', extensions: ['.pb'] },
        { dir: directory, project: 'present', extensions: ['.pb'] },
      ]),
    )
    expect(sources).toEqual([{ path: join(directory, 'good.pb'), project: 'present', provider: 'antigravity' }])
  })

  it('fails immediately when the scan signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stop scan'))
    await expect(
      Effect.runPromise(
        withProviderFileSystem(
          nativeDiscovery(antigravity)({ signal: controller.signal }).pipe(Effect.provide(Env.layer)),
        ),
      ),
    ).rejects.toHaveProperty('name', 'ScanAbortedError')
    expect(readdir).not.toHaveBeenCalled()
  })

  it('waits for pending stat work to settle before aborting discovery', async () => {
    const directory = join(root, 'root')
    const file = join(directory, 'conversation.pb')
    await mkdir(directory)
    await writeFile(file, '')
    let markStarted: () => void = () => undefined
    let releaseStat: () => void = () => undefined
    const started = new Promise<void>(resolveStarted => {
      markStarted = resolveStarted
    })
    vi.mocked(stat).mockImplementationOnce(async () => {
      markStarted()
      await new Promise<void>(resolveStat => {
        releaseStat = resolveStat
      })
      return await vi.importActual<typeof import('fs/promises')>('fs/promises').then(fs => fs.stat(file))
    })
    const controller = new AbortController()
    const defaultRoot = join(homes.home, '.gemini', 'antigravity', 'conversations')
    await mkdir(defaultRoot, { recursive: true })
    await writeFile(join(defaultRoot, 'conversation.pb'), '')
    let interrupted = false
    const discovery = Effect.runPromise(
      withProviderFileSystem(
        nativeDiscovery(antigravity)({ signal: controller.signal }).pipe(Effect.provide(Env.layer)),
      ),
    ).catch(error => {
      interrupted = true
      throw error
    })
    await started
    controller.abort(new Error('stop scan'))
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
    expect(interrupted).toBe(false)
    releaseStat()
    await expect(discovery).rejects.toHaveProperty('name', 'ScanAbortedError')
  })
})
