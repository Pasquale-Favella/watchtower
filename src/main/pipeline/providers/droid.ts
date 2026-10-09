import { Effect, Result, Schema, Stream } from 'effect'
import { readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { billableOutputTokens } from '../billable-output.js'
import { MAX_SESSION_FILE_BYTES, MAX_STREAM_SESSION_FILE_BYTES, readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing, getShortModelName } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, readDirectoryOrEmpty, scanIo } from '../scan-io.js'
import type { ScanPricing } from '../scan-pricing.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const toolNameMap: Record<string, string> = {
  Read: 'Read',
  Create: 'Create',
  Edit: 'Edit',
  MultiEdit: 'MultiEdit',
  LS: 'LS',
  Glob: 'Glob',
  Grep: 'Grep',
  Execute: 'Bash',
  AskUser: 'AskUser',
  TodoWrite: 'TodoWrite',
  Skill: 'Skill',
  Task: 'Agent',
  WebSearch: 'WebSearch',
  FetchUrl: 'FetchUrl',
  GenerateDroid: 'GenerateDroid',
  ExitSpecMode: 'ExitSpecMode',
}

const nullableString = Schema.NullOr(Schema.String)
const tokenUsageSchema = Schema.Struct({
  inputTokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  outputTokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  cacheCreationTokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  cacheReadTokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  thinkingTokens: Schema.optional(Schema.NullOr(Schema.Finite)),
})
const settingsSchema = Schema.Struct({
  model: Schema.optional(nullableString),
  tokenUsage: Schema.optional(Schema.NullOr(tokenUsageSchema)),
})
const contentBlockSchema = Schema.Struct({
  type: Schema.optional(nullableString),
  text: Schema.optional(nullableString),
  name: Schema.optional(nullableString),
  input: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
})
const messageSchema = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
})
const sessionStartSchema = Schema.Struct({
  type: Schema.Literals(['session_start']),
  id: Schema.optional(nullableString),
  cwd: Schema.optional(nullableString),
})
const entrySchema = Schema.Union([
  Schema.Struct({ type: sessionStartSchema.fields.type, id: sessionStartSchema.fields.id }),
  Schema.Struct({
    type: Schema.Literals(['message']),
    id: Schema.optional(nullableString),
    timestamp: Schema.optional(nullableString),
    message: Schema.optional(Schema.NullOr(messageSchema)),
  }),
])
type DroidSettings = Schema.Schema.Type<typeof settingsSchema>
type DroidSessionStart = Schema.Schema.Type<typeof sessionStartSchema>
type DroidContent = Schema.Schema.Type<typeof contentBlockSchema>
const decodeSettingsJson = Schema.decodeUnknownResult(Schema.fromJsonString(settingsSchema))
const decodeSessionStartJson = Schema.decodeUnknownResult(Schema.fromJsonString(sessionStartSchema))
const decodeEntryJson = Schema.decodeUnknownResult(Schema.fromJsonString(entrySchema))
const decodeString = Schema.decodeUnknownResult(Schema.String)
const decodeUnknownArray = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))
const decodeContentBlock = Schema.decodeUnknownResult(contentBlockSchema)

function getFactoryDir(): string {
  return process.env['FACTORY_DIR'] ?? join(homedir(), '.factory')
}

// Strip Droid-specific wrapper to get the model's display name.
// e.g. "custom:GLM-5.1-[Proxy]-0" -> "GLM-5.1"
// Cost lookup is handled by the pipeline's existing calculateCost/getCanonicalName
// which normalizes case and strips date suffixes automatically.
function stripModelPrefix(raw: string): string {
  return raw
    .replace(/^custom:/, '')
    .replace(/\[.*?\]/g, '')
    .replace(/-\d+$/, '')
    .replace(/-+$/, '')
    .replace(/^-/, '')
}

function parseModelForDisplay(raw: string): string {
  const stripped = stripModelPrefix(raw)
  const lower = stripped.toLowerCase()

  if (lower.includes('opus')) return getShortModelName(stripped)
  if (lower.includes('sonnet')) return getShortModelName(stripped)
  if (lower.includes('haiku')) return getShortModelName(stripped)
  if (lower.startsWith('gpt-')) return getShortModelName(stripped)
  if (lower.startsWith('o3') || lower.startsWith('o4')) return getShortModelName(stripped)
  if (lower.startsWith('gemini')) return getShortModelName(stripped)

  return stripped
}

/** Extract the primary shell command from the first logical line. */
function extractDroidBashCommands(command: string): string[] {
  if (!command || !command.trim()) return []
  return extractBashCommands(command.split('\n').at(0)?.trim() ?? '')
}

