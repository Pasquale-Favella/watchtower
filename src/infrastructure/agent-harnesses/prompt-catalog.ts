import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import * as Schema from 'effect/Schema'

import { type AgentPromptCatalog, agentPromptCatalogSchema } from '@/shared/schemas/execution.js'
import { PROMPT_CONTEXT_SEARCH_MAX_RESULTS, type PromptContextSearchResult } from '@/shared/schemas/prompt-context.js'
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  type RankedSearchResult,
  scorePromptCommandMatch,
  scorePromptSkillMatch,
} from '@/shared/search-ranking.js'

import { parseSkillFrontmatter } from './skill-frontmatter.js'

function isMissingPath(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
}

async function readDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (cause) {
    if (isMissingPath(cause)) return []
    throw cause
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (cause) {
    if (isMissingPath(cause)) return undefined
    throw cause
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (cause) {
    if (isMissingPath(cause)) return false
    throw cause
  }
}

function parseLenientJson(content: string): unknown {
  const withoutComments = content.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (match, stringLiteral: string | undefined) => (stringLiteral ? match : ' '),
  )
  const withoutTrailingCommas = withoutComments.replace(
    /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
    (match, stringLiteral: string | undefined, bracket: string | undefined) =>
      stringLiteral ? match : (bracket ?? ''),
  )
  return JSON.parse(withoutTrailingCommas)
}

export function isPromptSkillUserInvocable(content: string): boolean {
  const parsed = parseSkillFrontmatter(content)
  return parsed.kind !== 'malformed' && (parsed.kind !== 'parsed' || parsed.userInvocable !== false)
}

async function skillEntries(directory: string): Promise<AgentPromptCatalog['skills'][number][]> {
  const entries = await readDirectory(directory)
  const skills: AgentPromptCatalog['skills'][number][] = []
  for (const entry of entries.slice(0, 512)) {
    if (!entry.isDirectory()) continue
    const content = await readText(join(directory, entry.name, 'SKILL.md'))
    if (content === undefined) continue
    const metadata = parseSkillFrontmatter(content)
    if (metadata.kind === 'malformed') continue
    const name = entry.name.trim()
    if (!name) continue
    const description = metadata.kind === 'parsed' ? metadata.description : undefined
    skills.push({
      name,
      enabled: true,
      ...(description ? { description } : {}),
      ...(metadata.kind === 'parsed' && metadata.userInvocable === false ? { userInvocable: false } : {}),
    })
  }
  return skills
}

async function rootSkillEntry(directory: string): Promise<AgentPromptCatalog['skills'][number] | undefined> {
  const content = await readText(join(directory, 'SKILL.md'))
  if (content === undefined) return undefined
  const metadata = parseSkillFrontmatter(content)
  if (metadata.kind === 'malformed') return undefined
  const name = (metadata.kind === 'parsed' ? metadata.name : undefined) ?? basename(directory)
  const description = metadata.kind === 'parsed' ? metadata.description : undefined
  return {
    name,
    enabled: true,
    ...(description ? { description } : {}),
    ...(metadata.kind === 'parsed' && metadata.userInvocable === false ? { userInvocable: false } : {}),
  }
}

interface ClaudeSettings {
  readonly skillOverrides?: Readonly<Record<string, string>>
  readonly enabledPlugins?: Readonly<Record<string, unknown>>
}

