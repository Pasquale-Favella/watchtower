import type { Dirent } from 'node:fs'

import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { open, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import type { AppPaths, Env } from '@/infrastructure/config/environment.js'
import { overrideFor } from '@/infrastructure/config/environment.js'
import { extractBashCommands } from '@/core/ingestion/parsers/bash-utils.js'
import { readSessionFileEffect } from '@/infrastructure/ingestion/fs-utils.js'
import { captureScanPricing, getShortModelName } from '@/infrastructure/pricing/models.js'
import { isScanAbortedError } from '@/core/ingestion/reconciliation/scan-control.js'
import { checkScanAbort, scanIo } from '@/infrastructure/ingestion/scan-io.js'
import type { DateRange } from '@/core/domain/observations/types.js'
import type { ToolCall } from '@/core/domain/observations/types.js'
import type {
  ParsedProviderCall,
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from '@/infrastructure/provider-adapters/types.js'

const METADATA_PREFIX_BYTES = 64 * 1024

const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
const stringSchema = Schema.String
const numberSchema = Schema.Number
const metadataSchema = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  created_at: Schema.optional(Schema.Unknown),
  updated_at: Schema.optional(Schema.Unknown),
  total_tokens: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  model_provider: Schema.optional(Schema.Unknown),
  workspace: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Unknown),
})
const costSchema = Schema.Struct({
  session_cost_usd: Schema.optional(Schema.Unknown),
  subagent_cost_usd: Schema.optional(Schema.Unknown),
})
const sessionSchema = Schema.Struct({
  metadata: Schema.optional(Schema.Unknown),
  messages: Schema.optional(Schema.Unknown),
})
const messageSchema = Schema.Struct({
  role: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Unknown),
})
const contentBlockSchema = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.Unknown),
  name: Schema.optional(Schema.Unknown),
  input: Schema.optional(Schema.Unknown),
})
const unknownArraySchema = Schema.Array(Schema.Unknown)

const decodeRecord = Schema.decodeUnknownResult(recordSchema)
const decodeString = Schema.decodeUnknownResult(stringSchema)
const decodeNumber = Schema.decodeUnknownResult(numberSchema)
const decodeMetadata = Schema.decodeUnknownResult(metadataSchema)
const decodeCost = Schema.decodeUnknownResult(costSchema)
const decodeSessionJson = Schema.decodeUnknownResult(Schema.fromJsonString(sessionSchema))
const decodeMessage = Schema.decodeUnknownResult(messageSchema)
const decodeContentBlock = Schema.decodeUnknownResult(contentBlockSchema)
const decodeUnknownArray = Schema.decodeUnknownResult(unknownArraySchema)

type CodeWhaleMetadata = {
  readonly id: string
  readonly created_at?: string
  readonly updated_at?: string
  readonly total_tokens: number
  readonly model?: string
  readonly model_provider?: string
  readonly workspace?: string
  readonly cost?: Schema.Schema.Type<typeof costSchema>
}
type CodeWhaleMessage = Schema.Schema.Type<typeof messageSchema>

const toolNameMap: Record<string, string> = {
  exec_shell: 'Bash',
  exec_shell_wait: 'Bash',
  exec_shell_interact: 'Bash',
  exec_shell_cancel: 'Bash',
  task_shell_start: 'Bash',
  task_shell_wait: 'Bash',
  terminal_run: 'Bash',
  terminal_send: 'Bash',
  terminal_wait: 'Bash',
  terminal_cancel: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  fim_edit: 'Edit',
  apply_patch: 'Edit',
  list_dir: 'Glob',
  grep_files: 'Grep',
  web_search: 'WebSearch',
  fetch_url: 'WebFetch',
  'web.run': 'WebSearch',
  agent: 'Agent',
  'agents/list': 'Agent',
  'agents/message': 'Agent',
  'agents/followup': 'Agent',
  'agents/interrupt': 'Agent',
  'agents/wait': 'Agent',
  todo_write: 'TodoWrite',
  todo_add: 'TodoWrite',
  todo_update: 'TodoWrite',
  todo_list: 'TodoWrite',
  checklist_write: 'TodoWrite',
  checklist_add: 'TodoWrite',
  checklist_update: 'TodoWrite',
  checklist_list: 'TodoWrite',
  update_plan: 'TodoWrite',
  load_skill: 'Skill',
  request_user_input: 'AskUser',
}

