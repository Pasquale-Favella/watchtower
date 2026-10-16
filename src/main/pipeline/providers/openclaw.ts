import { Effect, Result, Schema, Stream } from 'effect'
import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { MAX_SESSION_FILE_BYTES, readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const writable = Schema.mutableKey
const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
const indexSchema = Schema.Record(Schema.String, Schema.Unknown)
const optionalString = writable(Schema.optional(Schema.NullOr(Schema.String)))
const envelopeSchema = Schema.Struct({
  type: Schema.String,
  id: writable(Schema.optional(Schema.Unknown)),
  timestamp: writable(Schema.optional(Schema.Unknown)),
  modelId: writable(Schema.optional(Schema.Unknown)),
  customType: writable(Schema.optional(Schema.Unknown)),
  data: writable(Schema.optional(Schema.Unknown)),
  message: writable(Schema.optional(Schema.Unknown)),
})
const sessionEntrySchema = Schema.Struct({
  id: writable(Schema.optional(Schema.Unknown)),
  timestamp: writable(Schema.optional(Schema.Unknown)),
})
const modelChangeSchema = Schema.Struct({ modelId: writable(Schema.optional(Schema.Unknown)) })
const modelSnapshotDataSchema = Schema.Struct({ modelId: optionalString })
const messageSchema = Schema.Struct({
  role: writable(Schema.optional(Schema.Unknown)),
  model: writable(Schema.optional(Schema.Unknown)),
  content: writable(Schema.optional(Schema.Unknown)),
  usage: writable(Schema.optional(Schema.Unknown)),
})
const usageSchema = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  cost: writable(Schema.optional(Schema.NullOr(Schema.Unknown))),
})
const costSchema = Schema.Struct({ total: writable(Schema.optional(Schema.NullOr(Schema.Finite))) })
const textBlockSchema = Schema.Struct({
  type: Schema.Literal('text'),
  text: writable(Schema.optional(Schema.NullOr(Schema.String))),
})
const toolBlockSchema = Schema.Struct({
  type: Schema.Union([Schema.Literal('tool_use'), Schema.Literal('toolCall')]),
  name: optionalString,
  arguments: writable(Schema.optional(Schema.Unknown)),
})
const contentCandidateSchema = Schema.Struct({ type: writable(Schema.optional(Schema.Unknown)) })
const decodeJsonLine = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeEnvelope = Schema.decodeUnknownResult(envelopeSchema)
const decodeSessionEntry = Schema.decodeUnknownResult(sessionEntrySchema)
const decodeModelChange = Schema.decodeUnknownResult(modelChangeSchema)
const decodeModelSnapshotData = Schema.decodeUnknownResult(modelSnapshotDataSchema)
const decodeMessage = Schema.decodeUnknownResult(messageSchema)
const decodeUsage = Schema.decodeUnknownResult(usageSchema)
const decodeCost = Schema.decodeUnknownResult(costSchema)
const decodeContent = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))
const decodeTextBlock = Schema.decodeUnknownResult(textBlockSchema)
const decodeToolBlock = Schema.decodeUnknownResult(toolBlockSchema)
const decodeContentCandidate = Schema.decodeUnknownResult(contentCandidateSchema)
const decodeString = Schema.decodeUnknownResult(Schema.String)
const decodeIndex = Schema.decodeUnknownResult(Schema.fromJsonString(indexSchema))
const decodeRecord = Schema.decodeUnknownResult(recordSchema)

type OpenClawUsage = Schema.Schema.Type<typeof usageSchema>
type OpenClawCall = {
  readonly callIndex: number
  readonly model: string
  readonly usage: OpenClawUsage
  readonly tools: string[]
  readonly bashCommands: string[]
  readonly timestamp: string
  readonly userMessage: string
  readonly dedupId: string
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  exec: 'Bash',
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

function getOpenClawDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.openclaw', 'agents'),
    join(home, '.clawdbot', 'agents'),
    join(home, '.moltbot', 'agents'),
    join(home, '.moldbot', 'agents'),
  ]
}

