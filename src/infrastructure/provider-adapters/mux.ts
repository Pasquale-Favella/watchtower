import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'

import { type AppPaths, overrideFor } from '@/infrastructure/config/environment.js'
import { extractBashCommands } from '@/core/ingestion/parsers/bash-utils.js'
import { billableOutputTokens } from '@/core/ingestion/normalization/billable-output.js'
import { readSessionLinesStream } from '@/infrastructure/ingestion/fs-utils.js'
import { captureScanPricing, getShortModelName } from '@/infrastructure/pricing/models.js'
import { isScanAbortedError } from '@/core/ingestion/reconciliation/scan-control.js'
import { checkScanAbort, readDirectoryOrEmpty, scanIo } from '@/infrastructure/ingestion/scan-io.js'
import type { DateRange } from '@/core/domain/observations/types.js'
import type {
  ParsedProviderCall,
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from '@/infrastructure/provider-adapters/types.js'

const MUX_DIR_ENV = 'WATCHTOWER_MUX_DIR'
const MUX_ROOT_ENV = 'MUX_ROOT'

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  file_read: 'Read',
  file_edit_replace_string: 'Edit',
  file_edit_replace_lines: 'Edit',
  file_edit_insert: 'Edit',
  file_edit_operation: 'Edit',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  task: 'Agent',
  todo: 'TodoWrite',
}

const unknownField = Schema.optional(Schema.Unknown)
const muxConfigSchema = Schema.Struct({ projects: unknownField })
const projectPairSchema = Schema.Array(Schema.Unknown)
const projectConfigSchema = Schema.Struct({ workspaces: unknownField })
const workspaceConfigSchema = Schema.Struct({ id: unknownField })
const messageSchema = Schema.Struct({
  id: unknownField,
  role: unknownField,
  parts: unknownField,
  createdAt: unknownField,
  metadata: unknownField,
})
const metadataSchema = Schema.Struct({
  model: unknownField,
  timestamp: unknownField,
  usage: unknownField,
  providerMetadata: unknownField,
})
const usageSchema = Schema.Struct({
  inputTokens: unknownField,
  outputTokens: unknownField,
  reasoningTokens: unknownField,
  cachedInputTokens: unknownField,
})
const providerMetadataSchema = Schema.Struct({ anthropic: unknownField })
const anthropicMetadataSchema = Schema.Struct({ cacheCreationInputTokens: unknownField })
const partSchema = Schema.Struct({
  type: unknownField,
  text: unknownField,
  toolName: unknownField,
  input: unknownField,
})
const bashInputSchema = Schema.Struct({ script: unknownField, command: unknownField })
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeConfig = Schema.decodeUnknownResult(muxConfigSchema)
const decodeProjectPair = Schema.decodeUnknownResult(projectPairSchema)
const decodeProjectConfig = Schema.decodeUnknownResult(projectConfigSchema)
const decodeWorkspaceConfig = Schema.decodeUnknownResult(workspaceConfigSchema)
const decodeMessage = Schema.decodeUnknownResult(messageSchema)
const decodeMetadata = Schema.decodeUnknownResult(metadataSchema)
const decodeUsage = Schema.decodeUnknownResult(usageSchema)
const decodeProviderMetadata = Schema.decodeUnknownResult(providerMetadataSchema)
const decodeAnthropicMetadata = Schema.decodeUnknownResult(anthropicMetadataSchema)
const decodeParts = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))
const decodePart = Schema.decodeUnknownResult(partSchema)
const decodeBashInput = Schema.decodeUnknownResult(bashInputSchema)
const decodeString = Schema.decodeUnknownResult(Schema.String)
const decodeFinite = Schema.decodeUnknownResult(Schema.Finite)

type MuxMessage = Schema.Schema.Type<typeof messageSchema>
type MuxMetadata = Schema.Schema.Type<typeof metadataSchema>
type MuxUsage = Schema.Schema.Type<typeof usageSchema>

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function getMuxRoot(override?: string, paths?: AppPaths): string {
  if (override) return resolve(expandHome(override))
  const watchtowerOverride = overrideFor(paths, MUX_DIR_ENV)
  if (watchtowerOverride) return resolve(expandHome(watchtowerOverride))
  const muxRoot = overrideFor(paths, MUX_ROOT_ENV)
  if (muxRoot) return resolve(expandHome(muxRoot))
  return join(homedir(), '.mux')
}

// Splits on the first colon only, leaving any colon inside the id intact.
function stripProvider(model: string): string {
  const i = model.indexOf(':')
  return i >= 0 ? model.slice(i + 1) : model
}

function stringField(value: unknown): string | undefined {
  const result = decodeString(value)
  return Result.isSuccess(result) ? result.success : undefined
}

function safeTokenCount(value: unknown): number {
  const result = decodeFinite(value)
  return Result.isSuccess(result) && result.success > 0 ? result.success : 0
}

