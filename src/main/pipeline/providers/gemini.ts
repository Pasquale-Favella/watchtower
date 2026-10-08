import { Effect, Result, Schema, Stream } from 'effect'
import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { billableOutputTokens } from '../billable-output.js'
import { MAX_SESSION_FILE_BYTES, readSessionFileEffect, readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing } from '../models.js'
import { scanAbortError } from '../scan-control.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const toolNameMap: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  create_file: 'Write',
  delete_file: 'Delete',
  list_dir: 'LS',
  grep_search: 'Grep',
  search_files: 'Grep',
  find_files: 'Glob',
  run_command: 'Bash',
  web_search: 'WebSearch',
  ReadFile: 'Read',
  WriteFile: 'Write',
  EditFile: 'Edit',
  ListDir: 'LS',
  SearchText: 'Grep',
  Shell: 'Bash',
}

const geminiTokensSchema = Schema.Struct({
  input: Schema.optional(Schema.NullOr(Schema.Finite)),
  output: Schema.optional(Schema.NullOr(Schema.Finite)),
  cached: Schema.optional(Schema.NullOr(Schema.Finite)),
  thoughts: Schema.optional(Schema.NullOr(Schema.Finite)),
})

const geminiToolCallSchema = Schema.Struct({
  name: Schema.String,
  args: Schema.optional(Schema.Unknown),
  displayName: Schema.optional(Schema.String),
})

const geminiMessageSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.Literals(['user', 'gemini', 'info']),
  content: Schema.optional(Schema.Unknown),
  tokens: Schema.optional(Schema.NullOr(geminiTokensSchema)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  toolCalls: Schema.optional(Schema.Unknown),
})

const geminiSessionSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  startTime: Schema.optional(Schema.Unknown),
  messages: Schema.Array(Schema.Unknown),
})

const geminiSessionHeaderSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  startTime: Schema.NonEmptyString,
})

const geminiDateInputSchema = Schema.Union([Schema.String, Schema.Number])
const geminiUserContentSchema = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
])
const geminiSetLineSchema = Schema.Struct({ $set: Schema.Unknown })
type GeminiMessage = typeof geminiMessageSchema.Type
type GeminiSession = {
  sessionId: typeof geminiSessionSchema.Type.sessionId
  startTime: string | number
  messages: GeminiMessage[]
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function checkAbort(signal?: AbortSignal): Effect.Effect<void, Error> {
  return Effect.suspend(() => (signal?.aborted ? Effect.fail(scanAbortError(signal)) : Effect.void))
}

/** Directory and file-system calls must settle before an interrupted scan releases ownership. */
function fileIo<A>(operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.uninterruptible(Effect.tryPromise({ try: operation, catch: toError }))
}

function decodeWholeSession(raw: string): GeminiSession | null {
  const wholeSession = Schema.decodeUnknownResult(Schema.fromJsonString(geminiSessionSchema))(raw)
  if (Result.isFailure(wholeSession)) return null
  const fallback = Schema.decodeUnknownResult(geminiDateInputSchema)(wholeSession.success.startTime)
  return {
    sessionId: wholeSession.success.sessionId,
    startTime: Result.isSuccess(fallback) ? fallback.success : '',
    messages: wholeSession.success.messages.flatMap(message => {
      const parsed = Schema.decodeUnknownResult(geminiMessageSchema)(message)
      return Result.isSuccess(parsed) ? [parsed.success] : []
    }),
  }
}

function decodeSession(raw: string): GeminiSession | null {
  const wholeSession = decodeWholeSession(raw)
  if (wholeSession) return wholeSession

  let header: Pick<GeminiSession, 'sessionId' | 'startTime'> | undefined
  const messages: GeminiMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const decodedLine = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(line)
    if (Result.isFailure(decodedLine)) continue
    const value = decodedLine.success
    if (Result.isSuccess(Schema.decodeUnknownResult(geminiSetLineSchema)(value))) continue

    const candidateHeader = Schema.decodeUnknownResult(geminiSessionHeaderSchema)(value)
    if (Result.isSuccess(candidateHeader) && !header) {
      header = candidateHeader.success
      continue
    }

    const message = Schema.decodeUnknownResult(geminiMessageSchema)(value)
    if (Result.isSuccess(message)) messages.push(message.success)
  }
  return header ? { ...header, messages } : null
}