function decodeContent(content: unknown): DroidContent[] {
  const decodedText = decodeString(content)
  if (Result.isSuccess(decodedText)) return [{ type: 'text', text: decodedText.success }]
  const blocks = decodeUnknownArray(content)
  if (Result.isFailure(blocks)) return []
  return blocks.success.flatMap(block => {
    const decoded = decodeContentBlock(block)
    return Result.isSuccess(decoded) ? [decoded.success] : []
  })
}

const readSettingsEffect = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<DroidSettings, Error> {
  return yield* scanIo(() => readFile(path, 'utf-8'), signal).pipe(
    Effect.map(raw => {
      const decoded = decodeSettingsJson(raw)
      return Result.isSuccess(decoded) ? decoded.success : {}
    }),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed({}))),
  )
})

const directoryExists = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<boolean, Error> {
  return yield* scanIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isDirectory()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
})

function isInternalSession(cwd: string, factoryDir: string): boolean {
  const normalized = cwd.replace(/\/+$/, '')
  return normalized === factoryDir
}

function deriveProjectName(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, '')
  const home = homedir()
  let relative = normalized.startsWith(home)
    ? normalized.slice(home.length).replace(/^\/+/, '')
    : normalized.replace(/^\/+/, '')
  if (!relative) relative = '~'
  const parts = relative.split('/')
  const projectsIdx = parts.lastIndexOf('projects')
  if (projectsIdx !== -1 && projectsIdx + 1 < parts.length) return parts.slice(projectsIdx + 1).join('/')
  return parts.join('/')
}

const readFirstEntry = Effect.fn('readDroidSessionHeader')(function* (
  filePath: string,
  signal?: AbortSignal,
): Effect.fn.Return<DroidSessionStart | null, Error> {
  const lines = yield* Stream.runCollect(
    readSessionLinesStream(filePath, undefined, {
      maxBytes: MAX_STREAM_SESSION_FILE_BYTES,
      ...(signal ? { signal } : {}),
    }).pipe(Stream.take(1)),
  )
  yield* checkScanAbort(signal)
  const line = lines.at(0)
  if (line === undefined) return null
  const decoded = decodeSessionStartJson(line.toString())
  return Result.isSuccess(decoded) ? decoded.success : null
})

const discoverSessionsInDir = Effect.fn('discoverDroidSessionsInDir')(function* (
  sessionsDir: string,
  factoryDir: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const sources: SessionSource[] = []
  const entries = yield* readDirectoryOrEmpty(sessionsDir, signal)
  for (const entry of entries) {
    yield* checkScanAbort(signal)
    const subDir = join(sessionsDir, entry)
    if (!(yield* directoryExists(subDir, signal))) continue
    const files = yield* readDirectoryOrEmpty(subDir, signal)
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(subDir, file)
      const first = yield* readFirstEntry(filePath, signal).pipe(
        Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
      )
      if (first?.type !== 'session_start') continue
      const cwd = first.cwd ?? entry
      if (isInternalSession(cwd, factoryDir)) continue
      sources.push({ path: filePath, project: deriveProjectName(cwd), provider: 'droid' })
    }
  }
  return sources
})

