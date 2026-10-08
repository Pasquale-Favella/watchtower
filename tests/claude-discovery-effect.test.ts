import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

import { Effect, Fiber } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

import { readdir as nativeReaddir } from 'fs/promises'

import { Env } from '../src/main/env.js'
import { claude } from '../src/main/pipeline/providers/claude.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-claude-discovery-effect-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function sourceId(path: string): string {
  return `claude-config:${createHash('sha256').update(path).digest('hex').slice(0, 16)}`
}

function discoverSessionsEffect(): NonNullable<typeof claude.discoverSessionsEffect> {
  if (!claude.discoverSessionsEffect) throw new Error('Claude Effect discovery is unavailable')
  return claude.discoverSessionsEffect
}

describe('Claude Effect discovery', () => {
  it('keeps config precedence, source metadata, and forgiving Cowork sidecar decoding', async () => {
    const configDir = join(root, 'claude-config')
    const desktopDir = join(root, 'desktop')
    const configProject = join(configDir, 'projects', 'work-project')
    const coworkProject = join(desktopDir, 'app', 'workspace', 'local_123', '.claude', 'projects', 'folder-slug')
    await mkdir(configProject, { recursive: true })
    await mkdir(coworkProject, { recursive: true })
    await writeFile(
      join(desktopDir, 'app', 'workspace', 'spaces.json'),
      JSON.stringify({ spaces: [{ id: 'space-a', name: 'Known Space' }, null, { id: 1, name: 'invalid' }] }),
    )
    await writeFile(
      join(desktopDir, 'app', 'workspace', 'local_123.json'),
      JSON.stringify({ spaceId: 'space-a', title: 17, unrelated: { invalid: true } }),
    )
    vi.stubEnv('CLAUDE_CONFIG_DIRS', configDir)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'ignored-single'))
    vi.stubEnv('WATCHTOWER_DESKTOP_SESSIONS_DIR', desktopDir)

    const discovered = await Effect.runPromise(discoverSessionsEffect()().pipe(Effect.provide(Env.layer)))
    const resolvedConfig = resolve(configDir)
    const resolvedDesktop = resolve(desktopDir)
    const desktopId = `claude-desktop:${createHash('sha256').update(resolvedDesktop).digest('hex').slice(0, 16)}`

    expect(discovered).toEqual([
      {
        path: configProject,
        project: 'work-project',
        provider: 'claude',
        sourceId: sourceId(resolvedConfig),
        sourceLabel: 'claude-config',
        sourcePath: resolvedConfig,
        sourceKind: 'claude-config',
      },
      {
        path: coworkProject,
        project: 'Known Space',
        provider: 'claude',
        sourceId: desktopId,
        sourceLabel: 'Claude Desktop',
        sourcePath: resolvedDesktop,
        sourceKind: 'claude-desktop',
      },
    ])
  })

  it('checks an already-aborted scan before starting filesystem discovery', async () => {
    const reason = new Error('stop scan')
    const controller = new AbortController()
    controller.abort(reason)
    await expect(
      Effect.runPromise(discoverSessionsEffect()({ signal: controller.signal }).pipe(Effect.provide(Env.layer))),
    ).rejects.toHaveProperty('name', 'ScanAbortedError')
  })

  it('settles the native discovery fiber when interrupted', async () => {
    const projectsDir = join(root, 'claude-config', 'projects')
    await mkdir(projectsDir, { recursive: true })
    vi.stubEnv('CLAUDE_CONFIG_DIRS', join(root, 'claude-config'))
    vi.stubEnv('WATCHTOWER_DESKTOP_SESSIONS_DIR', join(root, 'desktop-missing'))

    let markStarted: () => void = () => undefined
    let releaseRead: (entries: string[]) => void = () => undefined
    const started = new Promise<void>(resolveStarted => {
      markStarted = resolveStarted
    })
    vi.mocked(nativeReaddir).mockImplementationOnce((async (...args: Parameters<typeof nativeReaddir>) => {
      expect(String(args[0])).toBe(projectsDir)
      markStarted()
      return new Promise<string[]>(resolveRead => {
        releaseRead = resolveRead
      }) as unknown as Awaited<ReturnType<typeof nativeReaddir>>
    }) as typeof nativeReaddir)

    const fiber = Effect.runFork(discoverSessionsEffect()().pipe(Effect.provide(Env.layer)))
    await started
    let interruptionSettled = false
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interruptionSettled = true
    })
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
    expect(interruptionSettled).toBe(false)
    releaseRead([])
    await interruption
    await expect(Effect.runPromise(Fiber.join(fiber))).rejects.toBeDefined()
  })

  it('uses the platform delimiter and ignores empty config entries', async () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(join(first, 'projects'), { recursive: true })
    await mkdir(join(second, 'projects'), { recursive: true })
    vi.stubEnv('CLAUDE_CONFIG_DIRS', [first, '', second].join(delimiter))
    vi.stubEnv('WATCHTOWER_DESKTOP_SESSIONS_DIR', join(root, 'desktop-missing'))

    const discovered = await Effect.runPromise(discoverSessionsEffect()().pipe(Effect.provide(Env.layer)))
    expect(discovered).toEqual([])
  })

  it('keeps lexical paths when configured directories reach the same project through a symlink', async () => {
    const configDir = join(root, 'config')
    const configAlias = join(root, 'config-alias')
    await mkdir(join(configDir, 'projects', 'shared-project'), { recursive: true })
    await symlink(configDir, configAlias, 'junction')
    vi.stubEnv('CLAUDE_CONFIG_DIRS', [configDir, configAlias].join(delimiter))
    vi.stubEnv('WATCHTOWER_DESKTOP_SESSIONS_DIR', join(root, 'desktop-missing'))

    const discovered = await Effect.runPromise(discoverSessionsEffect()().pipe(Effect.provide(Env.layer)))
    expect(discovered.map(source => source.path)).toEqual([
      join(configDir, 'projects', 'shared-project'),
      join(configAlias, 'projects', 'shared-project'),
    ])
  })
})