function nonEmptyString(value: unknown): string | undefined {
  const decoded = decodeString(value)
  if (Result.isFailure(decoded)) return undefined
  const trimmed = decoded.success.trim()
  return trimmed || undefined
}

function safeNonNegativeNumber(value: unknown): number {
  const decoded = decodeNumber(value)
  return Result.isSuccess(decoded) && Number.isFinite(decoded.success) && decoded.success >= 0 ? decoded.success : 0
}

function safeTokenCount(value: unknown): number {
  return Math.floor(Math.min(safeNonNegativeNumber(value), Number.MAX_SAFE_INTEGER))
}

function parseMetadata(value: unknown): CodeWhaleMetadata | null {
  const decoded = decodeMetadata(value)
  if (Result.isFailure(decoded)) return null
  const id = nonEmptyString(decoded.success.id)
  if (!id) return null

  const costRecord = decodeRecord(decoded.success.cost)
  const cost = Result.isSuccess(costRecord) ? decodeCost(costRecord.success) : null
  return {
    id,
    created_at: nonEmptyString(decoded.success.created_at),
    updated_at: nonEmptyString(decoded.success.updated_at),
    total_tokens: safeTokenCount(decoded.success.total_tokens),
    model: nonEmptyString(decoded.success.model),
    model_provider: nonEmptyString(decoded.success.model_provider),
    workspace: nonEmptyString(decoded.success.workspace),
    cost: cost && Result.isSuccess(cost) ? cost.success : undefined,
  }
}

function findStringEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x5c) {
      i++
    } else if (source.charCodeAt(i) === 0x22) {
      return i
    }
  }
  return -1
}

function findObjectEnd(source: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < source.length; i++) {
    const ch = source.charCodeAt(i)
    if (inString) {
      if (ch === 0x5c) i++
      else if (ch === 0x22) inString = false
      continue
    }
    if (ch === 0x22) inString = true
    else if (ch === 0x7b) depth++
    else if (ch === 0x7d && --depth === 0) return i
  }
  return -1
}

// Discovery keeps CodeWhale's 64 KiB metadata prefix fast path. The full-file
// fallback only runs after a successful prefix read with no complete metadata.
function extractTopLevelMetadata(source: string): CodeWhaleMetadata | null {
  let depth = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i)
    if (ch === 0x7b) {
      depth++
      continue
    }
    if (ch === 0x7d) {
      depth--
      continue
    }
    if (ch !== 0x22) continue

    const end = findStringEnd(source, i)
    if (end === -1) return null
    if (depth !== 1) {
      i = end
      continue
    }

    let key: unknown
    try {
      key = JSON.parse(source.slice(i, end + 1))
    } catch {
      return null
    }
    i = end
    if (key !== 'metadata') continue

    let cursor = end + 1
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor++
    if (source[cursor] !== ':') continue
    cursor++
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor++
    if (source[cursor] !== '{') return null

    const objectEnd = findObjectEnd(source, cursor)
    if (objectEnd === -1) return null
    try {
      return parseMetadata(JSON.parse(source.slice(cursor, objectEnd + 1)))
    } catch {
      return null
    }
  }
  return null
}

type PrefixRead =
  { readonly _tag: 'ReadFailed' } | { readonly _tag: 'Read'; readonly metadata: CodeWhaleMetadata | null }

