import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { Effect, Result, Schema, Stream } from 'effect'

import type { Env } from '../../env.js'
import { extractBashCommands } from '../bash-utils.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { DateRange } from '../types.js'
import type {
  ParsedProviderCall,
  ProbeRoot,
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from './types.js'

type JsonObject = Record<string, unknown>

type SessionState = {
  createdAt?: string
  updatedAt?: string
  workDir?: string
}

type RequestContext = {
  model: string
  modelAlias: string
  turnId: string
  timestamp: string
}

const jsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown)
const sessionStateSchema = Schema.Struct({
  createdAt: Schema.optional(Schema.Unknown),
  updatedAt: Schema.optional(Schema.Unknown),
  workDir: Schema.optional(Schema.Unknown),
})
const wireRecordSchema = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  modelAlias: Schema.optional(Schema.Unknown),
  turnStep: Schema.optional(Schema.Unknown),
  time: Schema.optional(Schema.Unknown),
  input: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Schema.Unknown),
  event: Schema.optional(Schema.Unknown),
})
const toolEventSchema = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  name: Schema.optional(Schema.Unknown),
  args: Schema.optional(Schema.Unknown),
})
const inputPartSchema = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.Unknown),
})
const usageSchema = Schema.Struct({
  inputOther: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  inputCacheRead: Schema.optional(Schema.Unknown),
  inputCacheCreation: Schema.optional(Schema.Unknown),
})
const numericInputSchema = Schema.Union([Schema.Finite, Schema.String])
const stringInputSchema = Schema.String
const arrayInputSchema = Schema.Array(Schema.Unknown)
const decodeJsonObject = Schema.decodeUnknownResult(jsonObjectSchema)
const decodeJsonObjectString = Schema.decodeUnknownResult(Schema.fromJsonString(jsonObjectSchema))
const decodeSessionStateString = Schema.decodeUnknownResult(Schema.fromJsonString(sessionStateSchema))
const decodeWireRecordString = Schema.decodeUnknownResult(Schema.fromJsonString(wireRecordSchema))
const decodeToolEvent = Schema.decodeUnknownResult(toolEventSchema)
const decodeInputPart = Schema.decodeUnknownResult(inputPartSchema)
const decodeUsage = Schema.decodeUnknownResult(usageSchema)
const decodeNumericInput = Schema.decodeUnknownResult(numericInputSchema)
const decodeStringInput = Schema.decodeUnknownResult(stringInputSchema)
const decodeArrayInput = Schema.decodeUnknownResult(arrayInputSchema)
const decodeTimestampInput = Schema.decodeUnknownResult(Schema.Union([Schema.String, Schema.Finite]))

const toolNameMap: Record<string, string> = {
  Bash: 'Bash',
  Shell: 'Bash',
  bash: 'Bash',
  shell: 'Bash',
  Read: 'Read',
  ReadFile: 'Read',
  read_file: 'Read',
  Write: 'Write',
  WriteFile: 'Write',
  write_file: 'Write',
  Edit: 'Edit',
  EditFile: 'Edit',
  edit_file: 'Edit',
  Grep: 'Grep',
  grep: 'Grep',
  Glob: 'Glob',
  glob: 'Glob',
  Agent: 'Agent',
  Task: 'Agent',
}

