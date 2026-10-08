import { Effect, Result, Schema, Stream } from 'effect'
import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { MAX_SESSION_FILE_BYTES, readSessionFileEffect, readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError, throwIfScanAborted } from '../scan-control.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const writable = Schema.mutableKey
const argumentSchema = Schema.Record(Schema.String, Schema.Unknown)
const contentBlockSchema = Schema.Struct({
  type: writable(Schema.optional(Schema.NullOr(Schema.String))),
  text: writable(Schema.optional(Schema.NullOr(Schema.String))),
  name: writable(Schema.optional(Schema.NullOr(Schema.String))),
  arguments: writable(Schema.optional(Schema.NullOr(argumentSchema))),
})
const usageSchema = Schema.Struct({
  input: writable(Schema.optional(Schema.NullOr(Schema.Finite))),
  output: writable(Schema.optional(Schema.NullOr(Schema.Finite))),
  cacheRead: writable(Schema.optional(Schema.NullOr(Schema.Finite))),
  cacheWrite: writable(Schema.optional(Schema.NullOr(Schema.Finite))),
})
const messageSchema = Schema.Struct({
  role: writable(Schema.optional(Schema.NullOr(Schema.String))),
  content: writable(Schema.optional(Schema.Unknown)),
  model: writable(Schema.optional(Schema.NullOr(Schema.String))),
  responseId: writable(Schema.optional(Schema.NullOr(Schema.String))),
  usage: writable(Schema.optional(Schema.NullOr(usageSchema))),
})
const piEntrySchema = Schema.Struct({
  type: Schema.String,
  id: writable(Schema.optional(Schema.NullOr(Schema.String))),
  timestamp: writable(Schema.optional(Schema.NullOr(Schema.String))),
  cwd: writable(Schema.optional(Schema.NullOr(Schema.String))),
  message: writable(Schema.optional(Schema.NullOr(messageSchema))),
})
type PiEntry = Schema.Schema.Type<typeof piEntrySchema>
type PiContentBlock = Schema.Schema.Type<typeof contentBlockSchema>

function normalizePiContentBlocks(content: unknown): PiContentBlock[] {
  const text = Schema.decodeUnknownResult(Schema.String)(content)
  if (Result.isSuccess(text)) return [{ type: 'text', text: text.success }]
  const blocks = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))(content)
  if (Result.isFailure(blocks)) return []
  return blocks.success.flatMap(block => {
    const decoded = Schema.decodeUnknownResult(contentBlockSchema)(block)
    return Result.isSuccess(decoded) ? [decoded.success] : []
  })
}

const modelDisplayNames: Record<string, string> = {
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5': 'GPT-5',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  dispatch_agent: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  patch: 'Patch',
}

const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

function skillLoadName(
  name: string | null | undefined,
  args: Record<string, unknown> | null | undefined,
): string | null {
  if (name !== 'read') return null
  const raw = args?.['path'] ?? args?.['file_path']
  if (typeof raw !== 'string') return null
  const path = raw.trim()
  if (path.length === 0) return null

  if (path.startsWith('skill://')) {
    const first = path.slice('skill://'.length).replace(/^\/+/, '').split(/[/?#]/)[0]?.trim() ?? ''
    return first || null
  }

  const segments = path.split(/[\\/]/).filter(Boolean)
  const parent = segments[segments.length - 2]?.trim()
  return segments[segments.length - 1] === 'SKILL.md' && parent ? parent : null
}

function getPiSessionsDir(override?: string): string {
  return override ?? join(homedir(), '.pi', 'agent', 'sessions')
}

function getOmpSessionsDir(override?: string): string {
  return override ?? join(homedir(), '.omp', 'agent', 'sessions')
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function checkAbort(signal?: AbortSignal): Effect.Effect<void, Error> {
  return Effect.try({ try: () => throwIfScanAborted(signal), catch: toError })
}

const nativeIo = Effect.fnUntraced(function* <A>(
  operation: () => Promise<A>,
  signal?: AbortSignal,
): Effect.fn.Return<A, Error> {
  yield* checkAbort(signal)
  const result = yield* Effect.uninterruptible(Effect.result(Effect.tryPromise({ try: operation, catch: toError })))
  yield* checkAbort(signal)
  if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
  return result.success
})

function readdirOrEmpty(path: string, signal?: AbortSignal): Effect.Effect<string[], Error> {
  return nativeIo(() => readdir(path), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([]))),
  )
}

function isDirectory(path: string, signal?: AbortSignal): Effect.Effect<boolean, Error> {
  return nativeIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isDirectory()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
}

function isFile(path: string, signal?: AbortSignal): Effect.Effect<boolean, Error> {
  return nativeIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isFile()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
}

function decodeLine(raw: string): PiEntry | null {
  if (!raw.trim()) return null
  const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(piEntrySchema))(raw)
  return Result.isSuccess(decoded) ? decoded.success : null
}

const readFirstEntry = Effect.fn('readPiSessionHeader')(function* (
  filePath: string,
  signal?: AbortSignal,
): Effect.fn.Return<PiEntry | null, Error> {
  const contents = yield* readSessionFileEffect(filePath, 'utf-8', signal ? { signal } : {})
  yield* checkAbort(signal)
  const line = contents?.split('\n')[0]
  return line === undefined ? null : decodeLine(line)
})