const readMetadataPrefix = Effect.fnUntraced(function* (
  filePath: string,
  signal?: AbortSignal,
): Effect.fn.Return<PrefixRead, Error> {
  const result = yield* Effect.result(
    Effect.acquireUseRelease(
      scanIo(() => open(filePath, 'r')),
      handle =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const prefix = Buffer.alloc(METADATA_PREFIX_BYTES)
          const readResult = yield* Effect.result(scanIo(() => handle.read(prefix, 0, prefix.length, 0), signal))
          if (Result.isFailure(readResult)) {
            if (isScanAbortedError(readResult.failure)) return yield* Effect.fail(readResult.failure)
            return { _tag: 'ReadFailed' } as const
          }
          return {
            _tag: 'Read',
            metadata: extractTopLevelMetadata(prefix.subarray(0, readResult.success.bytesRead).toString('utf-8')),
          } as const
        }),
      handle => scanIo(() => handle.close()).pipe(Effect.catch(() => Effect.void)),
    ),
  )
  if (Result.isFailure(result)) {
    if (isScanAbortedError(result.failure)) return yield* Effect.fail(result.failure)
    if (signal?.aborted) {
      yield* checkScanAbort(signal)
      return yield* Effect.fail(result.failure)
    }
    return { _tag: 'ReadFailed' }
  }
  return result.success
})

const readSessionMetadataEffect = Effect.fnUntraced(function* (
  filePath: string,
  signal?: AbortSignal,
): Effect.fn.Return<CodeWhaleMetadata | null, Error> {
  const prefix = yield* readMetadataPrefix(filePath, signal)
  if (prefix._tag === 'ReadFailed') return null
  if (prefix.metadata) return prefix.metadata

  const raw = yield* readSessionFileEffect(filePath, 'utf-8', signal ? { signal } : {})
  if (raw === null) return null
  const saved = decodeSessionJson(raw)
  return Result.isSuccess(saved) ? parseMetadata(saved.success.metadata) : null
})

const readDirectoryEntries = Effect.fnUntraced(function* (
  dir: string,
  signal?: AbortSignal,
): Effect.fn.Return<Dirent[], Error> {
  return yield* scanIo(() => readdir(dir, { withFileTypes: true }), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([] as Dirent[]))),
  )
})

function defaultSessionDirs(paths?: AppPaths): string[] {
  const configuredHome = overrideFor(paths, 'CODEWHALE_HOME')?.trim()
  if (configuredHome) return [join(configuredHome, 'sessions')]
  return [join(homedir(), '.codewhale', 'sessions'), join(homedir(), '.deepseek', 'sessions')]
}

function projectName(workspace: string | undefined): string {
  if (!workspace) return 'CodeWhale'
  const parts = workspace
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
  return parts.at(-1) ?? 'CodeWhale'
}

const discoverInDir = Effect.fnUntraced(function* (
  dir: string,
  signal?: AbortSignal,
): Effect.fn.Return<Array<{ source: SessionSource; id: string }>, Error> {
  const entries = yield* readDirectoryEntries(dir, signal)
  const results: Array<{ source: SessionSource; id: string }> = []

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    yield* checkScanAbort(signal)
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const name = entry.name
    const path = join(dir, name)
    const metadata = yield* readSessionMetadataEffect(path, signal)
    if (!metadata) continue
    results.push({
      id: metadata.id,
      source: { path, project: projectName(nonEmptyString(metadata.workspace)), provider: 'codewhale' },
    })
  }

  return results
})

function normalizeTimestamp(value: string | undefined): string {
  if (!value) return ''
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
}

function messageRole(message: CodeWhaleMessage): string {
  const decoded = decodeString(message.role)
  return Result.isSuccess(decoded) ? decoded.success : ''
}

function messageContent(message: CodeWhaleMessage): string | unknown[] {
  const stringContent = decodeString(message.content)
  if (Result.isSuccess(stringContent)) return stringContent.success
  const arrayContent = decodeUnknownArray(message.content)
  return Result.isSuccess(arrayContent) ? [...arrayContent.success] : []
}

function firstUserMessage(messages: CodeWhaleMessage[]): string {
  for (const message of messages) {
    if (messageRole(message) !== 'user') continue
    const content = messageContent(message)
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else {
      const textParts: string[] = []
      for (const value of content) {
        const decodedBlock = decodeContentBlock(value)
        if (Result.isFailure(decodedBlock)) continue
        const type = decodeString(decodedBlock.success.type)
        const blockText = decodeString(decodedBlock.success.text)
        if (Result.isSuccess(type) && type.success === 'text' && Result.isSuccess(blockText)) {
          textParts.push(blockText.success)
        }
      }
      text = textParts.join(' ')
    }
    if (text.trim()) return Array.from(text.trim()).slice(0, 500).join('')
  }
  return ''
}