function createMessageReducer(
  sessionId: string,
  startTime: string | number,
  seenKeys: Set<string>,
  pricing: NonNullable<ProviderScanContext['pricing']>,
): (msg: GeminiMessage) => ParsedProviderCall | undefined {
  let lastUserMessage = ''
  let turnOrdinal = 0
  let currentTurnId = `${sessionId}:prelude`
  let geminiOrdinal = 0

  return (msg): ParsedProviderCall | undefined => {
    if (msg.type === 'user') {
      const content = Schema.decodeUnknownResult(geminiUserContentSchema)(msg.content)
      if (Result.isSuccess(content)) {
        if (typeof content.success === 'string') {
          lastUserMessage = content.success.slice(0, 500)
        } else {
          lastUserMessage = content.success
            .map(content => content.text ?? '')
            .join(' ')
            .slice(0, 500)
        }
      }
      currentTurnId = `${sessionId}:turn-${turnOrdinal++}`
      return undefined
    }

    if (msg.type !== 'gemini' || !msg.tokens || !msg.model) return undefined

    const tokens = msg.tokens
    const totalInput = tokens.input ?? 0
    const totalOutput = tokens.output ?? 0
    const totalCached = tokens.cached ?? 0
    const totalThoughts = tokens.thoughts ?? 0
    if (totalInput === 0 && totalOutput === 0 && totalCached === 0 && totalThoughts === 0) return undefined

    const messageKey = msg.id || `idx-${geminiOrdinal}`
    geminiOrdinal++
    const dedupKey = `gemini:${sessionId}:${messageKey}`
    if (seenKeys.has(dedupKey)) return undefined

    const tools: string[] = []
    const bashCommands: string[] = []
    const toolCalls = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))(msg.toolCalls)
    for (const candidate of Result.isSuccess(toolCalls) ? toolCalls.success : []) {
      const toolCallResult = Schema.decodeUnknownResult(geminiToolCallSchema)(candidate)
      if (Result.isFailure(toolCallResult)) continue
      const toolCall = toolCallResult.success
      const mapped =
        toolNameMap[toolCall.displayName ?? ''] ?? toolNameMap[toolCall.name] ?? toolCall.displayName ?? toolCall.name
      tools.push(mapped)
      const args = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Unknown))(toolCall.args)
      const command = Result.isSuccess(args) ? args.success['command'] : undefined
      const decodedCommand = Schema.decodeUnknownResult(Schema.optional(Schema.NullOr(Schema.String)))(command)
      if (mapped === 'Bash' && Result.isSuccess(decodedCommand) && decodedCommand.success) {
        bashCommands.push(...extractBashCommands(decodedCommand.success))
      }
    }

    // Gemini input includes cached tokens as a subset. Thoughts are billed at
    // the output rate, while output and reasoning remain separately reported.
    const freshInput = Math.max(0, totalInput - totalCached)
    const timestamp = new Date(msg.timestamp || startTime)
    if (Number.isNaN(timestamp.getTime()) || timestamp.getTime() < 1_000_000_000_000) return undefined

    seenKeys.add(dedupKey)
    const costUSD = pricing.calculateCost(
      msg.model,
      freshInput,
      billableOutputTokens('gemini', totalOutput, totalThoughts),
      0,
      totalCached,
      0,
    )
    return {
      provider: 'gemini',
      model: msg.model,
      inputTokens: freshInput,
      outputTokens: totalOutput,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: totalCached,
      cachedInputTokens: totalCached,
      reasoningTokens: totalThoughts,
      webSearchRequests: 0,
      costUSD,
      tools: [...new Set(tools)],
      bashCommands: [...new Set(bashCommands)],
      timestamp: timestamp.toISOString(),
      speed: 'standard',
      deduplicationKey: dedupKey,
      turnId: currentTurnId,
      userMessage: lastUserMessage,
      sessionId,
    }
  }
}

function parseSession(
  data: GeminiSession,
  seenKeys: Set<string>,
  pricing: NonNullable<ProviderScanContext['pricing']>,
): ParsedProviderCall[] {
  const reduceMessage = createMessageReducer(data.sessionId, data.startTime, seenKeys, pricing)
  return data.messages.flatMap(message => {
    const call = reduceMessage(message)
    return call ? [call] : []
  })
}

const getGeminiTmpDir = (): string => join(homedir(), '.gemini', 'tmp')

const discoverSessionsEffect = Effect.fnUntraced(function* (
  root: string,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  yield* checkAbort(context?.signal)
  const projects = yield* Effect.result(fileIo(() => readdir(root, { withFileTypes: true })))
  yield* checkAbort(context?.signal)
  if (Result.isFailure(projects)) return []

  const sources: SessionSource[] = []
  for (const projectEntry of projects.success) {
    yield* checkAbort(context?.signal)
    if (!projectEntry.isDirectory()) continue
    const project = projectEntry.name
    const chatsDir = join(root, project, 'chats')
    const entries = yield* Effect.result(fileIo(() => readdir(chatsDir)))
    yield* checkAbort(context?.signal)
    if (Result.isFailure(entries)) continue

    for (const file of entries.success) {
      yield* checkAbort(context?.signal)
      if (!file.startsWith('session-') || (!file.endsWith('.json') && !file.endsWith('.jsonl'))) continue
      const filePath = join(chatsDir, file)
      const fileStat = yield* Effect.result(fileIo(() => stat(filePath)))
      yield* checkAbort(context?.signal)
      if (Result.isSuccess(fileStat) && fileStat.success.isFile()) {
        sources.push({ path: filePath, project, provider: 'gemini' })
      }
    }
  }
  return sources
})