type AssistantCall = {
  readonly id: string
  readonly timestamp: string
  readonly tools: string[]
  readonly bashCommands: string[]
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing: ScanPricing,
  context?: ProviderScanContext,
): SessionParser {
  const signal = context?.signal
  const parseEffect = Effect.fn('parseDroidSession')(function* (): Effect.fn.Return<
    Stream.Stream<ParsedProviderCall, Error>,
    Error
  > {
    yield* checkScanAbort(signal)
    let sessionId = ''
    let currentUserMessage = ''
    const assistantCalls: AssistantCall[] = []
    let pendingTools: string[] = []
    let pendingBashCommands: string[] = []

    yield* Stream.runForEach(
      readSessionLinesStream(source.path, undefined, {
        // Preserve the old capped readSessionFile behavior; the shared reader
        // also queues its standard oversize notice when this limit is exceeded.
        maxBytes: MAX_SESSION_FILE_BYTES,
        ...(signal ? { signal } : {}),
      }),
      lineValue =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const decodedEntry = decodeEntryJson(lineValue.toString())
          if (Result.isFailure(decodedEntry)) return
          const entry = decodedEntry.success
          if (entry.type === 'session_start') {
            sessionId = entry.id ?? ''
            return
          }
          if (entry.type !== 'message' || !entry.message) return
          const message = entry.message

          if (message.role === 'user') {
            const texts = decodeContent(message.content).flatMap(block =>
              block.type === 'text' && block.text ? [block.text] : [],
            )
            const nonSystemTexts = texts.filter(text => !text.startsWith('<system-reminder>'))
            if (nonSystemTexts.length > 0) currentUserMessage = nonSystemTexts.join(' ').slice(0, 500)
            return
          }

          if (message.role !== 'assistant') return
          const content = decodeContent(message.content)
          let hasText = false
          for (const block of content) {
            if (block.type === 'text' && block.text) hasText = true
            if (block.type !== 'tool_use') continue

            const toolUse = block
            const toolName = toolUse.name ?? ''
            pendingTools.push(toolNameMap[toolName] ?? toolName)
            const command = toolUse.input?.['command']
            if (toolName === 'Execute' && typeof command === 'string') {
              pendingBashCommands.push(...extractDroidBashCommands(command))
            }
          }
          if (pendingTools.length > 0 || hasText) {
            assistantCalls.push({
              id: entry.id ?? `msg-${assistantCalls.length}`,
              timestamp: entry.timestamp ?? '',
              tools: [...pendingTools],
              bashCommands: [...pendingBashCommands],
            })
            pendingTools = []
            pendingBashCommands = []
          }
        }),
    )
    yield* checkScanAbort(signal)

    if (assistantCalls.length === 0) return Stream.empty
    const settingsPath = source.path.replace(/\.jsonl$/, '.settings.json')
    const settings = yield* readSettingsEffect(settingsPath, signal)
    const usage = settings.tokenUsage
    if (!usage) return Stream.empty

    // Droid records token usage only at session level. Allocate across every
    // accepted assistant call before deduplication so cached calls keep their share.
    const totalInput = usage.inputTokens ?? 0
    const totalOutput = usage.outputTokens ?? 0
    const totalCacheCreation = usage.cacheCreationTokens ?? 0
    const totalCacheRead = usage.cacheReadTokens ?? 0
    const totalThinking = usage.thinkingTokens ?? 0
    const numCalls = assistantCalls.length
    const inputPerCall = Math.floor(totalInput / numCalls)
    const outputPerCall = Math.floor(totalOutput / numCalls)
    const cacheCreationPerCall = Math.floor(totalCacheCreation / numCalls)
    const cacheReadPerCall = Math.floor(totalCacheRead / numCalls)
    const thinkingPerCall = Math.floor(totalThinking / numCalls)
    const model = settings.model ? stripModelPrefix(settings.model) : 'unknown'
    return Stream.fromIterable(assistantCalls.entries()).pipe(
      Stream.rechunk(1),
      Stream.mapEffect(([index, call]) =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const deduplicationKey = `droid:${sessionId}:${call.id}`
          if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)

          const isLast = index === numCalls - 1
          const inputTokens = isLast ? totalInput - inputPerCall * (numCalls - 1) : inputPerCall
          const outputTokens = isLast ? totalOutput - outputPerCall * (numCalls - 1) : outputPerCall
          const cacheCreationTokens = isLast
            ? totalCacheCreation - cacheCreationPerCall * (numCalls - 1)
            : cacheCreationPerCall
          const cacheReadTokens = isLast ? totalCacheRead - cacheReadPerCall * (numCalls - 1) : cacheReadPerCall
          const thinkingTokens = isLast ? totalThinking - thinkingPerCall * (numCalls - 1) : thinkingPerCall
          seenKeys.add(deduplicationKey)
          const parsedCall: ParsedProviderCall = {
            provider: 'droid',
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: cacheCreationTokens,
            cacheReadInputTokens: cacheReadTokens,
            cachedInputTokens: cacheReadTokens,
            reasoningTokens: thinkingTokens,
            webSearchRequests: 0,
            costUSD: pricing.calculateCost(
              model.toLowerCase(),
              inputTokens,
              billableOutputTokens('droid', outputTokens, thinkingTokens),
              cacheCreationTokens,
              cacheReadTokens,
              0,
            ),
            tools: call.tools,
            bashCommands: call.bashCommands,
            timestamp: call.timestamp,
            speed: 'standard',
            deduplicationKey,
            userMessage: index === 0 ? currentUserMessage : '',
            sessionId,
          }
          return Result.succeed(parsedCall)
        }),
      ),
      Stream.filterMap(call => call),
    )
  })

  return {
    parseStream: () => Stream.unwrap(parseEffect()),
    // Remove when scan/parser and external iterator callers have migrated to parseStream.
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(Stream.unwrap(parseEffect()))
    },
  }
}

export function createDroidProvider(factoryDir?: string): Provider {
  const base = factoryDir ?? getFactoryDir()
  const sessionsDir = join(base, 'sessions')
  const discoverEffect = Effect.fn('discoverDroidSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkScanAbort(context?.signal)
    return yield* discoverSessionsInDir(sessionsDir, base, context?.signal)
  })

  return {
    name: 'droid',
    displayName: 'Droid',
    modelDisplayName(model: string): string {
      return parseModelForDisplay(model)
    },
    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },
    discoverSessionsEffect: discoverEffect,
    // Remove when every discovery caller uses the native Effect entry point.
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // Compatibility edge for external callers of the Promise provider API.
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

export const droid = createDroidProvider()
