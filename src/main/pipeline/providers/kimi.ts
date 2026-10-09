import { createHash } from 'crypto'
import { Effect, Result, Schema, Stream } from 'effect'
import type { Dirent } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing, getShortModelName } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const nullableString = Schema.NullOr(Schema.String)
const nullableToken = Schema.NullOr(Schema.Union([Schema.Finite, Schema.String]))
const jsonObject = Schema.Record(Schema.String, Schema.Unknown)
const unknownArray = Schema.Array(Schema.Unknown)
const decodeJsonObject = Schema.decodeUnknownResult(jsonObject)
const decodeNullableString = Schema.decodeUnknownResult(nullableString)
const decodeToken = Schema.decodeUnknownResult(nullableToken)
const decodeUnknownArray = Schema.decodeUnknownResult(unknownArray)

const kimiConfigSchema = Schema.Struct({ work_dirs: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))) })
const wireEnvelopeSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
})
const recordSchema = Schema.Struct({
  message: Schema.optional(Schema.NullOr(Schema.Unknown)),
  timestamp: Schema.optional(Schema.Unknown),
})
const userTextPartSchema = Schema.Struct({ text: Schema.optional(nullableString) })
const timestampSchema = Schema.Union([Schema.String, Schema.Finite])
const decodeConfigJson = Schema.decodeUnknownResult(Schema.fromJsonString(kimiConfigSchema))
const decodeRecord = Schema.decodeUnknownResult(recordSchema)
const decodeEnvelope = Schema.decodeUnknownResult(wireEnvelopeSchema)
const decodeUserTextPart = Schema.decodeUnknownResult(userTextPartSchema)
const decodeTimestamp = Schema.decodeUnknownResult(timestampSchema)

const toolNameMap: Record<string, string> = {
  Shell: 'Bash',
  Bash: 'Bash',
  bash: 'Bash',
  ReadFile: 'Read',
  ReadMediaFile: 'Read',
  WriteFile: 'Write',
  StrReplaceFile: 'Edit',
  Grep: 'Grep',
  Glob: 'Glob',
  SearchWeb: 'WebSearch',
  FetchURL: 'WebFetch',
  Agent: 'Agent',
  AgentTool: 'Agent',
  TaskList: 'Agent',
  TaskOutput: 'Agent',
  TaskStop: 'Agent',
  AskUserQuestion: 'AskUser',
  SetTodoList: 'TodoWrite',
  Think: 'Think',
  EnterPlanMode: 'EnterPlanMode',
  ExitPlanMode: 'ExitPlanMode',
  SendDMail: 'DMail',
}

function getShareDir(overrideDir?: string): string {
  return overrideDir ?? process.env['KIMI_SHARE_DIR'] ?? join(homedir(), '.kimi')
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf-8').digest('hex')
}

function projectNameFromPath(pathValue: string): string {
  const cleaned = pathValue.replace(/\/+$/, '')
  return basename(cleaned) || cleaned || 'kimi'
}

