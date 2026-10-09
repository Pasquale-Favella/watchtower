import { Effect, Result, Schema, Stream } from 'effect'
import { stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { billableOutputTokens } from '../billable-output.js'
import { MAX_SESSION_FILE_BYTES, readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError, throwIfScanAborted } from '../scan-control.js'
import { checkScanAbort, readDirectoryOrEmpty, scanIo } from '../scan-io.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const writable = Schema.mutableKey
const argumentSchema = Schema.Record(Schema.String, Schema.Unknown)
const qwenTextPartSchema = Schema.Struct({
  text: writable(Schema.optional(Schema.NullOr(Schema.String))),
  thought: writable(Schema.optional(Schema.NullOr(Schema.Boolean))),
})
const qwenToolPartSchema = Schema.Struct({
  functionCall: writable(
    Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          name: writable(Schema.optional(Schema.NullOr(Schema.String))),
          args: writable(Schema.optional(Schema.NullOr(argumentSchema))),
        }),
      ),
    ),
  ),
})
const qwenUsageSchema = Schema.Struct({
  promptTokenCount: Schema.Finite,
  candidatesTokenCount: Schema.Finite,
  thoughtsTokenCount: writable(Schema.optional(Schema.NullOr(Schema.Finite))),
  cachedContentTokenCount: writable(Schema.optional(Schema.NullOr(Schema.Finite))),
})
const qwenMessageSchema = Schema.Struct({
  parts: writable(Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown)))),
})
const qwenUserEntrySchema = Schema.Struct({
  type: Schema.Literal('user'),
  message: writable(Schema.optional(Schema.NullOr(Schema.Unknown))),
})
const qwenAssistantEntrySchema = Schema.Struct({
  type: Schema.Literal('assistant'),
  uuid: writable(Schema.optional(Schema.NullOr(Schema.String))),
  sessionId: Schema.String,
  timestamp: writable(Schema.optional(Schema.NullOr(Schema.String))),
  model: writable(Schema.optional(Schema.NullOr(Schema.String))),
  message: writable(Schema.optional(Schema.NullOr(Schema.Unknown))),
  usageMetadata: qwenUsageSchema,
})
const qwenEntrySchema = Schema.Union([qwenUserEntrySchema, qwenAssistantEntrySchema])
type QwenEntry = Schema.Schema.Type<typeof qwenEntrySchema>
const decodeQwenEntryJson = Schema.decodeUnknownResult(Schema.fromJsonString(qwenEntrySchema))
const decodeQwenParts = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))
const decodeQwenMessage = Schema.decodeUnknownResult(qwenMessageSchema)
const decodeQwenToolPart = Schema.decodeUnknownResult(qwenToolPartSchema)
const decodeQwenTextPart = Schema.decodeUnknownResult(qwenTextPartSchema)
const decodeString = Schema.decodeUnknownResult(Schema.String)

const toolNameMap: Record<string, string> = {
  read_file: 'Read',
  write_to_file: 'Write',
  edit_file: 'Edit',
  execute_command: 'Bash',
  search_files: 'Grep',
  list_files: 'LS',
  list_directory: 'LS',
  browser_action: 'WebFetch',
  web_search: 'WebSearch',
  ask_followup_question: 'AskUser',
  attempt_completion: 'Complete',
}

function getQwenProjectsDir(): string {
  return process.env['QWEN_DATA_DIR'] ?? join(homedir(), '.qwen', 'projects')
}

