import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssistantSetup } from '../src/main/application/assistant-setup.js'
import { AssistantSetupLive } from '../src/main/assistant-setup-live.js'

const readTracker = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    readFile: (...args: Parameters<typeof original.readFile>) => {
      readTracker.paths.push(String(args[0]))
      return original.readFile(...args)
    },
  }
})

const roots: string[] = []
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'watchtower-assistant-setup-'))
  roots.push(root)
  return root
}

const get = <A>(effect: (service: AssistantSetup['Service']) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* effect(yield* AssistantSetup)
      }),
      AssistantSetupLive,
    ),
  )

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('AssistantSetupLive', () => {
  it('keeps valid MCP settings when env has the wrong shape and preserves precedence and paths', async () => {
    const home = makeRoot()
    const project = join(home, 'project')
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(project, '.claude'), { recursive: true })
    const userSettings = join(home, '.claude', 'settings.json')
    const projectSettings = join(project, '.claude', 'settings.local.json')
    writeFileSync(userSettings, JSON.stringify({ mcpServers: { 'remote:one': { alwaysLoad: true } }, env: 'bad' }))
    writeFileSync(
      projectSettings,
      JSON.stringify({ mcpServers: { 'remote:one': {} }, env: { ENABLE_TOOL_SEARCH: false } }),
    )

    const setup = await get(service => service.getOptimizeSetup([project], home))
    expect(setup.mcpConfigs.get('remote_one')).toMatchObject({
      normalized: 'remote_one',
      original: 'remote:one',
      alwaysLoadPaths: [userSettings],
    })
    expect(setup.envSettings.get('ENABLE_TOOL_SEARCH')).toEqual({
      value: 'false',
      scope: 'project local settings',
      path: projectSettings,
    })
    expect(setup.envSettings.has('ANTHROPIC_BASE_URL')).toBe(true)
  })

  it('keeps valid env when mcpServers has the wrong shape and inventories skill roots in name order', async () => {
    const home = makeRoot()
    const project = join(home, 'project')
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: 'bad', env: { ENABLE_TOOL_SEARCH: 'auto' } }),
    )
    for (const [root, names] of [
      [join(home, '.claude', 'skills'), ['zeta']],
      [join(project, '.agents', 'skills'), ['alpha']],
      [join(project, '.claude', 'skills'), ['bravo']],
    ] as const) {
      for (const name of names) {
        mkdirSync(join(root, name), { recursive: true })
        writeFileSync(join(root, name, 'SKILL.md'), '# skill')
      }
    }

    const setup = await get(service => service.getOptimizeSetup([project], home))
    const inventory = await get(service => service.getSkillInventory([project], home))
    expect(setup.mcpConfigs.size).toBe(0)
    expect(setup.envSettings.get('ENABLE_TOOL_SEARCH')?.value).toBe('auto')
    expect(inventory.map(entry => entry.name)).toEqual(['alpha', 'bravo', 'zeta'])
    expect(inventory.map(entry => entry.root)).toEqual([
      join(project, '.agents', 'skills'),
      join(project, '.claude', 'skills'),
      join(home, '.claude', 'skills'),
    ])
  })

  it('reads each config file once within an Optimize setup request', async () => {
    const home = makeRoot()
    const project = join(home, 'project')
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ENABLE_TOOL_SEARCH: 'true' } }))
    writeFileSync(join(home, '.claude', 'settings.local.json'), '{}')
    writeFileSync(join(project, '.mcp.json'), '{}')
    writeFileSync(join(project, '.claude', 'settings.json'), '{}')
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{}')

    readTracker.paths.length = 0
    const setup = await get(service => service.getOptimizeSetup([project], home))
    expect(setup.envSettings.get('ENABLE_TOOL_SEARCH')?.value).toBe('true')
    expect(setup.mcpConfigs.size).toBe(0)
    for (const path of [
      join(home, '.claude', 'settings.json'),
      join(home, '.claude', 'settings.local.json'),
      join(project, '.mcp.json'),
      join(project, '.claude', 'settings.json'),
      join(project, '.claude', 'settings.local.json'),
    ])
      expect(readTracker.paths.filter(readPath => readPath === path)).toHaveLength(1)
  })
})