function mapToolName(rawName: string): string {
  if (rawName.startsWith('mcp__')) return rawName
  if (rawName.startsWith('agents/')) return 'Agent'
  return Object.prototype.hasOwnProperty.call(toolNameMap, rawName) ? toolNameMap[rawName]! : rawName
}

function toolInput(value: unknown): Record<string, unknown> {
  const decoded = decodeRecord(value)
  return Result.isSuccess(decoded) ? decoded.success : {}
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(input[key])
    if (value) return value
  }
  return undefined
}

function collectTools(messages: CodeWhaleMessage[]): {
  tools: string[]
  bashCommands: string[]
  toolSequence: ToolCall[][]
  skills: string[]
  subagentTypes: string[]
  webSearchRequests: number
} {
  const tools: string[] = []
  const bashCommands: string[] = []
  const toolSequence: ToolCall[][] = []
  const skills: string[] = []
  const subagentTypes: string[] = []
  let webSearchRequests = 0

  for (const message of messages) {
    if (messageRole(message) !== 'assistant') continue
    const blocks = decodeUnknownArray(message.content)
    if (Result.isFailure(blocks)) continue
    const turnTools: ToolCall[] = []

    for (const value of blocks.success) {
      const decoded = decodeContentBlock(value)
      if (Result.isFailure(decoded)) continue
      const block = decoded.success
      const decodedType = decodeString(block.type)
      if (Result.isFailure(decodedType)) continue
      if (decodedType.success !== 'tool_use' && decodedType.success !== 'server_tool_use') continue
      const rawName = nonEmptyString(block.name)
      if (!rawName) continue
      const mapped = mapToolName(rawName)
      const input = toolInput(block.input)
      const toolCall: ToolCall = { tool: mapped }

      const file = firstString(input, ['file_path', 'path', 'target_file', 'file'])
      if (file) toolCall.file = file
      const command = firstString(input, ['command', 'cmd'])
      if (command) toolCall.command = command

      if (mapped === 'Bash' && command) bashCommands.push(...extractBashCommands(command))
      if (mapped === 'Skill') {
        const skill = firstString(input, ['name', 'skill', 'skill_name'])
        if (skill) skills.push(skill)
      }
      if (mapped === 'Agent') {
        const subagentType = firstString(input, ['type', 'agent_type', 'profile'])
        if (subagentType) subagentTypes.push(subagentType)
      }
      if (mapped === 'WebSearch') webSearchRequests++

      tools.push(mapped)
      turnTools.push(toolCall)
    }

    if (turnTools.length > 0) toolSequence.push(turnTools)
  }

  return { tools, bashCommands, toolSequence, skills, subagentTypes, webSearchRequests }
}

function reportedCost(value: unknown): { value: number; exact: boolean } {
  const record = decodeRecord(value)
  if (Result.isFailure(record)) return { value: 0, exact: false }
  const cost = decodeCost(record.success)
  if (Result.isFailure(cost)) return { value: 0, exact: false }
  const hasSessionCost = Object.prototype.hasOwnProperty.call(cost.success, 'session_cost_usd')
  const hasSubagentCost = Object.prototype.hasOwnProperty.call(cost.success, 'subagent_cost_usd')
  if (!hasSessionCost && !hasSubagentCost) return { value: 0, exact: false }
  return {
    value: safeNonNegativeNumber(cost.success.session_cost_usd) + safeNonNegativeNumber(cost.success.subagent_cost_usd),
    exact: true,
  }
}