function parseJsonlStream(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing: NonNullable<ProviderScanContext['pricing']>,
  signal?: AbortSignal,
): Stream.Stream<ParsedProviderCall, Error> {
  let reduceMessage: ReturnType<typeof createMessageReducer> | undefined
  let pendingMessages: GeminiMessage[] = []
  const fallbackLines: string[] = []
  let legacyWholeSession = false

  return readSessionLinesStream(source.path, undefined, { maxBytes: MAX_SESSION_FILE_BYTES, signal }).pipe(
    Stream.rechunk(1),
    Stream.mapEffect(line =>
      Effect.gen(function* () {
        yield* checkAbort(signal)
        const raw = typeof line === 'string' ? line : line.toString('utf8')
        if (!reduceMessage) {
          fallbackLines.push(raw)
          if (decodeWholeSession(raw)) legacyWholeSession = true
          if (legacyWholeSession) return []
        }

        const decodedLine = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(raw)
        if (Result.isFailure(decodedLine)) return []
        const value = decodedLine.success
        if (Result.isSuccess(Schema.decodeUnknownResult(geminiSetLineSchema)(value))) return []

        const header = Schema.decodeUnknownResult(geminiSessionHeaderSchema)(value)
        if (Result.isSuccess(header) && !reduceMessage) {
          reduceMessage = createMessageReducer(header.success.sessionId, header.success.startTime, seenKeys, pricing)
          fallbackLines.length = 0
          const calls = pendingMessages.flatMap(message => {
            const call = reduceMessage?.(message)
            return call ? [call] : []
          })
          pendingMessages = []
          return calls
        }

        const parsed = Schema.decodeUnknownResult(geminiMessageSchema)(value)
        if (Result.isFailure(parsed)) return []
        if (!reduceMessage) {
          pendingMessages.push(parsed.success)
          return []
        }
        const call = reduceMessage(parsed.success)
        return call ? [call] : []
      }),
    ),
    Stream.flatMap(calls => Stream.fromIterable(calls)),
    Stream.concat(
      Stream.suspend(() => {
        if (reduceMessage) return Stream.empty
        const session = decodeSession(fallbackLines.join('\n'))
        return session ? Stream.fromIterable(parseSession(session, seenKeys, pricing)) : Stream.empty
      }),
    ),
    Stream.rechunk(1),
    Stream.mapEffect(call => checkAbort(signal).pipe(Effect.as(call))),
  )
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> => {
    if (source.path.endsWith('.jsonl')) {
      return parseJsonlStream(source, seenKeys, pricing, context?.signal)
    }
    return Stream.unwrap(
      Effect.gen(function* () {
        yield* checkAbort(context?.signal)
        const raw = yield* readSessionFileEffect(source.path, 'utf-8', { signal: context?.signal })
        yield* checkAbort(context?.signal)
        if (raw === null) return Stream.empty
        const session = decodeSession(raw)
        if (!session) return Stream.empty
        return Stream.fromIterable(parseSession(session, seenKeys, pricing)).pipe(
          Stream.rechunk(1),
          Stream.mapEffect(call => checkAbort(context?.signal).pipe(Effect.as(call))),
        )
      }),
    )
  }

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

export function createGeminiProvider(geminiTmpDir?: string): Provider {
  const root = (): string => geminiTmpDir ?? getGeminiTmpDir()

  return {
    name: 'gemini',
    displayName: 'Gemini',

    modelDisplayName(model: string): string {
      if (model === 'gemini-auto') return 'Gemini (auto)'
      const display: Record<string, string> = {
        'gemini-3-flash-preview': 'Gemini 3 Flash',
        'gemini-3.5-flash': 'Gemini 3.5 Flash',
        'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
        'gemini-2.5-pro': 'Gemini 2.5 Pro',
        'gemini-2.5-flash': 'Gemini 2.5 Flash',
        'gemini-2.0-flash': 'Gemini 2.0 Flash',
      }
      return display[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    discoverSessionsEffect(context?: ProviderScanContext): Effect.Effect<SessionSource[], Error> {
      return discoverSessionsEffect(root(), context)
    },

    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // This is the legacy Promise edge; scan orchestration consumes the Effect hook above.
      // eslint-disable-next-line no-restricted-syntax
      return Effect.runPromise(discoverSessionsEffect(root(), context))
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

export const gemini = createGeminiProvider()
