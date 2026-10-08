import { Effect, Result, Schema, Stream } from 'effect'
import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionFileEffect, readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing } from '../models.js'
import { throwIfScanAborted } from '../scan-control.js'
import type { ScanPricing } from '../scan-pricing.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const METADATA_FILENAME = 'meta.json'
const MESSAGES_FILENAME = 'messages.jsonl'
const DEFAULT_MODEL = 'mistral-medium-3.5'

const modelDisplayNames: Record<string, string> = {
  'mistral-medium-3.5': 'Mistral Medium 3.5',
  'mistral-vibe-cli-latest': 'Mistral Vibe CLI',
  'devstral-small': 'Devstral Small',
  'devstral-small-latest': 'Devstral Small',
  devstral: 'Devstral',
  local: 'Local',
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  search_replace: 'Edit',
  grep: 'Grep',
  task: 'Agent',
  todo: 'TodoWrite',
  skill: 'Skill',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  ask_user_question: 'AskUser',
  exit_plan_mode: 'ExitPlanMode',
}

const metadataInputSchema = Schema.Struct({
  session_id: Schema.optional(Schema.Unknown),
  start_time: Schema.optional(Schema.Unknown),
  end_time: Schema.optional(Schema.Unknown),
  environment: Schema.optional(Schema.Unknown),
  stats: Schema.optional(Schema.Unknown),
  config: Schema.optional(Schema.Unknown),
  title: Schema.optional(Schema.Unknown),
})
const statsInputSchema = Schema.Struct({
  session_prompt_tokens: Schema.optional(Schema.Unknown),
  session_completion_tokens: Schema.optional(Schema.Unknown),
  session_cost: Schema.optional(Schema.Unknown),
  input_price_per_million: Schema.optional(Schema.Unknown),
  output_price_per_million: Schema.optional(Schema.Unknown),
})
const configInputSchema = Schema.Struct({
  active_model: Schema.optional(Schema.Unknown),
  models: Schema.optional(Schema.Unknown),
})
const modelConfigInputSchema = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  alias: Schema.optional(Schema.Unknown),
  input_price: Schema.optional(Schema.Unknown),
  output_price: Schema.optional(Schema.Unknown),
})
const environmentInputSchema = Schema.Struct({ working_directory: Schema.optional(Schema.Unknown) })
const messageInputSchema = Schema.Struct({
  role: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Unknown),
  message_id: Schema.optional(Schema.Unknown),
  timestamp: Schema.optional(Schema.Unknown),
  tool_calls: Schema.optional(Schema.Unknown),
})
const toolCallInputSchema = Schema.Struct({ function: Schema.optional(Schema.Unknown) })
const toolFunctionInputSchema = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  arguments: Schema.optional(Schema.Unknown),
})
const toolArgumentsSchema = Schema.Record(Schema.String, Schema.Unknown)
const toolArgumentsInputSchema = Schema.Union([Schema.fromJsonString(toolArgumentsSchema), toolArgumentsSchema])
const textPartInputSchema = Schema.Struct({ text: Schema.optional(Schema.Unknown) })
const positiveNumberSchema = Schema.Finite.check(Schema.isGreaterThan(0))
const nullableStringSchema = Schema.Union([Schema.String, Schema.Null])
const vibeStatsSchema = Schema.Struct({
  sessionPromptTokens: Schema.Finite,
  sessionCompletionTokens: Schema.Finite,
  sessionCost: Schema.Finite,
  inputPricePerMillion: Schema.Finite,
  outputPricePerMillion: Schema.Finite,
})
const vibeModelConfigSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  alias: Schema.optional(Schema.String),
  inputPrice: Schema.Finite,
  outputPrice: Schema.Finite,
})
const vibeToolCallSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
})
const vibeMessageSchema = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  toolCalls: Schema.Array(vibeToolCallSchema),
})
const vibeMetadataSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(nullableStringSchema),
  environment: Schema.optional(Schema.Struct({ workingDirectory: Schema.optional(nullableStringSchema) })),
  stats: vibeStatsSchema,
  config: Schema.optional(
    Schema.Struct({ activeModel: Schema.optional(Schema.String), models: Schema.Array(vibeModelConfigSchema) }),
  ),
  title: Schema.optional(nullableStringSchema),
})

