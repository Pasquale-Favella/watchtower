import { readFileSync, statSync } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { AssistantSetup } from './application/assistant-setup.js'
import type { DeferralEnvHit, McpConfigEntry, OptimizeSetup, SkillInventoryEntry } from './setup-facts.js'

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
type Config = { mcpServers?: Record<string, unknown>; env?: Record<string, unknown> }

class SetupIoError extends Schema.TaggedError<SetupIoError>()('SetupIoError', { path: Schema.String }) {}

const readText = (path: string) =>
  Effect.tryPromise({ try: () => readFile(path, 'utf8'), catch: () => new SetupIoError({ path }) }).pipe(
    Effect.catchTag('SetupIoError', () => Effect.succeed(null as string | null)),
  )

const readMtime = (path: string) =>
  Effect.tryPromise({ try: async () => (await stat(path)).mtimeMs, catch: () => new SetupIoError({ path }) }).pipe(
    Effect.catchTag('SetupIoError', () => Effect.succeed(0)),
  )

const listNames = (path: string) =>
  Effect.tryPromise({ try: () => readdir(path), catch: () => new SetupIoError({ path }) }).pipe(
    Effect.catchTag('SetupIoError', () => Effect.succeed([] as string[])),
  )

const exists = (path: string) =>
  Effect.tryPromise({ try: () => access(path), catch: () => new SetupIoError({ path }) }).pipe(
    Effect.map(() => true),
    Effect.catchTag('SetupIoError', () => Effect.succeed(false)),
  )

const parseConfig = (text: string | null): Config | null => {
  if (text === null) return null
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const root = Schema.decodeUnknownResult(JsonRecordSchema)(json)
  if (root._tag !== 'Success') return null
  const servers =
    root.success.mcpServers === undefined
      ? undefined
      : Schema.decodeUnknownResult(JsonRecordSchema)(root.success.mcpServers)
  const env =
    root.success.env === undefined ? undefined : Schema.decodeUnknownResult(JsonRecordSchema)(root.success.env)
  return {
    ...(servers?._tag === 'Success' ? { mcpServers: servers.success } : {}),
    ...(env?._tag === 'Success' ? { env: env.success } : {}),
  }
}

const environmentNames = ['ENABLE_TOOL_SEARCH', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_VERTEX'] as const
const shellProfiles = ['.zshrc', '.bashrc', '.bash_profile', '.profile'] as const

function configPaths(projectDirs: readonly string[], home: string): string[] {
  const paths = [join(home, '.claude', 'settings.json'), join(home, '.claude', 'settings.local.json')]
  for (const cwd of projectDirs) {
    paths.push(
      join(cwd, '.mcp.json'),
      join(cwd, '.claude', 'settings.json'),
      join(cwd, '.claude', 'settings.local.json'),
    )
  }
  return [...new Set(paths)]
}

function envScopes(projectDirs: readonly string[], home: string): Array<{ scope: string; path: string }> {
  const scopes: Array<{ scope: string; path: string }> = []
  for (const cwd of projectDirs) {
    scopes.push({ scope: 'project local settings', path: join(cwd, '.claude', 'settings.local.json') })
    scopes.push({ scope: 'project settings', path: join(cwd, '.claude', 'settings.json') })
  }
  scopes.push({ scope: 'user local settings', path: join(home, '.claude', 'settings.local.json') })
  scopes.push({ scope: 'user settings', path: join(home, '.claude', 'settings.json') })
  return scopes
}

function shellValue(text: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`^\\s*(?:export\\s+)?${escapedName}\\s*=\\s*['"]?([^'"\\s]+)['"]?`, 'm'))
  return match?.[1] ?? null
}