const claudeSettingsSchema = Schema.Struct({
  skillOverrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

async function readSettings(path: string): Promise<ClaudeSettings | undefined> {
  const contents = await readText(path)
  if (contents === undefined) return undefined
  return Schema.decodeUnknownSync(claudeSettingsSchema)(parseLenientJson(contents))
}

function managedSettingsPath(): string | undefined {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA?.trim()
    return programData ? join(programData, 'ClaudeCode', 'managed-settings.json') : undefined
  }
  return '/etc/claude-code/managed-settings.json'
}

async function claudeSettings(cwd: string, configDirectory: string): Promise<ClaudeSettings> {
  const settings: ClaudeSettings[] = []
  const managedPath = managedSettingsPath()
  const paths = [
    join(configDirectory, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
    ...(managedPath ? [managedPath] : []),
  ]
  for (const path of paths) {
    const parsed = await readSettings(path)
    if (parsed) settings.push(parsed)
  }
  const skillOverrides: Record<string, string> = {}
  const enabledPlugins: Record<string, unknown> = {}
  for (const value of settings) {
    Object.assign(skillOverrides, value.skillOverrides)
    Object.assign(enabledPlugins, value.enabledPlugins)
  }
  return { skillOverrides, enabledPlugins }
}

async function pluginSkillEntries(
  cwd: string,
  configDirectory: string,
  enabledPlugins: Readonly<Record<string, unknown>>,
): Promise<AgentPromptCatalog['skills'][number][]> {
  const configuredPluginDirectory = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim()
  const pluginDirectory = configuredPluginDirectory
    ? resolve(cwd, configuredPluginDirectory.replace(/^~(?=$|[\\/])/, homedir()))
    : join(configDirectory, 'plugins')
  const registryPath = join(pluginDirectory, 'installed_plugins.json')
  const contents = await readText(registryPath)
  if (contents === undefined) return []
  const registry = Schema.decodeUnknownSync(
    Schema.Struct({ plugins: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) }),
  )(JSON.parse(contents))
  const skills: AgentPromptCatalog['skills'][number][] = []
  for (const [pluginId, records] of Object.entries(registry.plugins).sort(([a], [b]) => a.localeCompare(b))) {
    if (enabledPlugins[pluginId] !== true) continue
    for (const record of records) {
      const parsed = Schema.decodeUnknownOption(
        Schema.Struct({
          scope: Schema.Literals(['user', 'project', 'local', 'managed']),
          installPath: Schema.NonEmptyString,
          projectPath: Schema.optional(Schema.NonEmptyString),
        }),
      )(record)
      if (parsed._tag === 'None') continue
      const install = parsed.value
      if (
        install.scope !== 'user' &&
        install.scope !== 'managed' &&
        resolve(install.projectPath ?? '') !== resolve(cwd)
      )
        continue
      const installPath = resolve(cwd, install.installPath)
      const manifestText = await readText(join(installPath, '.claude-plugin', 'plugin.json'))
      const manifest = manifestText
        ? Schema.decodeUnknownSync(
            Schema.Struct({
              name: Schema.optional(Schema.NonEmptyString),
              skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
            }),
          )(JSON.parse(manifestText))
        : undefined
      const prefix = manifest?.name ?? pluginId.split('@')[0] ?? basename(installPath)
      const defaultRoot = join(installPath, 'skills')
      const roots: string[] = []
      const hasDefaultRoot = await isDirectory(defaultRoot)
      if (hasDefaultRoot) roots.push(defaultRoot)
      if (manifest?.skills !== undefined) {
        const declaredRoots = typeof manifest.skills === 'string' ? [manifest.skills] : manifest.skills
        for (const declaredRoot of declaredRoots) {
          const root = resolve(installPath, declaredRoot)
          const pathFromInstall = relative(installPath, root)
          if (pathFromInstall === '..' || pathFromInstall.startsWith(`..${sep}`) || isAbsolute(pathFromInstall))
            continue
          roots.push(root)
        }
      } else if (!hasDefaultRoot && (await readText(join(installPath, 'SKILL.md'))) !== undefined) {
        roots.push(installPath)
      }
      for (const root of roots) {
        const rootSkill = await rootSkillEntry(root)
        const pluginSkills = rootSkill ? [rootSkill] : await skillEntries(root)
        for (const skill of pluginSkills) {
          const unprefixedName = skill.name.startsWith(`${prefix}:`) ? skill.name.slice(prefix.length + 1) : skill.name
          const name = `${prefix}:${unprefixedName.replace(/[^a-zA-Z0-9_-]/g, '-')}`
          const override = enabledPlugins[name]
          if (override === false) continue
          skills.push({ ...skill, name })
        }
      }
    }
  }
  return skills
}

function dedupeSkills(skills: readonly AgentPromptCatalog['skills'][number][]): AgentPromptCatalog['skills'] {
  const names = new Set<string>()
  return skills.filter(skill => {
    const key = skill.name.trim().toLocaleLowerCase()
    if (!key || names.has(key) || !skill.enabled || skill.userInvocable === false) return false
    names.add(key)
    return true
  })
}

function uniqueSkills(skills: readonly AgentPromptCatalog['skills'][number][]): AgentPromptCatalog['skills'] {
  const names = new Set<string>()
  return skills.filter(skill => {
    const key = skill.name.trim().toLocaleLowerCase()
    if (!key || names.has(key)) return false
    names.add(key)
    return true
  })
}

function dedupeCommands(
  commands: readonly AgentPromptCatalog['commands'][number][],
  skills: AgentPromptCatalog['skills'],
): AgentPromptCatalog['commands'] {
  const names = new Set(skills.map(skill => skill.name.trim().toLocaleLowerCase()))
  return commands.filter(command => {
    const key = command.name.trim().toLocaleLowerCase()
    if (!key || names.has(key)) return false
    names.add(key)
    return true
  })
}

export function normalizeAgentPromptCatalog(catalog: AgentPromptCatalog): AgentPromptCatalog {
  const skills = dedupeSkills(catalog.skills)
  const commands = dedupeCommands(catalog.commands, skills)
  return Schema.decodeUnknownSync(agentPromptCatalogSchema)({
    skills,
    skillsComplete: catalog.skillsComplete,
    commands,
  })
}

export async function discoverClaudePromptCatalog(cwd: string): Promise<AgentPromptCatalog> {
  const home = homedir()
  const configuredDirectory = process.env.CLAUDE_CONFIG_DIR?.trim()
  const configDirectory = configuredDirectory ? resolve(cwd, configuredDirectory) : join(home, '.claude')
  const settings = await claudeSettings(cwd, configDirectory)
  const skillCandidates: AgentPromptCatalog['skills'][number][] = []
  for (const root of [join(configDirectory, 'skills'), join(cwd, '.claude', 'skills')]) {
    skillCandidates.push(...(await skillEntries(root)))
  }
  skillCandidates.push(...(await pluginSkillEntries(cwd, configDirectory, settings.enabledPlugins ?? {})))
  const skills = uniqueSkills(
    skillCandidates.map(skill => ({
      ...skill,
      enabled: skill.enabled && settings.skillOverrides?.[skill.name] !== 'off',
    })),
  )

  return Schema.decodeUnknownSync(agentPromptCatalogSchema)({
    skills: skills.slice(0, 512),
    skillsComplete: true,
    commands: [],
  })
}

export function mergePromptContextSearch(
  local: PromptContextSearchResult,
  catalog: AgentPromptCatalog,
  query: string,
): PromptContextSearchResult {
  const normalizedCatalog = normalizeAgentPromptCatalog(catalog)
  const providerSkills = normalizedCatalog.skills
  const blockedSkills = new Set(
    catalog.skills
      .filter(skill => !skill.enabled || skill.userInvocable === false)
      .map(skill => skill.name.trim().toLocaleLowerCase()),
  )
  const usedNames = new Set(providerSkills.map(skill => skill.name.trim().toLocaleLowerCase()))
  const items: PromptContextSearchResult['items'][number][] = []
  for (const command of normalizedCatalog.commands) {
    const key = command.name.trim().toLocaleLowerCase()
    if (usedNames.has(key)) continue
    usedNames.add(key)
    items.push({
      path: command.name,
      label: command.name,
      kind: 'providerCommand',
      ...(command.description ? { description: command.description } : {}),
    })
  }
  items.push(
    ...providerSkills.map(skill => ({
      path: skill.name,
      label: skill.name,
      kind: 'providerSkill' as const,
      ...(skill.scope ? { scope: skill.scope } : {}),
      ...(skill.description ? { description: skill.description } : {}),
    })),
  )

  if (!catalog.skillsComplete) {
    for (const item of local.items) {
      if (item.kind !== 'skill') continue
      const key = item.label.trim().toLocaleLowerCase()
      if (blockedSkills.has(key) || usedNames.has(key)) continue
      usedNames.add(key)
      items.push(item)
    }
  }

  for (const item of local.items) {
    if (item.kind === 'skill') continue
    if (item.kind === 'command') {
      const key = item.label.trim().toLocaleLowerCase()
      if (usedNames.has(key)) continue
      usedNames.add(key)
    }
    items.push(item)
  }

  const needle = normalizeSearchQuery(query)
  const ranked: RankedSearchResult<PromptContextSearchResult['items'][number]>[] = []
  let matchCount = 0
  for (const item of items) {
    const isSkill = item.kind === 'skill' || item.kind === 'providerSkill'
    let score: number | null
    if (!needle) {
      score = 0
    } else if (isSkill) {
      score = scorePromptSkillMatch(item.label, item.description, needle)
    } else {
      score = scorePromptCommandMatch(item.label, item.description, needle)
    }
    if (score === null) continue
    matchCount += 1
    const tier = item.kind === 'command' || item.kind === 'providerCommand' ? 1 : 2
    insertRankedSearchResult(
      ranked,
      { item, score, tieBreaker: `${tier}\u0000${item.label}` },
      PROMPT_CONTEXT_SEARCH_MAX_RESULTS,
    )
  }
  return {
    items: ranked.map(({ item }) => ({
      ...item,
      ...(item.description ? { description: item.description.slice(0, 512) } : {}),
    })),
    truncated: local.truncated || matchCount > PROMPT_CONTEXT_SEARCH_MAX_RESULTS,
  }
}