function asMuxMessage(value: unknown): MuxMessage | undefined {
  const result = decodeMessage(value)
  return Result.isSuccess(result) ? result.success : undefined
}

function asMetadata(value: unknown): MuxMetadata | undefined {
  const result = decodeMetadata(value)
  return Result.isSuccess(result) ? result.success : undefined
}

function asUsage(value: unknown): MuxUsage | undefined {
  const result = decodeUsage(value)
  return Result.isSuccess(result) ? result.success : undefined
}

// Guard against non-finite / out-of-range ms, which make toISOString() throw.
function toIsoTimestamp(timestamp: unknown, createdAt: unknown): string {
  const parsedTimestamp = decodeFinite(timestamp)
  if (Result.isSuccess(parsedTimestamp)) {
    const date = new Date(parsedTimestamp.success)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return stringField(createdAt) ?? ''
}

const loadProjectMap = Effect.fnUntraced(function* (
  root: string,
  signal?: AbortSignal,
): Effect.fn.Return<Map<string, string>, Error> {
  const map = new Map<string, string>()
  const raw = yield* scanIo(() => readFile(join(root, 'config.json'), 'utf-8'), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
  if (raw === null) return map

  const json = decodeJson(raw)
  if (Result.isFailure(json)) return map
  const config = decodeConfig(json.success)
  if (Result.isFailure(config) || !Array.isArray(config.success.projects)) return map

  for (const candidate of config.success.projects) {
    const pair = decodeProjectPair(candidate)
    if (Result.isFailure(pair) || pair.success.length < 2) continue
    const projectPath = stringField(pair.success[0])
    if (projectPath === undefined) continue
    const label = basename(projectPath) || projectPath
    const projectConfig = decodeProjectConfig(pair.success[1])
    if (Result.isFailure(projectConfig) || !Array.isArray(projectConfig.success.workspaces)) continue

    for (const workspace of projectConfig.success.workspaces) {
      const decodedWorkspace = decodeWorkspaceConfig(workspace)
      if (Result.isFailure(decodedWorkspace)) continue
      const id = stringField(decodedWorkspace.success.id)
      if (id) map.set(id, label)
    }
  }
  return map
})

const isFile = Effect.fnUntraced(function* (path: string, signal?: AbortSignal): Effect.fn.Return<boolean, Error> {
  return yield* scanIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isFile()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
})

const pushChatSource = Effect.fnUntraced(function* (
  sources: SessionSource[],
  chatPath: string,
  project: string,
  signal?: AbortSignal,
): Effect.fn.Return<void, Error> {
  if (yield* isFile(chatPath, signal)) sources.push({ path: chatPath, project, provider: 'mux' })
})

const discoverSessionsEffect = Effect.fn('discoverMuxSessions')(function* (
  root: string,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  const signal = context?.signal
  yield* checkScanAbort(signal)
  const sessionsDir = join(root, 'sessions')
  const workspaceResult = yield* Effect.result(scanIo(() => readdir(sessionsDir), signal))
  if (Result.isFailure(workspaceResult)) {
    if (isScanAbortedError(workspaceResult.failure)) return yield* Effect.fail(workspaceResult.failure)
    return []
  }
  const workspaceIds = workspaceResult.success
  const projectMap = yield* loadProjectMap(root, signal)
  const sources: SessionSource[] = []

  for (const workspaceId of workspaceIds) {
    yield* checkScanAbort(signal)
    const workspaceDir = join(sessionsDir, workspaceId)
    const project = projectMap.get(workspaceId) ?? workspaceId
    yield* pushChatSource(sources, join(workspaceDir, 'chat.jsonl'), project, signal)

    // Child sessions are stored separately and attributed to their workspace.
    const childTaskIds = yield* readDirectoryOrEmpty(join(workspaceDir, 'subagent-transcripts'), signal)
    for (const childTaskId of childTaskIds) {
      yield* checkScanAbort(signal)
      yield* pushChatSource(
        sources,
        join(workspaceDir, 'subagent-transcripts', childTaskId, 'chat.jsonl'),
        project,
        signal,
      )
    }
  }
  return sources
})

function parseUserMessage(parts: unknown): string | undefined {
  const decodedParts = decodeParts(parts)
  if (Result.isFailure(decodedParts)) return undefined
  const texts: string[] = []

  for (const candidate of decodedParts.success) {
    const result = decodePart(candidate)
    if (Result.isFailure(result) || result.success.type !== 'text') continue
    const text = stringField(result.success.text)
    if (text) texts.push(text)
  }
  return texts.length > 0 ? texts.join(' ').slice(0, 500) : undefined
}

function parseTools(parts: unknown): { tools: string[]; bashCommands: string[] } {
  const decodedParts = decodeParts(parts)
  if (Result.isFailure(decodedParts)) return { tools: [], bashCommands: [] }
  const tools: string[] = []
  const bashCommands: string[] = []

  for (const candidate of decodedParts.success) {
    const result = decodePart(candidate)
    if (Result.isFailure(result) || result.success.type !== 'dynamic-tool') continue
    const toolName = stringField(result.success.toolName)
    if (toolName === undefined) continue
    tools.push(toolNameMap[toolName] ?? toolName)
    if (toolName !== 'bash') continue

    const input = decodeBashInput(result.success.input)
    if (Result.isFailure(input)) continue
    const script = input.success.script ?? input.success.command
    const command = stringField(script)
    if (command) bashCommands.push(...extractBashCommands(command))
  }
  return { tools, bashCommands }
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseEffect = Effect.fnUntraced(function* (): Effect.fn.Return<
    Stream.Stream<ParsedProviderCall, Error>,
    Error
  > {
    yield* checkScanAbort(signal)
    const workspaceId = basename(dirname(source.path))
    let pendingUserMessage = ''
    let lineIdx = 0

    return readSessionLinesStream(source.path, undefined, signal ? { signal } : {}).pipe(
      Stream.mapEffect(line =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          // The shared line reader omits blank lines, so this remains the count
          // of yielded rows (including malformed nonblank rows), as before.
          lineIdx++
          const json = decodeJson(typeof line === 'string' ? line : line.toString('utf-8'))
          if (Result.isFailure(json)) return Result.fail(undefined)
          const message = asMuxMessage(json.success)
          if (!message) return Result.fail(undefined)

          if (message.role === 'user') {
            const userMessage = parseUserMessage(message.parts)
            if (userMessage !== undefined) pendingUserMessage = userMessage
            return Result.fail(undefined)
          }
          if (message.role !== 'assistant') return Result.fail(undefined)

          const metadata = asMetadata(message.metadata)
          const usage = metadata ? asUsage(metadata.usage) : undefined
          if (!metadata || !usage) return Result.fail(undefined)

          const providerMetadata = decodeProviderMetadata(metadata.providerMetadata)
          const anthropicValue = Result.isSuccess(providerMetadata) ? providerMetadata.success.anthropic : undefined
          const anthropic = decodeAnthropicMetadata(anthropicValue)
          const cacheRead = safeTokenCount(usage.cachedInputTokens)
          const cacheCreate = Result.isSuccess(anthropic)
            ? safeTokenCount(anthropic.success.cacheCreationInputTokens)
            : 0
          const reasoning = safeTokenCount(usage.reasoningTokens)
          const inputTokens = Math.max(0, safeTokenCount(usage.inputTokens) - cacheRead - cacheCreate)
          const outputTokens = Math.max(0, safeTokenCount(usage.outputTokens) - reasoning)

          if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheCreate === 0 && reasoning === 0) {
            return Result.fail(undefined)
          }

          // getCanonicalName strips slash prefixes, not provider prefixes.
          const rawModel = stringField(metadata.model) || 'unknown'
          const model = stripProvider(rawModel)
          const id = stringField(message.id) || `L${lineIdx}`
          const deduplicationKey = `mux:${workspaceId}:${id}`
          if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)
          seenKeys.add(deduplicationKey)

          const { tools, bashCommands } = parseTools(message.parts)
          const costUSD = yield* Effect.try({
            try: () =>
              pricing.calculateCost(
                model,
                inputTokens,
                billableOutputTokens('mux', outputTokens, reasoning),
                cacheCreate,
                cacheRead,
                0,
              ),
            catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
          })
          const call: ParsedProviderCall = {
            provider: 'mux',
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: cacheCreate,
            cacheReadInputTokens: cacheRead,
            cachedInputTokens: cacheRead,
            reasoningTokens: reasoning,
            webSearchRequests: 0,
            costUSD,
            tools,
            bashCommands,
            timestamp: toIsoTimestamp(metadata.timestamp, message.createdAt),
            speed: 'standard',
            deduplicationKey,
            userMessage: pendingUserMessage,
            sessionId: workspaceId,
          }
          pendingUserMessage = ''
          return Result.succeed(call)
        }),
      ),
      Stream.filterMap(call => call),
    )
  })
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> => Stream.unwrap(parseEffect())

  return {
    parseStream,
  }
}

export function createMuxProvider(muxRoot?: string, paths?: AppPaths): Provider {
  const root = getMuxRoot(muxRoot, paths)
  const discoverEffect = Effect.fn('discoverMuxSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    return yield* discoverSessionsEffect(root, context)
  })

  return {
    name: 'mux',
    displayName: 'Mux',

    modelDisplayName(model: string): string {
      return getShortModelName(stripProvider(model))
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    discoverSessionsEffect: discoverEffect,

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

export const mux = createMuxProvider()