function decodeMessages(value: unknown): CodeWhaleMessage[] {
  const array = decodeUnknownArray(value)
  if (Result.isFailure(array)) return []
  const messages: CodeWhaleMessage[] = []
  for (const item of array.success) {
    const decoded = decodeMessage(item)
    if (Result.isSuccess(decoded)) messages.push(decoded.success)
  }
  return messages
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseEffect = Effect.fn('parseCodeWhaleSession')(function* (): Effect.fn.Return<
    Stream.Stream<ParsedProviderCall, Error>,
    Error
  > {
    yield* checkScanAbort(signal)
    const raw = yield* readSessionFileEffect(source.path, 'utf-8', signal ? { signal } : {})
    let metadata: CodeWhaleMetadata | null = null
    let messages: CodeWhaleMessage[] = []

    if (raw !== null) {
      const saved = decodeSessionJson(raw)
      if (Result.isSuccess(saved)) {
        metadata = parseMetadata(saved.success.metadata)
        messages = decodeMessages(saved.success.messages)
      }
    }
    metadata ??= yield* readSessionMetadataEffect(source.path, signal)
    if (!metadata) return Stream.empty
    yield* checkScanAbort(signal)

    const totalTokens = metadata.total_tokens
    const model = metadata.model ?? metadata.model_provider ?? 'unknown'
    const localCost = reportedCost(metadata.cost)
    const costUSD = localCost.exact ? localCost.value : pricing.calculateCost(model, totalTokens, 0, 0, 0, 0)
    if (totalTokens === 0 && costUSD === 0) return Stream.empty

    const deduplicationKey = `codewhale:${metadata.id}`
    if (seenKeys.has(deduplicationKey)) return Stream.empty
    yield* checkScanAbort(signal)
    yield* Effect.sync(() => seenKeys.add(deduplicationKey))

    let timestamp = normalizeTimestamp(metadata.updated_at) || normalizeTimestamp(metadata.created_at)
    if (!timestamp) {
      const fileStat = yield* scanIo(() => stat(source.path), signal).pipe(
        Effect.map(value => value.mtime.toISOString()),
        Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(''))),
      )
      timestamp = fileStat
    }

    const { tools, bashCommands, toolSequence, skills, subagentTypes, webSearchRequests } = collectTools(messages)
    const workspace = nonEmptyString(metadata.workspace)
    const call: ParsedProviderCall = {
      provider: 'codewhale',
      model,
      // CodeWhale persists one aggregate token counter; retain it in input.
      inputTokens: totalTokens,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests,
      costUSD,
      costIsEstimated: !localCost.exact,
      tools,
      bashCommands,
      skills,
      subagentTypes,
      timestamp,
      speed: 'standard',
      deduplicationKey,
      turnId: `${metadata.id}:session`,
      toolSequence: toolSequence.length > 0 ? toolSequence : undefined,
      userMessage: firstUserMessage(messages),
      sessionId: metadata.id,
      project: projectName(workspace),
      projectPath: workspace,
    }
    return Stream.succeed(call)
  })

  const parseStream: NonNullable<SessionParser['parseStream']> = () => Stream.unwrap(parseEffect())
  return {
    parseStream,
  }
}

export function createCodeWhaleProvider(overrideDirs?: string | string[], paths?: AppPaths): Provider {
  const configuredDirs =
    overrideDirs === undefined ? undefined : Array.isArray(overrideDirs) ? overrideDirs : [overrideDirs]
  const sessionDirs = (): string[] => configuredDirs ?? defaultSessionDirs(paths)

  const discoverEffect = Effect.fn('discoverCodeWhaleSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    const signal = context?.signal
    yield* checkScanAbort(signal)
    const seenSessionIds = new Set<string>()
    const sources: SessionSource[] = []

    // Primary roots precede legacy roots; duplicate ids retain the primary copy.
    for (const dir of sessionDirs()) {
      for (const candidate of yield* discoverInDir(dir, signal)) {
        if (seenSessionIds.has(candidate.id)) continue
        seenSessionIds.add(candidate.id)
        sources.push(candidate.source)
      }
    }
    return sources
  })

  return {
    name: 'codewhale',
    displayName: 'CodeWhale',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return mapToolName(rawTool)
    },

    discoverSessionsEffect(context?: ProviderScanContext): Effect.Effect<SessionSource[], Error, Env> {
      return discoverEffect(context)
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      return createParser(source, seenKeys, context)
    },
  }
}

export const codewhale = createCodeWhaleProvider()