const discoverSessionsInDir = Effect.fn('discoverPiSessionsInDir')(function* (
  sessionsDir: string,
  providerName: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const sources: SessionSource[] = []
  const projectDirs = yield* readdirOrEmpty(sessionsDir, signal)

  for (const dirName of projectDirs) {
    const dirPath = join(sessionsDir, dirName)
    if (!(yield* isDirectory(dirPath, signal))) continue

    const files = yield* readdirOrEmpty(dirPath, signal)
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(dirPath, file)
      if (!(yield* isFile(filePath, signal))) continue

      const first = yield* readFirstEntry(filePath, signal).pipe(
        Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
      )
      if (first?.type !== 'session') continue

      const cwd = first.cwd?.trim() ? first.cwd : undefined
      sources.push({
        path: filePath,
        project: basename(cwd ?? dirName),
        provider: providerName,
        ...(cwd ? { workingDirectory: cwd } : {}),
      })
    }
  }

  return sources
})

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> => {
    let lineIndex = 0
    let sessionId = basename(source.path, '.jsonl')
    let sessionCwd = source.workingDirectory
    let pendingUserMessage = ''

    const parseLine = (line: string): Result.Result<ParsedProviderCall, undefined> => {
      if (!line.trim()) return Result.fail(undefined)
      const lineIdx = lineIndex++
      const entry = decodeLine(line)
      if (!entry) return Result.fail(undefined)

      if (entry.type === 'session') {
        sessionId = entry.id ?? sessionId
        if (entry.cwd?.trim()) sessionCwd = entry.cwd
        return Result.fail(undefined)
      }

      if (entry.type !== 'message') return Result.fail(undefined)
      const msg = entry.message
      if (!msg) return Result.fail(undefined)

      if (msg.role === 'user') {
        const texts = normalizePiContentBlocks(msg.content)
          .filter(block => block.type === 'text')
          .map(block => block.text ?? '')
          .filter(Boolean)
        if (texts.length > 0) pendingUserMessage = texts.join(' ')
        return Result.fail(undefined)
      }

      if (msg.role !== 'assistant' || !msg.usage) return Result.fail(undefined)

      const input = msg.usage.input ?? 0
      const output = msg.usage.output ?? 0
      const cacheRead = msg.usage.cacheRead ?? 0
      const cacheWrite = msg.usage.cacheWrite ?? 0
      if (input === 0 && output === 0) return Result.fail(undefined)

      const model = msg.model ?? 'gpt-5'
      const responseId = msg.responseId ?? ''
      const dedupKey = `${source.provider}:${source.path}:${responseId || entry.id || entry.timestamp || String(lineIdx)}`
      if (seenKeys.has(dedupKey)) return Result.fail(undefined)
      seenKeys.add(dedupKey)

      const toolCalls = normalizePiContentBlocks(msg.content).filter(block => block.type === 'toolCall' && block.name)
      const tools: string[] = []
      const skills: string[] = []
      for (const call of toolCalls) {
        const skill = skillLoadName(call.name, call.arguments)
        if (skill !== null) {
          skills.push(skill)
          tools.push('Skill')
        } else if (call.name) {
          tools.push(toolNameMap[call.name] ?? call.name)
        }
      }

      const bashCommands = toolCalls
        .filter(call => call.name === 'bash')
        .flatMap(call => {
          const command = call.arguments?.['command']
          return typeof command === 'string' ? extractBashCommands(command) : []
        })
      const timestamp = entry.timestamp ?? ''
      const call: ParsedProviderCall = {
        provider: source.provider,
        model,
        inputTokens: input,
        outputTokens: output,
        cacheCreationInputTokens: cacheWrite,
        cacheReadInputTokens: cacheRead,
        cachedInputTokens: cacheRead,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: pricing.calculateCost(model, input, output, cacheWrite, cacheRead, 0),
        tools,
        bashCommands,
        skills,
        timestamp,
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: pendingUserMessage,
        sessionId,
        ...(sessionCwd ? { projectPath: sessionCwd, workingDirectory: sessionCwd } : {}),
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
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

function makeProvider(
  sessionsDir: string | undefined,
  providerName: 'pi' | 'omp',
  displayName: 'Pi' | 'OMP',
): Provider {
  const sessionsDirPath = providerName === 'pi' ? getPiSessionsDir(sessionsDir) : getOmpSessionsDir(sessionsDir)
  const discoverEffect = Effect.fn(`discover${displayName}Sessions`)(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkAbort(context?.signal)
    return yield* discoverSessionsInDir(sessionsDirPath, providerName, context?.signal)
  })

  return {
    name: providerName,
    displayName,
    modelDisplayName(model: string): string {
      for (const [key, name] of modelDisplayEntries) {
        if (model.startsWith(key)) return name
      }
      return model
    },
    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },
    discoverSessionsEffect: discoverEffect,
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // Compatibility boundary for callers that still use Provider.discoverSessions().
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

export function createPiProvider(sessionsDir?: string): Provider {
  return makeProvider(sessionsDir, 'pi', 'Pi')
}

export const pi = createPiProvider()

export function createOmpProvider(sessionsDir?: string): Provider {
  return makeProvider(sessionsDir, 'omp', 'OMP')
}

export const omp = createOmpProvider()