function makeService() {
  const getOptimizeSetup = Effect.fn('AssistantSetup.getOptimizeSetup')(function* (
    projectDirectories: readonly string[],
    homeDir?: string,
  ) {
    const home = homeDir ?? homedir()
    const paths = configPaths(projectDirectories, home)
    const configs = new Map<string, { config: Config | null; mtime: number }>()
    for (const path of paths) {
      const text = yield* readText(path)
      const config = parseConfig(text)
      const mtime = config === null ? 0 : yield* readMtime(path)
      configs.set(path, { config, mtime })
    }

    const mcpConfigs = collectMcpConfigs(paths, configs)

    const scopes = envScopes(projectDirectories, home)
    const shellContents = new Map<string, string | null>()
    const envSettings = new Map<string, DeferralEnvHit | null>()
    for (const name of environmentNames) {
      let hit: DeferralEnvHit | null = null
      for (const { scope, path } of scopes) {
        const env = configs.get(path)?.config?.env
        const value = env?.[name]
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          hit = { value: String(value), scope, path }
          break
        }
      }
      if (!hit) {
        for (const profile of shellProfiles) {
          const path = join(home, profile)
          if (!shellContents.has(path)) shellContents.set(path, yield* readText(path))
          const text = shellContents.get(path)
          if (text === null || text === undefined) continue
          const value = shellValue(text, name)
          if (value !== null) {
            hit = { value, scope: 'shell profile', path }
            break
          }
        }
      }
      envSettings.set(name, hit)
    }

    const [agents, skills, commands] = yield* Effect.all([
      listNames(join(home, '.claude', 'agents')).pipe(
        Effect.map(names => names.filter(name => name.endsWith('.md')).map(name => name.replace(/\.md$/, ''))),
      ),
      listNames(join(home, '.claude', 'skills')).pipe(
        Effect.flatMap(names =>
          Effect.forEach(names, name => {
            const skillFile = join(home, '.claude', 'skills', name, 'SKILL.md')
            return exists(skillFile).pipe(Effect.map(found => (found ? name : null)))
          }),
        ),
        Effect.map(names => names.filter((name): name is string => name !== null)),
      ),
      listNames(join(home, '.claude', 'commands')).pipe(
        Effect.map(names => names.filter(name => name.endsWith('.md')).map(name => name.replace(/\.md$/, ''))),
      ),
    ])
    return { home, mcpConfigs, envSettings, agents, skills, commands } satisfies OptimizeSetup
  })

  const getSkillInventory = Effect.fn('AssistantSetup.getSkillInventory')(function* (
    workingDirectories: readonly string[],
    homeDir?: string,
  ) {
    const home = homeDir ?? homedir()
    const roots = new Set([join(home, '.claude', 'skills')])
    for (const cwd of workingDirectories) {
      roots.add(join(cwd, '.agents', 'skills'))
      roots.add(join(cwd, '.claude', 'skills'))
    }
    const entries: SkillInventoryEntry[] = []
    for (const root of roots) {
      const names = yield* listNames(root)
      for (const name of names) {
        if (yield* exists(join(root, name, 'SKILL.md'))) entries.push({ name, root })
      }
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  })

  return AssistantSetup.of({ getOptimizeSetup, getSkillInventory })
}

export const AssistantSetupLive = Layer.succeed(AssistantSetup, makeService())

export function defaultHomeDirectory(): string {
  return homedir()
}

/** Promise bridge for legacy view builders; remove when their callers migrate. */
export function loadOptimizeSetup(projectDirectories: readonly string[], homeDir?: string): Promise<OptimizeSetup> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* AssistantSetup
      return yield* setup.getOptimizeSetup(projectDirectories, homeDir)
    }).pipe(Effect.provide(AssistantSetupLive)),
  )
}

/** Synchronous compatibility discovery helpers retained for existing callers. */
export function loadMcpConfigs(projectDirectories: Iterable<string>, home = homedir()): Map<string, McpConfigEntry> {
  const paths = configPaths([...projectDirectories], home)
  const configs = new Map<string, { config: Config | null; mtime: number }>()
  for (const path of paths) {
    try {
      const text = readFileSync(path, 'utf8')
      configs.set(path, { config: parseConfig(text), mtime: statSync(path).mtimeMs })
    } catch {
      configs.set(path, { config: null, mtime: 0 })
    }
  }
  return collectMcpConfigs(paths, configs)
}

export function findDeferralEnvSetting(
  name: string,
  projectDirectories: Iterable<string>,
  home = homedir(),
): DeferralEnvHit | null {
  const scopes = envScopes([...projectDirectories], home)
  for (const { scope, path } of scopes) {
    let config: Config | null = null
    try {
      config = parseConfig(readFileSync(path, 'utf8'))
    } catch {}
    const value = config?.env?.[name]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return { value: String(value), scope, path }
    }
  }
  for (const profile of shellProfiles) {
    const path = join(home, profile)
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const value = shellValue(content, name)
    if (value !== null) return { value, scope: 'shell profile', path }
  }
  return null
}

function collectMcpConfigs(
  paths: string[],
  configs: Map<string, { config: Config | null; mtime: number }>,
): Map<string, McpConfigEntry> {
  const result = new Map<string, McpConfigEntry>()
  for (const path of paths) {
    const loaded = configs.get(path)
    if (!loaded) continue
    const { config, mtime } = loaded
    if (!config) continue
    for (const [name, rawEntry] of Object.entries(config.mcpServers ?? {})) {
      const normalized = name.replace(/:/g, '_')
      let configured = result.get(normalized)
      if (!configured || configured.mtime < mtime) {
        configured = {
          normalized,
          original: name,
          mtime,
          alwaysLoadPaths: configured?.alwaysLoadPaths ?? [],
        }
        result.set(normalized, configured)
      }
      if (
        rawEntry !== null &&
        typeof rawEntry === 'object' &&
        (rawEntry as { alwaysLoad?: unknown }).alwaysLoad === true
      )
        configured?.alwaysLoadPaths.push(path)
    }
  }
  return result
}