function decodeStringField(value: unknown): string | undefined {
  const decoded = decodeString(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function extractTools(content: unknown): { tools: string[]; bashCommands: string[] } {
  const tools: string[] = []
  const bashCommands: string[] = []
  const decodedContent = decodeContent(content)
  if (Result.isFailure(decodedContent)) return { tools, bashCommands }

  for (const candidate of decodedContent.success) {
    const decodedCandidate = decodeContentCandidate(candidate)
    if (Result.isFailure(decodedCandidate)) continue
    const type = decodeStringField(decodedCandidate.success.type)
    if (type !== 'tool_use' && type !== 'toolCall') continue
    const decodedBlock = decodeToolBlock(candidate)
    if (Result.isFailure(decodedBlock)) continue
    const block = decodedBlock.success
    if (!block.name) continue
    const mapped = toolNameMap[block.name] ?? block.name
    tools.push(mapped)
    const args = block.arguments === null || block.arguments === undefined ? null : decodeRecord(block.arguments)
    const command = args && Result.isSuccess(args) ? decodeStringField(args.success['command']) : undefined
    if (mapped === 'Bash' && command !== undefined) bashCommands.push(...extractBashCommands(command))
  }
  return { tools, bashCommands }
}

function decodeLine(line: string): Schema.Schema.Type<typeof envelopeSchema> | null {
  if (!line.trim()) return null
  const json = decodeJsonLine(line)
  if (Result.isFailure(json)) return null
  const decoded = decodeEnvelope(json.success)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal

  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.unwrap(
      Effect.gen(function* () {
        let sessionId = ''
        let sessionTimestamp = ''
        let currentModel = ''
        let pendingUserMessage = ''
        let candidateCallIndex = 0
        const calls: OpenClawCall[] = []

        yield* readSessionLinesStream(source.path, undefined, {
          maxBytes: MAX_SESSION_FILE_BYTES,
          ...(signal ? { signal } : {}),
        }).pipe(
          Stream.mapEffect(line =>
            Effect.try({
              try: () => {
                const entry = decodeLine(line.toString())
                if (!entry) return

                if (entry.type === 'session') {
                  const session = decodeSessionEntry(entry)
                  if (Result.isSuccess(session)) {
                    sessionId = decodeStringField(session.success.id) ?? basename(source.path, '.jsonl')
                    sessionTimestamp = decodeStringField(session.success.timestamp) ?? ''
                  }
                  return
                }

                if (entry.type === 'model_change') {
                  const modelChange = decodeModelChange(entry)
                  if (Result.isSuccess(modelChange)) {
                    currentModel = decodeStringField(modelChange.success.modelId) ?? currentModel
                  }
                  return
                }

                if (entry.type === 'custom' && decodeStringField(entry.customType) === 'model-snapshot') {
                  const data =
                    entry.data === null || entry.data === undefined ? null : decodeModelSnapshotData(entry.data)
                  if (data && Result.isSuccess(data)) currentModel = data.success.modelId ?? currentModel
                  return
                }

                if (entry.type !== 'message' || entry.message === null || entry.message === undefined) return
                const message = decodeMessage(entry.message)
                if (Result.isFailure(message)) return
                const msg = message.success
                const role = decodeStringField(msg.role)

                if (role === 'user') {
                  const content = decodeContent(msg.content)
                  if (!pendingUserMessage && Result.isSuccess(content)) {
                    for (const candidate of content.success) {
                      const block = decodeTextBlock(candidate)
                      if (Result.isSuccess(block) && block.success.text) {
                        pendingUserMessage = block.success.text.slice(0, 500)
                        break
                      }
                    }
                  }
                  return
                }

                if (role !== 'assistant' || !msg.usage) return
                const callIndex = candidateCallIndex++
                const userMessage = pendingUserMessage
                pendingUserMessage = ''
                const usage = decodeUsage(msg.usage)
                if (Result.isFailure(usage)) return
                const { tools, bashCommands } = extractTools(msg.content)
                calls.push({
                  callIndex,
                  model: decodeStringField(msg.model) ?? currentModel,
                  usage: usage.success,
                  tools,
                  bashCommands,
                  timestamp: decodeStringField(entry.timestamp) ?? sessionTimestamp,
                  userMessage,
                  dedupId: decodeStringField(entry.id) ?? '',
                })
              },
              catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
            }).pipe(Effect.asVoid),
          ),
          Stream.runDrain,
        )

        if (!sessionId) sessionId = basename(source.path, '.jsonl')

        return Stream.fromIterable(calls).pipe(
          Stream.rechunk(1),
          Stream.mapEffect(call =>
            checkScanAbort(signal).pipe(
              Effect.map(() => {
                const dedupKey = `openclaw:${sessionId}:${call.dedupId || call.callIndex}`
                if (seenKeys.has(dedupKey)) return Result.fail(undefined)
                seenKeys.add(dedupKey)

                const usage = call.usage
                const providerCost =
                  usage.cost === null || usage.cost === undefined ? undefined : decodeCost(usage.cost)
                const recordedCost =
                  providerCost && Result.isSuccess(providerCost) ? providerCost.success.total : undefined
                const costUSD =
                  recordedCost != null && recordedCost > 0
                    ? recordedCost
                    : pricing.calculateCost(call.model, usage.input, usage.output, usage.cacheWrite, usage.cacheRead, 0)
                const timestamp = new Date(call.timestamp)
                if (Number.isNaN(timestamp.getTime()) || timestamp.getTime() < 1_000_000_000_000) {
                  return Result.fail(undefined)
                }

                return Result.succeed({
                  provider: 'openclaw' as const,
                  model: call.model || 'openclaw-auto',
                  inputTokens: usage.input,
                  outputTokens: usage.output,
                  cacheCreationInputTokens: usage.cacheWrite,
                  cacheReadInputTokens: usage.cacheRead,
                  cachedInputTokens: usage.cacheRead,
                  reasoningTokens: 0,
                  webSearchRequests: 0,
                  costUSD,
                  tools: [...new Set(call.tools)],
                  bashCommands: [...new Set(call.bashCommands)],
                  timestamp: timestamp.toISOString(),
                  speed: 'standard' as const,
                  deduplicationKey: dedupKey,
                  userMessage: call.userMessage,
                  sessionId,
                })
              }),
            ),
          ),
          Stream.filterMap(result => result),
        )
      }),
    )

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // Remove this Promise edge once direct compatibility callers consume parseStream.
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

const discoverInDir = Effect.fn('discoverOpenClawSessionsInDir')(function* (
  agentsDir: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const sources: SessionSource[] = []
  const entries = yield* scanIo(() => readdir(agentsDir, { withFileTypes: true }), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([]))),
  )

  for (const entry of entries) {
    yield* checkScanAbort(signal)
    if (!entry.isDirectory()) continue
    const sessionsDir = join(agentsDir, entry.name, 'sessions')
    let indexData: Record<string, unknown> = {}
    const indexRaw = yield* scanIo(() => readFile(join(sessionsDir, 'sessions.json'), 'utf-8'), signal).pipe(
      Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
    )
    if (indexRaw !== null) {
      const decodedIndex = decodeIndex(indexRaw)
      if (Result.isSuccess(decodedIndex)) indexData = decodedIndex.success
    }

    const seenFiles = new Set<string>()
    for (const value of Object.values(indexData)) {
      const decodedEntry = decodeRecord(value)
      if (Result.isFailure(decodedEntry)) continue
      const indexEntry = decodedEntry.success
      const sessionFile = decodeStringField(indexEntry['sessionFile'])
      const sessionId = decodeStringField(indexEntry['sessionId'])
      if (sessionFile) {
        seenFiles.add(sessionFile)
        sources.push({ path: sessionFile, project: entry.name, provider: 'openclaw' })
      } else if (sessionId) {
        const filePath = join(sessionsDir, `${sessionId}.jsonl`)
        seenFiles.add(filePath)
        sources.push({ path: filePath, project: entry.name, provider: 'openclaw' })
      }
    }

    const files = yield* scanIo(() => readdir(sessionsDir), signal).pipe(
      Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([]))),
    )
    for (const file of files) {
      yield* checkScanAbort(signal)
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(sessionsDir, file)
      if (seenFiles.has(filePath)) continue
      sources.push({ path: filePath, project: entry.name, provider: 'openclaw' })
    }
  }

  return sources
})

export function createOpenClawProvider(overrideDir?: string): Provider {
  const discoverEffect = Effect.fn('discoverOpenClawSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkScanAbort(context?.signal)
    if (overrideDir) return yield* discoverInDir(overrideDir, context?.signal)
    const all: SessionSource[] = []
    for (const dir of getOpenClawDirs()) all.push(...(yield* discoverInDir(dir, context?.signal)))
    return all
  })

  return {
    name: 'openclaw',
    displayName: 'OpenClaw',

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

export const openclaw = createOpenClawProvider()