const loadProjectNames = Effect.fnUntraced(function* (
  shareDir: string,
  signal?: AbortSignal,
): Effect.fn.Return<Map<string, string>, Error> {
  const raw = yield* scanIo(() => readFile(join(shareDir, 'kimi.json'), 'utf-8'), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
  const projects = new Map<string, string>()
  if (raw === null) return projects

  const config = decodeConfigJson(raw)
  if (Result.isFailure(config) || !config.success.work_dirs) return projects

  for (const candidate of config.success.work_dirs) {
    const decoded = decodeJsonObject(candidate)
    if (Result.isFailure(decoded)) continue
    const decodedPath = decodeNullableString(decoded.success['path'])
    if (Result.isFailure(decodedPath)) continue
    const pathValue = decodedPath.success
    if (!pathValue) continue
    const hash = md5(pathValue)
    const project = projectNameFromPath(pathValue)
    projects.set(hash, project)

    const decodedKaos = decodeNullableString(decoded.success['kaos'])
    const kaos = Result.isSuccess(decodedKaos) ? decodedKaos.success : undefined
    if (kaos && kaos !== 'local') projects.set(`${kaos}_${hash}`, project)
  }

  return projects
})

function parseTomlString(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:[^"\\]|\\.)*)"/)
    if (!match) return null
    try {
      return JSON.parse(`"${match[1]}"`) as string
    } catch {
      return match[1] ?? null
    }
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'([^']*)'/)
    return match?.[1] ?? null
  }
  const match = value.match(/^([^#\s]+)/)
  return match?.[1] ?? null
}

function parseDefaultModelKey(configToml: string): string | null {
  for (const line of configToml.split('\n')) {
    const match = line.match(/^\s*default_model\s*=\s*(.+)$/)
    if (!match) continue
    return parseTomlString(match[1]!)
  }
  return null
}

function parseModelSectionName(line: string): string | null {
  const match = line.trim().match(/^\[models\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]$/)
  if (!match) return null
  return (match[1] ?? match[2] ?? match[3] ?? '').trim() || null
}

function parseModelIdForKey(configToml: string, modelKey: string): string | null {
  let inSection = false
  for (const line of configToml.split('\n')) {
    const section = parseModelSectionName(line)
    if (section !== null) {
      inSection = section === modelKey
      continue
    }
    if (!inSection) continue
    if (/^\s*\[/.test(line)) {
      inSection = false
      continue
    }
    const match = line.match(/^\s*model\s*=\s*(.+)$/)
    if (!match) continue
    return parseTomlString(match[1]!)
  }
  return null
}

const getConfiguredModel = Effect.fnUntraced(function* (
  shareDir: string,
  signal?: AbortSignal,
): Effect.fn.Return<string, Error> {
  const envModel = process.env['KIMI_MODEL_NAME']?.trim()
  if (envModel) return envModel

  const raw = yield* scanIo(() => readFile(join(shareDir, 'config.toml'), 'utf-8'), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
  if (!raw) return 'kimi-auto'
  const defaultModel = parseDefaultModelKey(raw)
  if (!defaultModel) return 'kimi-auto'
  return parseModelIdForKey(raw, defaultModel) ?? defaultModel
})

function positiveToken(fields: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const decoded = decodeToken(fields[key])
    if (Result.isFailure(decoded) || decoded.success === null) continue
    const value = typeof decoded.success === 'number' ? decoded.success : Number(decoded.success)
    if (Number.isFinite(value) && value > 0) return Math.trunc(value)
  }
  return 0
}

type Usage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheCreationInputTokens: number
}

function extractUsage(payload: Record<string, unknown>): Usage | null {
  const usageValue = decodeJsonObject(payload['token_usage'])
  const fallbackValue = decodeJsonObject(payload['usage'])
  const rawUsage = Result.isSuccess(usageValue)
    ? usageValue.success
    : Result.isSuccess(fallbackValue)
      ? fallbackValue.success
      : null
  if (rawUsage === null) return null
  const fields = rawUsage

  const cacheReadInputTokens = positiveToken(
    fields,
    'input_cache_read',
    'cache_read_input_tokens',
    'cached_input_tokens',
  )
  const cacheCreationInputTokens = positiveToken(fields, 'input_cache_creation', 'cache_creation_input_tokens')
  let inputTokens = positiveToken(fields, 'input_other', 'input_tokens')
  if (inputTokens === 0) {
    const totalInput = positiveToken(fields, 'input')
    inputTokens = Math.max(0, totalInput - cacheReadInputTokens - cacheCreationInputTokens)
  }
  const outputTokens = positiveToken(fields, 'output', 'output_tokens')
  if (inputTokens === 0 && outputTokens === 0 && cacheReadInputTokens === 0 && cacheCreationInputTokens === 0)
    return null
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }
}

function extractUserText(value: unknown): string {
  const directText = decodeNullableString(value)
  if (Result.isSuccess(directText)) return (directText.success ?? '').slice(0, 500)
  const parts = decodeUnknownArray(value)
  if (Result.isFailure(parts)) return ''
  return parts.success
    .flatMap(part => {
      const decoded = decodeUserTextPart(part)
      return Result.isSuccess(decoded) && decoded.success.text ? [decoded.success.text] : []
    })
    .join(' ')
    .slice(0, 500)
}

function timestampToIso(value: unknown): string {
  const decoded = decodeTimestamp(value)
  if (Result.isFailure(decoded)) return ''
  if (typeof decoded.success === 'string') return decoded.success
  const millis = decoded.success > 1_000_000_000_000 ? decoded.success : decoded.success * 1000
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

type WireEnvelope = { type: string; payload: Record<string, unknown>; timestamp: string }

function extractEnvelope(recordValue: unknown): WireEnvelope | null {
  const decodedRecord = decodeRecord(recordValue)
  if (Result.isFailure(decodedRecord)) return null
  const nested = decodeJsonObject(decodedRecord.success.message)
  const envelope = decodeEnvelope(Result.isSuccess(nested) ? nested.success : recordValue)
  if (Result.isFailure(envelope) || !envelope.success.type) return null
  const payload = decodeJsonObject(envelope.success.payload)
  if (Result.isFailure(payload)) return null
  return {
    type: envelope.success.type,
    payload: payload.success,
    timestamp: timestampToIso(decodedRecord.success.timestamp),
  }
}

function extractTool(payload: Record<string, unknown>): { tool: string; bashCommands: string[] } | null {
  const fnFields = decodeJsonObject(payload['function'])
  const fnName = Result.isSuccess(fnFields) ? decodeNullableString(fnFields.success['name']) : undefined
  const payloadName = decodeNullableString(payload['name'])
  const rawName =
    (fnName && Result.isSuccess(fnName) ? fnName.success : undefined) ??
    (Result.isSuccess(payloadName) ? payloadName.success : undefined)
  if (!rawName) return null

  const tool = toolNameMap[rawName] ?? rawName
  const fnArguments = Result.isSuccess(fnFields) ? decodeNullableString(fnFields.success['arguments']) : undefined
  const payloadArguments = decodeNullableString(payload['arguments'])
  const argsText =
    (fnArguments && Result.isSuccess(fnArguments) ? fnArguments.success : undefined) ??
    (Result.isSuccess(payloadArguments) ? payloadArguments.success : undefined)
  let bashCommands: string[] = []
  if (argsText) {
    const parsed: unknown = parseJsonOrNull(argsText)
    const args = decodeJsonObject(parsed)
    const rawCommand = Result.isSuccess(args) ? decodeNullableString(args.success['command']) : undefined
    const command = rawCommand && Result.isSuccess(rawCommand) ? rawCommand.success : undefined
    if (tool === 'Bash' && command) bashCommands = extractBashCommands(command)
  }
  return { tool, bashCommands }
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function parseLine(line: string):
  | { kind: 'skip' }
  | { kind: 'user'; text: string }
  | { kind: 'end' }
  | { kind: 'tool'; value: { tool: string; bashCommands: string[] } | null }
  | {
      kind: 'call'
      value: Omit<
        ParsedProviderCall,
        'costUSD' | 'model' | 'deduplicationKey' | 'sessionId' | 'tools' | 'bashCommands' | 'userMessage'
      >
      model: string | undefined
      messageId: string | undefined
    } {
  if (!line.trim()) return { kind: 'skip' }
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return { kind: 'skip' }
  }
  const envelope = extractEnvelope(parsed)
  if (!envelope || envelope.type === 'metadata') return { kind: 'skip' }
  if (envelope.type === 'TurnBegin' || envelope.type === 'SteerInput') {
    return { kind: 'user', text: extractUserText(envelope.payload['user_input']) }
  }
  if (envelope.type === 'TurnEnd') return { kind: 'end' }
  if (envelope.type === 'ToolCall' || envelope.type === 'ToolCallRequest') {
    return { kind: 'tool', value: extractTool(envelope.payload) }
  }
  if (envelope.type !== 'StatusUpdate') return { kind: 'skip' }

  const usage = extractUsage(envelope.payload)
  if (!usage) return { kind: 'skip' }
  const fields = envelope.payload
  const messageId = decodeNullableString(fields['message_id'])
  const decodedModel = decodeNullableString(fields['model'])
  const decodedModelName = decodeNullableString(fields['model_name'])
  const rawMessageId = Result.isSuccess(messageId) ? (messageId.success ?? undefined) : undefined
  const model =
    Result.isSuccess(decodedModel) && decodedModel.success !== null
      ? decodedModel.success
      : Result.isSuccess(decodedModelName) && decodedModelName.success !== null
        ? decodedModelName.success
        : undefined
  return {
    kind: 'call',
    model,
    messageId: rawMessageId,
    value: {
      provider: 'kimi',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cachedInputTokens: usage.cacheReadInputTokens,
      reasoningTokens: 0,
      webSearchRequests: 0,
      timestamp: envelope.timestamp,
      speed: 'standard',
    },
  }
}

function createParser(
  source: SessionSource,
  shareDir: string,
  seenKeys: Set<string>,
  context?: ProviderScanContext,
): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const sessionId = basename(dirname(source.path))

  const parseEffect = Effect.fn('parseKimiSession')(function* (): Effect.fn.Return<
    Stream.Stream<ParsedProviderCall, Error>,
    Error
  > {
    yield* checkScanAbort(signal)
    const configuredModel = yield* getConfiguredModel(shareDir, signal)
    let currentUserMessage = ''
    let index = 0
    const tools = new Set<string>()
    const bashCommands = new Set<string>()

    return readSessionLinesStream(source.path, undefined, {
      ...(signal ? { signal } : {}),
    }).pipe(
      Stream.mapEffect(line =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const item = parseLine(line.toString())
          if (item.kind === 'skip') return Result.fail(undefined)
          if (item.kind === 'user') {
            currentUserMessage = item.text
            return Result.fail(undefined)
          }
          if (item.kind === 'end') {
            currentUserMessage = ''
            tools.clear()
            bashCommands.clear()
            return Result.fail(undefined)
          }
          if (item.kind === 'tool') {
            if (item.value) {
              tools.add(item.value.tool)
              for (const command of item.value.bashCommands) bashCommands.add(command)
            }
            return Result.fail(undefined)
          }

          const deduplicationKey = `kimi:${sessionId}:${item.messageId ?? index}`
          index++
          if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)
          seenKeys.add(deduplicationKey)
          const model = item.model ?? configuredModel
          const costUSD = yield* Effect.try({
            try: () =>
              pricing.calculateCost(
                model,
                item.value.inputTokens,
                item.value.outputTokens,
                item.value.cacheCreationInputTokens,
                item.value.cacheReadInputTokens,
                0,
              ),
            catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
          })
          const call: ParsedProviderCall = {
            ...item.value,
            model,
            deduplicationKey,
            sessionId,
            tools: [...tools],
            bashCommands: [...bashCommands],
            userMessage: currentUserMessage,
            costUSD,
          }
          tools.clear()
          bashCommands.clear()
          return Result.succeed(call)
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

const isFile = Effect.fnUntraced(function* (path: string, signal?: AbortSignal): Effect.fn.Return<boolean, Error> {
  return yield* scanIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isFile()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
})

const addWireSource = Effect.fnUntraced(function* (
  sources: SessionSource[],
  filePath: string,
  project: string,
  signal?: AbortSignal,
): Effect.fn.Return<void, Error> {
  if (!(yield* isFile(filePath, signal))) return
  sources.push({ path: filePath, project, provider: 'kimi' })
})

const readDirectories = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<Dirent[], Error> {
  return yield* scanIo(() => readdir(path, { withFileTypes: true }), signal).pipe(
    Effect.map(entries => entries.filter(entry => entry.isDirectory())),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([]))),
  )
})

export function createKimiProvider(overrideDir?: string): Provider {
  const shareDir = getShareDir(overrideDir)
  const sessionsDir = join(shareDir, 'sessions')
  const discoverEffect = Effect.fn('discoverKimiSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    const signal = context?.signal
    yield* checkScanAbort(signal)
    const sources: SessionSource[] = []
    const projectNames = yield* loadProjectNames(shareDir, signal)
    const workDirs = yield* readDirectories(sessionsDir, signal)

    for (const workDir of workDirs) {
      yield* checkScanAbort(signal)
      const project = projectNames.get(workDir.name) ?? workDir.name
      const workDirPath = join(sessionsDir, workDir.name)
      const sessionDirs = yield* readDirectories(workDirPath, signal)

      for (const sessionDir of sessionDirs) {
        yield* checkScanAbort(signal)
        const sessionPath = join(workDirPath, sessionDir.name)
        const wirePath = join(sessionPath, 'wire.jsonl')
        yield* addWireSource(sources, wirePath, project, signal)

        const subagentsPath = join(sessionPath, 'subagents')
        const subagents = yield* readDirectories(subagentsPath, signal)
        for (const subagent of subagents) {
          yield* checkScanAbort(signal)
          yield* addWireSource(sources, join(subagentsPath, subagent.name, 'wire.jsonl'), project, signal)
        }
      }
    }
    return sources
  })

  return {
    name: 'kimi',
    displayName: 'Kimi',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    discoverSessionsEffect: discoverEffect,
    // Remove when every discovery caller uses the native Effect entry point.
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // eslint-disable-next-line no-restricted-syntax
      return Effect.runPromise(discoverEffect(context))
    },
    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ) {
      return createParser(source, shareDir, seenKeys, context)
    },
  }
}

export const kimi = createKimiProvider()