function projectNameFromDirName(dirName: string): string {
  const parts = dirName.replace(/^-/, '').split('-')
  return parts[parts.length - 1] || dirName
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

const isFile = Effect.fnUntraced(function* (path: string, signal?: AbortSignal): Effect.fn.Return<boolean, Error> {
  return yield* scanIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isFile()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
})

function decodeEntry(raw: string): QwenEntry | null {
  if (!raw.trim()) return null
  const decoded = decodeQwenEntryJson(raw)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function decodeParts(rawParts: unknown): readonly unknown[] {
  const parts = decodeQwenParts(rawParts)
  return Result.isSuccess(parts) ? parts.success : []
}

function messageParts(rawMessage: unknown): readonly unknown[] {
  const message = decodeQwenMessage(rawMessage)
  return Result.isSuccess(message) ? decodeParts(message.success.parts) : []
}

function extractTools(parts: readonly unknown[]): { tools: string[]; bashCommands: string[] } {
  const tools: string[] = []
  const bashCommands: string[] = []

  for (const candidate of parts) {
    const decoded = decodeQwenToolPart(candidate)
    if (Result.isFailure(decoded)) continue
    const call = decoded.success.functionCall
    if (!call?.name) continue
    const mapped = toolNameMap[call.name] ?? call.name
    tools.push(mapped)
    const command = call.args?.['command']
    const decodedCommand = decodeString(command)
    if (mapped === 'Bash' && Result.isSuccess(decodedCommand)) {
      bashCommands.push(...extractBashCommands(decodedCommand.success))
    }
  }

  return { tools, bashCommands }
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> => {
    let pendingUserMessage = ''

    const parseLine = (line: string): Result.Result<ParsedProviderCall, undefined> => {
      const entry = decodeEntry(line)
      if (!entry) return Result.fail(undefined)

      if (entry.type === 'user' && entry.message) {
        const texts = messageParts(entry.message).flatMap(candidate => {
          const part = decodeQwenTextPart(candidate)
          return Result.isSuccess(part) && part.success.text && !part.success.thought ? [part.success.text] : []
        })
        if (texts.length > 0) pendingUserMessage = texts.join(' ').slice(0, 500)
        return Result.fail(undefined)
      }

      if (entry.type !== 'assistant') return Result.fail(undefined)

      const usage = entry.usageMetadata
      const inputTokens = usage.promptTokenCount
      const outputTokens = usage.candidatesTokenCount
      if (inputTokens === 0 && outputTokens === 0) return Result.fail(undefined)

      const sessionId = entry.sessionId
      const uuid = entry.uuid
      const dedupKey = `qwen:${sessionId}:${uuid}`
      if (seenKeys.has(dedupKey)) return Result.fail(undefined)

      const model = entry.model || 'qwen-auto'
      const { tools, bashCommands } = extractTools(messageParts(entry.message))
      const reasoningTokens = usage.thoughtsTokenCount ?? 0
      const cachedTokens = usage.cachedContentTokenCount ?? 0
      const costUSD = pricing.calculateCost(
        model,
        inputTokens,
        billableOutputTokens('qwen', outputTokens, reasoningTokens),
        0,
        cachedTokens,
        0,
      )

      seenKeys.add(dedupKey)
      pendingUserMessage = pendingUserMessage.slice(0, 500)
      const call: ParsedProviderCall = {
        provider: 'qwen',
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: cachedTokens,
        cachedInputTokens: cachedTokens,
        reasoningTokens,
        webSearchRequests: 0,
        costUSD,
        tools: [...new Set(tools)],
        bashCommands: [...new Set(bashCommands)],
        timestamp: entry.timestamp ?? '',
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: pendingUserMessage,
        sessionId,
      }
      pendingUserMessage = ''
      return Result.succeed(call)
    }

    return readSessionLinesStream(source.path, undefined, {
      maxBytes: MAX_SESSION_FILE_BYTES,
      ...(signal ? { signal } : {}),
    }).pipe(
      Stream.mapEffect(line =>
        Effect.try({
          try: () => {
            throwIfScanAborted(signal)
            return parseLine(line.toString())
          },
          catch: toError,
        }),
      ),
      Stream.filterMap(option => option),
    )
  }

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // Remove this async-generator edge when all direct parser callers consume parseStream.
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

export function createQwenProvider(overrideDir?: string): Provider {
  const projectsDir = overrideDir ?? getQwenProjectsDir()
  const discoverEffect = Effect.fn('discoverQwenSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkScanAbort(context?.signal)
    const sources: SessionSource[] = []
    const projectDirs = yield* readDirectoryOrEmpty(projectsDir, context?.signal)

    for (const projDir of projectDirs) {
      const chatsDir = join(projectsDir, projDir, 'chats')
      const project = projectNameFromDirName(projDir)
      const chatFiles = yield* readDirectoryOrEmpty(chatsDir, context?.signal)
      for (const file of chatFiles) {
        yield* checkScanAbort(context?.signal)
        if (!file.endsWith('.jsonl')) continue
        const filePath = join(chatsDir, file)
        if (!(yield* isFile(filePath, context?.signal))) continue
        sources.push({ path: filePath, project, provider: 'qwen' })
      }
    }

    return sources
  })

  return {
    name: 'qwen',
    displayName: 'Qwen',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    discoverSessionsEffect: discoverEffect,
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // Remove this Promise edge once direct compatibility callers use the native scan hook.
      // eslint-disable-next-line no-restricted-syntax
      return Effect.runPromise(discoverEffect(context))
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

export const qwen = createQwenProvider()