type VibeMetadata = Schema.Schema.Type<typeof vibeMetadataSchema>
type VibeModelConfig = Schema.Schema.Type<typeof vibeModelConfigSchema>
type VibeMessage = Schema.Schema.Type<typeof vibeMessageSchema>
type VibeToolCall = Schema.Schema.Type<typeof vibeToolCallSchema>
type MetadataInput = Schema.Schema.Type<typeof metadataInputSchema>
type ModelConfigInput = Schema.Schema.Type<typeof modelConfigInputSchema>
type MessageInput = Schema.Schema.Type<typeof messageInputSchema>

function getMistralVibeSessionsDir(override?: string): string {
  if (override) return override
  const configuredHome = process.env['VIBE_HOME']
  const vibeHome = configuredHome ? expandHome(configuredHome) : join(homedir(), '.vibe')
  return join(vibeHome, 'logs', 'session')
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function checkAbort(signal?: AbortSignal): Effect.Effect<void, Error> {
  return Effect.try({ try: () => throwIfScanAborted(signal), catch: toError })
}

function decode<A, I>(schema: Schema.Codec<A, I>, value: unknown): A | undefined {
  const result = Schema.decodeUnknownResult(schema)(value)
  return Result.isSuccess(result) ? result.success : undefined
}

const readJsonEffect = Effect.fnUntraced(function* <A, I>(
  path: string,
  schema: Schema.Codec<A, I>,
  signal?: AbortSignal,
): Effect.fn.Return<A | null, Error> {
  yield* checkAbort(signal)
  const raw = yield* readSessionFileEffect(path, 'utf-8', signal ? { signal } : {})
  yield* checkAbort(signal)
  if (raw === null) return null
  return decode(Schema.fromJsonString(schema), raw) ?? null
})

function positiveNumber(value: unknown): number {
  return decode(positiveNumberSchema, value) ?? 0
}

function normalizeModelConfig(input: ModelConfigInput): VibeModelConfig {
  const name = decode(Schema.String, input.name)
  const alias = decode(Schema.String, input.alias)
  return {
    ...(name !== undefined ? { name } : {}),
    ...(alias !== undefined ? { alias } : {}),
    inputPrice: positiveNumber(input.input_price),
    outputPrice: positiveNumber(input.output_price),
  }
}

function normalizeMetadata(input: MetadataInput): VibeMetadata | undefined {
  const stats = decode(statsInputSchema, input.stats)
  const config = decode(configInputSchema, input.config)
  const environment = decode(environmentInputSchema, input.environment)
  const models = decode(Schema.Array(Schema.Unknown), config?.models) ?? []
  const normalizedModels = models.flatMap(model => {
    const decoded = decode(modelConfigInputSchema, model)
    return decoded ? [normalizeModelConfig(decoded)] : []
  })
  const sessionId = decode(Schema.String, input.session_id)
  const startTime = decode(Schema.String, input.start_time)
  const endTime = decode(nullableStringSchema, input.end_time)
  const title = decode(nullableStringSchema, input.title)
  const workingDirectory = decode(nullableStringSchema, environment?.working_directory)
  const active = decode(Schema.String, config?.active_model)
  return decode(vibeMetadataSchema, {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
    ...(endTime !== undefined ? { endTime } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(environment ? { environment: { ...(workingDirectory !== undefined ? { workingDirectory } : {}) } } : {}),
    stats: {
      sessionPromptTokens: positiveNumber(stats?.session_prompt_tokens),
      sessionCompletionTokens: positiveNumber(stats?.session_completion_tokens),
      sessionCost: positiveNumber(stats?.session_cost),
      inputPricePerMillion: positiveNumber(stats?.input_price_per_million),
      outputPricePerMillion: positiveNumber(stats?.output_price_per_million),
    },
    ...(config
      ? {
          config: {
            ...(active !== undefined ? { activeModel: active } : {}),
            models: normalizedModels,
          },
        }
      : {}),
  })
}

function normalizeContent(value: unknown): string | undefined {
  const text = decode(Schema.String, value)
  if (text !== undefined) return text
  const parts = decode(Schema.Array(Schema.Unknown), value)
  if (!parts) return undefined
  return parts
    .map(part => {
      const directText = decode(Schema.String, part)
      if (directText !== undefined) return directText
      return decode(Schema.String, decode(textPartInputSchema, part)?.text) ?? ''
    })
    .filter(Boolean)
    .join(' ')
}

function normalizeToolCall(input: Schema.Schema.Type<typeof toolCallInputSchema>): VibeToolCall | undefined {
  const fn = decode(toolFunctionInputSchema, input?.function)
  if (!fn) return undefined
  const name = decode(Schema.String, fn.name)
  const decodedArguments = decode(toolArgumentsInputSchema, fn.arguments)
  const command = decode(Schema.String, decodedArguments?.['command'])
  return decode(vibeToolCallSchema, {
    ...(name !== undefined ? { name } : {}),
    ...(command !== undefined ? { command } : {}),
  })
}

function normalizeMessage(input: MessageInput): VibeMessage | undefined {
  const toolCallsInput = decode(Schema.Array(Schema.Unknown), input.tool_calls) ?? []
  const toolCalls = toolCallsInput.flatMap(toolCall => {
    const decoded = decode(toolCallInputSchema, toolCall)
    return decoded ? [normalizeToolCall(decoded)] : []
  })
  const role = decode(Schema.String, input.role)
  const content = normalizeContent(input.content)
  const messageId = decode(Schema.String, input.message_id)
  const timestamp = decode(Schema.String, input.timestamp)
  return decode(vibeMessageSchema, {
    ...(role !== undefined ? { role } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    toolCalls,
  })
}

const statMatches = Effect.fnUntraced(function* (
  path: string,
  predicate: (value: Awaited<ReturnType<typeof stat>>) => boolean,
  signal?: AbortSignal,
): Effect.fn.Return<boolean, Error> {
  yield* checkAbort(signal)
  const result = yield* Effect.uninterruptible(
    Effect.result(Effect.tryPromise({ try: () => stat(path), catch: toError })),
  )
  yield* checkAbort(signal)
  return Result.isSuccess(result) && predicate(result.success)
})

function isFileEffect(path: string, signal?: AbortSignal) {
  return statMatches(path, value => value.isFile(), signal)
}

function isDirectoryEffect(path: string, signal?: AbortSignal) {
  return statMatches(path, value => value.isDirectory(), signal)
}

const readdirEffect = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<string[], Error> {
  yield* checkAbort(signal)
  const result = yield* Effect.uninterruptible(
    Effect.result(Effect.tryPromise({ try: () => readdir(path), catch: toError })),
  )
  yield* checkAbort(signal)
  return Result.isSuccess(result) ? result.success.sort() : []
})

const hasSessionFilesEffect = Effect.fnUntraced(function* (
  dir: string,
  signal?: AbortSignal,
): Effect.fn.Return<boolean, Error> {
  if (!(yield* isFileEffect(join(dir, METADATA_FILENAME), signal))) return false
  return yield* isFileEffect(join(dir, MESSAGES_FILENAME), signal)
})

const discoverSessionDirsEffect = Effect.fn('discoverMistralVibeSessionDirs')(function* (
  root: string,
  signal?: AbortSignal,
): Effect.fn.Return<string[], Error> {
  const sessionDirs: string[] = []
  for (const entry of yield* readdirEffect(root, signal)) {
    const dir = join(root, entry)
    if (!(yield* isDirectoryEffect(dir, signal))) continue
    if (yield* hasSessionFilesEffect(dir, signal)) sessionDirs.push(dir)

    const agentsDir = join(dir, 'agents')
    if (!(yield* isDirectoryEffect(agentsDir, signal))) continue
    for (const agentEntry of yield* readdirEffect(agentsDir, signal)) {
      const agentDir = join(agentsDir, agentEntry)
      if ((yield* isDirectoryEffect(agentDir, signal)) && (yield* hasSessionFilesEffect(agentDir, signal))) {
        sessionDirs.push(agentDir)
      }
    }
  }
  return sessionDirs
})

function activeModel(metadata: VibeMetadata): string | undefined {
  return metadata.config?.activeModel
}

function activeModelConfig(metadata: VibeMetadata): VibeModelConfig | null {
  const name = activeModel(metadata)
  if (!name) return null
  return metadata.config?.models.find(model => model.alias === name || model.name === name) ?? null
}

function resolveModel(metadata: VibeMetadata): string {
  const name = activeModel(metadata)
  if (name) return name
  const configured = activeModelConfig(metadata)
  return configured?.alias ?? configured?.name ?? DEFAULT_MODEL
}

function calculateSessionCost(
  metadata: VibeMetadata,
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: ScanPricing,
): number {
  const sessionCost = metadata.stats.sessionCost
  if (sessionCost > 0) return sessionCost

  const configured = activeModelConfig(metadata)
  const inputPrice = metadata.stats.inputPricePerMillion || configured?.inputPrice || 0
  const outputPrice = metadata.stats.outputPricePerMillion || configured?.outputPrice || 0

  if (inputPrice > 0 || outputPrice > 0) {
    return (inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice
  }

  return pricing.calculateCost(model, inputTokens, outputTokens, 0, 0, 0)
}

function extractMessageTools(message: VibeMessage): { tools: string[]; bashCommands: string[] } {
  const tools: string[] = []
  const bashCommands: string[] = []

  if (message.role !== 'assistant') return { tools, bashCommands }

  for (const toolCall of message.toolCalls) {
    const rawName = toolCall.name
    if (!rawName) continue

    const mappedName = toolNameMap[rawName] ?? rawName
    tools.push(mappedName)

    if (mappedName !== 'Bash') continue
    if (toolCall.command) bashCommands.push(...extractBashCommands(toolCall.command))
  }

  return {
    tools: [...new Set(tools)],
    bashCommands: [...new Set(bashCommands)],
  }
}

function extractTools(messages: VibeMessage[]): { tools: string[]; bashCommands: string[] } {
  const tools: string[] = []
  const bashCommands: string[] = []

  for (const message of messages) {
    const extracted = extractMessageTools(message)
    tools.push(...extracted.tools)
    bashCommands.push(...extracted.bashCommands)
  }

  return {
    tools: [...new Set(tools)],
    bashCommands: [...new Set(bashCommands)],
  }
}

function readMessagesEffect(path: string, signal?: AbortSignal): Effect.Effect<VibeMessage[], Error> {
  return readSessionLinesStream(path, undefined, signal ? { signal } : {}).pipe(
    Stream.mapEffect(line =>
      Effect.sync<Result.Result<VibeMessage, undefined>>(() => {
        const input = decode(Schema.fromJsonString(messageInputSchema), line.toString('utf-8'))
        const message = input && normalizeMessage(input)
        return message ? Result.succeed(message) : Result.fail(undefined)
      }),
    ),
    Stream.filterMap(message => message),
    Stream.runCollect,
    Effect.map(messages => [...messages]),
  )
}

function firstUserMessage(messages: VibeMessage[], fallback?: string | null): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = (message.content ?? '').trim()
    if (text) return text.slice(0, 500)
  }
  return (fallback ?? '').slice(0, 500)
}

function allocateInteger(total: number, index: number, count: number): number {
  if (count <= 1) return total
  const base = Math.floor(total / count)
  const remainder = total % count
  return base + (index < remainder ? 1 : 0)
}

function allocateCost(total: number, count: number): number {
  return count <= 1 ? total : total / count
}

function parseMessageLines(
  source: SessionSource,
  seenKeys: Set<string>,
  metadata: VibeMetadata,
  messages: VibeMessage[],
  pricing: ScanPricing,
): Stream.Stream<ParsedProviderCall> {
  const inputTokens = metadata.stats.sessionPromptTokens
  const outputTokens = metadata.stats.sessionCompletionTokens
  const sessionId = metadata.sessionId || basename(source.path)
  const model = resolveModel(metadata)
  const costUSD = calculateSessionCost(metadata, model, inputTokens, outputTokens, pricing)
  const assistantMessages = messages.filter(message => message.role === 'assistant')
  const fallbackTimestamp = metadata.endTime ?? metadata.startTime ?? ''
  const title = metadata.title ?? ''

  if (assistantMessages.length === 0) {
    const deduplicationKey = `mistral-vibe:${sessionId}`
    const fallbackCall: ParsedProviderCall = {
      provider: 'mistral-vibe',
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD,
      ...extractTools(messages),
      timestamp: fallbackTimestamp,
      speed: 'standard',
      deduplicationKey,
      userMessage: firstUserMessage(messages, title),
      sessionId,
    }
    return Stream.unwrap(
      Effect.suspend(() => {
        if (seenKeys.has(deduplicationKey)) return Effect.succeed(Stream.empty)
        return Effect.sync(() => seenKeys.add(deduplicationKey)).pipe(Effect.map(() => Stream.succeed(fallbackCall)))
      }),
    )
  }

  let currentUserMessage = title.slice(0, 500)
  let turnOrdinal = 0
  let currentTurnId = `${sessionId}:prelude`
  let assistantOrdinal = 0
  return Stream.fromIterable(messages).pipe(
    Stream.rechunk(1),
    Stream.mapEffect(message =>
      Effect.sync<Result.Result<ParsedProviderCall, undefined>>(() => {
        if (message.role === 'user') {
          const text = (message.content ?? '').trim()
          if (text) currentUserMessage = text.slice(0, 500)
          currentTurnId = `${sessionId}:turn-${turnOrdinal++}`
          return Result.fail(undefined)
        }
        if (message.role !== 'assistant') return Result.fail(undefined)

        const messageKey = message.messageId || `idx-${assistantOrdinal}`
        const deduplicationKey = `mistral-vibe:${sessionId}:${messageKey}`
        const allocationIndex = assistantOrdinal++
        if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)
        seenKeys.add(deduplicationKey)

        return Result.succeed({
          provider: 'mistral-vibe',
          model,
          inputTokens: allocateInteger(inputTokens, allocationIndex, assistantMessages.length),
          outputTokens: allocateInteger(outputTokens, allocationIndex, assistantMessages.length),
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD: allocateCost(costUSD, assistantMessages.length),
          ...extractMessageTools(message),
          timestamp: message.timestamp ?? fallbackTimestamp,
          speed: 'standard',
          deduplicationKey,
          turnId: currentTurnId,
          userMessage: currentUserMessage,
          sessionId,
        } satisfies ParsedProviderCall)
      }),
    ),
    Stream.filterMap(call => call),
  )
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing: ScanPricing,
  context?: ProviderScanContext,
): SessionParser {
  const signal = context?.signal
  const parseEffect = Effect.fn('parseMistralVibeSession')(function* (): Effect.fn.Return<
    Stream.Stream<ParsedProviderCall>,
    Error
  > {
    yield* checkAbort(signal)
    const metadataInput = yield* readJsonEffect(join(source.path, METADATA_FILENAME), metadataInputSchema, signal)
    yield* checkAbort(signal)
    const metadata = metadataInput && normalizeMetadata(metadataInput)
    if (!metadata) return Stream.empty
    const inputTokens = metadata.stats.sessionPromptTokens
    const outputTokens = metadata.stats.sessionCompletionTokens
    if (inputTokens === 0 && outputTokens === 0) return Stream.empty
    const messages = yield* readMessagesEffect(join(source.path, MESSAGES_FILENAME), signal)
    yield* checkAbort(signal)
    return parseMessageLines(source, seenKeys, metadata, messages, pricing)
  })
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> => Stream.unwrap(parseEffect())

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

export function createMistralVibeProvider(sessionsDir?: string): Provider {
  const dir = getMistralVibeSessionsDir(sessionsDir)
  const discoverEffect = Effect.fn('discoverMistralVibeSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkAbort(context?.signal)
    const dirs = yield* discoverSessionDirsEffect(dir, context?.signal)
    const sources: SessionSource[] = []
    for (const sessionDir of dirs) {
      yield* checkAbort(context?.signal)
      const metadataInput = yield* readJsonEffect(
        join(sessionDir, METADATA_FILENAME),
        metadataInputSchema,
        context?.signal,
      )
      yield* checkAbort(context?.signal)
      const metadata = metadataInput && normalizeMetadata(metadataInput)
      if (!metadata) continue
      const cwd = metadata.environment?.workingDirectory
      sources.push({
        path: sessionDir,
        project: cwd ? basename(cwd) : basename(sessionDir),
        provider: 'mistral-vibe',
      })
    }
    return sources
  })

  return {
    name: 'mistral-vibe',
    displayName: 'Mistral Vibe',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    discoverSessionsEffect: discoverEffect,

    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // Compatibility edge for callers that have not moved to Effect.
      // eslint-disable-next-line no-restricted-syntax
      return Effect.runPromise(discoverEffect(context))
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      const pricing = context?.pricing ?? captureScanPricing()
      return createParser(source, seenKeys, pricing, context)
    },
  }
}

export const mistralVibe = createMistralVibeProvider()