function asObject(value: unknown): JsonObject | null {
  const decoded = decodeJsonObject(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function stringValue(value: unknown): string {
  const decoded = decodeStringInput(value)
  return Result.isSuccess(decoded) ? decoded.success.trim() : ''
}

function nonNegativeNumber(value: unknown): number {
  const decoded = decodeNumericInput(value)
  if (Result.isFailure(decoded)) return 0

  let number: number
  if (typeof decoded.success === 'number') {
    number = decoded.success
  } else if (decoded.success.trim()) {
    number = Number(decoded.success)
  } else {
    return 0
  }

  if (!Number.isFinite(number) || number < 0) return 0
  return Math.trunc(number)
}

function timestampIso(value: unknown): string {
  const decoded = decodeTimestampInput(value)
  if (Result.isFailure(decoded)) return ''
  if (typeof decoded.success === 'string') {
    const date = new Date(decoded.success)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
  }
  const milliseconds = decoded.success > 1_000_000_000_000 ? decoded.success : decoded.success * 1000
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function kimicodeHomes(override?: string): string[] {
  const explicit = override || process.env['KIMI_CODE_HOME']
  if (explicit) return [resolve(explicit)]
  // Default stores. Beyond the CLI's own ~/.kimi-code, embedded runtimes keep
  // the same wire layout under their own home (Kimi desktop app, Kimi Code
  // IDE); each home is scanned so embedded-agent usage is not invisible.
  const home = homedir()
  const homes = [
    join(home, '.kimi-code'),
    join(
      home,
      'Library',
      'Application Support',
      'kimi-desktop',
      'daimon-share',
      'daimon',
      'runtime',
      'kimi-code',
      'home',
    ),
  ]
  return [...new Set(homes.map(h => resolve(h)))]
}

const directoryEntriesEffect = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<Dirent[], Error> {
  return yield* scanIo(() => readdir(path, { withFileTypes: true }), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([]))),
  )
})

const isFileEffect = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<boolean, Error> {
  return yield* scanIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isFile()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
})

const readStateEffect = Effect.fnUntraced(function* (
  sessionDir: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionState, Error> {
  const raw = yield* scanIo(() => readFile(join(sessionDir, 'state.json'), 'utf8'), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
  if (raw === null) return {}
  const state = decodeSessionStateString(raw)
  if (Result.isFailure(state)) return {}
  return {
    createdAt: stringValue(state.success.createdAt) || undefined,
    updatedAt: stringValue(state.success.updatedAt) || undefined,
    workDir: stringValue(state.success.workDir) || undefined,
  }
})

function projectFromWorkDir(workDir: string, workDirKey: string): string {
  if (workDir) return basename(workDir.replace(/[\\/]+$/, '')) || workDir
  const match = /^wd_(.+)_[a-f0-9]{12}$/i.exec(workDirKey)
  return match?.[1] || workDirKey.replace(/^wd_/, '') || 'kimicode'
}

const discoverSourcesEffect = Effect.fnUntraced(function* (
  root: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const sources: SessionSource[] = []
  const sessionsDir = join(root, 'sessions')

  for (const workDirEntry of yield* directoryEntriesEffect(sessionsDir, signal)) {
    yield* checkScanAbort(signal)
    if (!workDirEntry.isDirectory() || !workDirEntry.name.startsWith('wd_')) continue
    const workDirPath = join(sessionsDir, workDirEntry.name)

    for (const sessionEntry of yield* directoryEntriesEffect(workDirPath, signal)) {
      yield* checkScanAbort(signal)
      if (!sessionEntry.isDirectory()) continue
      const sessionDir = join(workDirPath, sessionEntry.name)
      const state = yield* readStateEffect(sessionDir, signal)
      const project = projectFromWorkDir(state.workDir ?? '', workDirEntry.name)

      for (const agentEntry of yield* directoryEntriesEffect(join(sessionDir, 'agents'), signal)) {
        yield* checkScanAbort(signal)
        if (!agentEntry.isDirectory()) continue
        const wirePath = join(sessionDir, 'agents', agentEntry.name, 'wire.jsonl')
        if (!(yield* isFileEffect(wirePath, signal))) continue
        sources.push({
          path: wirePath,
          project,
          provider: 'kimicode',
          sourceId: agentEntry.name,
          sourceLabel: agentEntry.name,
          sourcePath: state.workDir,
        })
      }
    }
  }

  return sources.sort((a, b) => a.path.localeCompare(b.path))
})

function sessionDirForWire(path: string): string {
  return dirname(dirname(dirname(path)))
}

function sessionIdForWire(path: string): string {
  return basename(sessionDirForWire(path)).replace(/^session_/, '')
}

function agentIdForWire(path: string): string {
  return basename(dirname(path))
}

function turnIdFromStep(value: unknown): string {
  const turnStep = stringValue(value)
  if (!turnStep) return ''
  return turnStep.split('.', 1)[0] ?? ''
}

function inputText(value: unknown): string {
  const text = decodeStringInput(value)
  if (Result.isSuccess(text)) return text.success
  const parts = decodeArrayInput(value)
  if (Result.isFailure(parts)) return ''
  return parts.success
    .map(part => {
      const decoded = decodeInputPart(part)
      if (Result.isFailure(decoded) || stringValue(decoded.success.type) !== 'text') return ''
      return stringValue(decoded.success.text)
    })
    .filter(Boolean)
    .join('\n')
}

function toolDetails(value: unknown): { name: string; bashCommands: string[] } | null {
  const decoded = decodeToolEvent(value)
  if (Result.isFailure(decoded) || stringValue(decoded.success.type) !== 'tool.call') return null
  const event = decoded.success
  const rawName = stringValue(event.name)
  if (!rawName) return null
  const name = toolNameMap[rawName] ?? rawName

  let args = asObject(event.args)
  if (!args) {
    const argsString = decodeStringInput(event.args)
    if (Result.isSuccess(argsString)) {
      const decodedArgs = decodeJsonObjectString(argsString.success)
      args = Result.isSuccess(decodedArgs) ? decodedArgs.success : null
    }
  }
  const command = stringValue(args?.['command'])
  return {
    name,
    bashCommands: name === 'Bash' && command ? extractBashCommands(command) : [],
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseEffect = Effect.fn('parseKimicodeSession')(function* (): Effect.fn.Return<
    Stream.Stream<ParsedProviderCall, Error>,
    Error
  > {
    yield* checkScanAbort(signal)
    // Keep the legacy uncapped, single source read. In particular, do not stat
    // first or route this through the capped shared whole-file reader.
    const contents = yield* scanIo(() => readFile(source.path, 'utf8'), signal).pipe(
      Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
    )
    if (contents === null) return Stream.empty

    const sessionDir = sessionDirForWire(source.path)
    const sessionId = sessionIdForWire(source.path)
    const agentId = source.sourceId || agentIdForWire(source.path)
    // Legacy ordering: the wire read settles before the state sidecar is read.
    const state = yield* readStateEffect(sessionDir, signal)
    const fallbackTimestamp = timestampIso(state.updatedAt) || timestampIso(state.createdAt)
    const projectPath = state.workDir || source.sourcePath
    const aliasModels = new Map<string, string>()
    const prompts = new Map<string, string>()
    let currentPrompt = ''
    let currentRequest: RequestContext | null = null
    let pendingTools: string[] = []
    let pendingBashCommands: string[] = []
    let usageOrdinal = 0
    let lineIndex = 0

    return Stream.fromIterable(contents.split(/\r?\n/)).pipe(
      // The line state machine and pricing run one physical line per pull.
      Stream.rechunk(1),
      Stream.mapEffect(rawLine =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const physicalLineIndex = lineIndex++
          const line = rawLine.trim()
          if (!line) return Result.fail(undefined)

          const decodedRecord = decodeWireRecordString(line)
          if (Result.isFailure(decodedRecord)) return Result.fail(undefined)
          const record = decodedRecord.success
          const type = stringValue(record.type)
          if (type === 'turn.prompt') {
            pendingTools = []
            pendingBashCommands = []
            currentPrompt = inputText(record.input)
            return Result.fail(undefined)
          }

          if (type === 'llm.request') {
            const model = stringValue(record.model)
            const modelAlias = stringValue(record.modelAlias)
            const turnId = turnIdFromStep(record.turnStep)
            if (model && modelAlias) aliasModels.set(modelAlias, model)
            if (turnId && currentPrompt) prompts.set(turnId, currentPrompt)
            currentRequest = {
              model,
              modelAlias,
              turnId,
              timestamp: timestampIso(record.time),
            }
            return Result.fail(undefined)
          }

          if (type === 'context.append_loop_event') {
            const tool = toolDetails(record.event)
            if (tool) {
              pendingTools.push(tool.name)
              pendingBashCommands.push(...tool.bashCommands)
            }
            return Result.fail(undefined)
          }

          if (type !== 'usage.record') return Result.fail(undefined)
          const decodedUsage = decodeUsage(record.usage)
          if (Result.isFailure(decodedUsage)) return Result.fail(undefined)
          const usage = decodedUsage.success

          const usageAlias = stringValue(record.model)
          const realModel = aliasModels.get(usageAlias) ?? (currentRequest?.model || 'kimicode-unknown')
          const turnId = currentRequest?.turnId || ''
          const inputTokens = nonNegativeNumber(usage.inputOther)
          const outputTokens = nonNegativeNumber(usage.output)
          const cacheReadInputTokens = nonNegativeNumber(usage.inputCacheRead)
          const cacheCreationInputTokens = nonNegativeNumber(usage.inputCacheCreation)
          const timestamp = timestampIso(record.time) || currentRequest?.timestamp || fallbackTimestamp
          if (!timestamp) {
            pendingTools = []
            pendingBashCommands = []
            return Result.fail(undefined)
          }

          const deduplicationKey = `kimicode:${sessionId}:${agentId}:${physicalLineIndex + 1}:${usageOrdinal}`
          usageOrdinal++
          if (seenKeys.has(deduplicationKey)) {
            pendingTools = []
            pendingBashCommands = []
            return Result.fail(undefined)
          }
          seenKeys.add(deduplicationKey)

          const costUSD = yield* Effect.try({
            try: () =>
              pricing.calculateCost(
                realModel,
                inputTokens,
                outputTokens,
                cacheCreationInputTokens,
                cacheReadInputTokens,
                0,
              ),
            catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
          })
          const call: ParsedProviderCall = {
            provider: 'kimicode',
            model: realModel,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens,
            cacheReadInputTokens,
            cachedInputTokens: cacheReadInputTokens,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD,
            costIsEstimated: true,
            tools: pendingTools,
            bashCommands: pendingBashCommands,
            timestamp,
            speed: 'standard',
            deduplicationKey,
            turnId: turnId || undefined,
            userMessage: prompts.get(turnId) ?? currentPrompt,
            sessionId,
            project: source.project,
            projectPath,
          }
          pendingTools = []
          pendingBashCommands = []
          return Result.succeed(call)
        }),
      ),
      Stream.filterMap(call => call),
    )
  })

  return {
    parseStream: () => Stream.unwrap(parseEffect()),
    // Remove when scan/parser and external iterator callers consume parseStream.
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(Stream.unwrap(parseEffect()))
    },
  }
}

export function createKimicodeProvider(homeOverride?: string): Provider {
  const discoverEffect = Effect.fn('discoverKimicodeSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkScanAbort(context?.signal)
    const all: SessionSource[] = []
    for (const home of kimicodeHomes(homeOverride)) {
      yield* checkScanAbort(context?.signal)
      all.push(...(yield* discoverSourcesEffect(home, context?.signal)))
    }
    return all.sort((a, b) => a.path.localeCompare(b.path))
  })

  return {
    name: 'kimicode',
    displayName: 'Kimi Code',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return kimicodeHomes(homeOverride).map(path => ({ path, label: 'Kimi Code home' }))
    },

    discoverSessionsEffect(context?: ProviderScanContext): Effect.Effect<SessionSource[], Error, Env> {
      return discoverEffect(context)
    },

    // Remove when all discovery callers use the native Effect entry point.
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
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

export const kimicode = createKimicodeProvider()
