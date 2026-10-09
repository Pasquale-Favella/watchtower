import { Effect, Result, Schema, Stream } from 'effect'
import { stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { MAX_SESSION_FILE_BYTES, readSessionFileEffect, readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing, getShortModelName } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, readDirectoryOrEmpty, scanIo } from '../scan-io.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

// Grok Build (xAI's coding CLI) stores one session per directory at
// <grok-home>/sessions/<url-encoded-cwd>/<uuid>/, where grok-home is $GROK_HOME
// or ~/.grok. Each session dir holds summary.json, signals.json, and the ACP
// log updates.jsonl.
//
// Grok does NOT record billable input/output tokens. signals.json carries
// `contextTokensUsed` (current context fill) and updates.jsonl carries a running
// `_meta.totalTokens` per streamed chunk; there is no per-call input/output
// split. We reconstruct an ESTIMATE from the per-turn totalTokens curve. Agentic
// turns re-send the growing context every call, and that re-sent context is
// cached server-side, so we bill the unique context (summed per compaction segment) as fresh input,
// the re-sent remainder as cache reads, and the per-turn growth as output. Cost
// is flagged estimated; grok-build is priced via its grok-build-0.1 alias.

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  run_terminal_command: 'Bash',
  read_file: 'Read',
  read: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  edit: 'Edit',
  list_dir: 'Glob',
  glob: 'Glob',
  grep: 'Grep',
  search: 'WebSearch',
  web_search: 'WebSearch',
  fetch: 'WebFetch',
  task: 'Agent',
  search_replace: 'Edit',
  todo_write: 'TodoWrite',
  spawn_subagent: 'Agent',
}

function defaultSessionsDir(): string {
  const home = process.env['GROK_HOME'] ?? join(homedir(), '.grok')
  return join(home, 'sessions')
}

const summaryJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    info: Schema.optional(Schema.Unknown),
    created_at: Schema.optional(Schema.Unknown),
    updated_at: Schema.optional(Schema.Unknown),
    last_active_at: Schema.optional(Schema.Unknown),
    current_model_id: Schema.optional(Schema.Unknown),
    session_summary: Schema.optional(Schema.Unknown),
    generated_title: Schema.optional(Schema.Unknown),
  }),
)
const infoSchema = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  cwd: Schema.optional(Schema.Unknown),
})
const signalsJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    primaryModelId: Schema.optional(Schema.Unknown),
    modelsUsed: Schema.optional(Schema.Unknown),
  }),
)
const paramsSchema = Schema.Struct({
  _meta: Schema.optional(Schema.Unknown),
  update: Schema.optional(Schema.Unknown),
})
const metaSchema = Schema.Struct({
  totalTokens: Schema.optional(Schema.Unknown),
  promptId: Schema.optional(Schema.Unknown),
})
const updateSchema = Schema.Struct({
  sessionUpdate: Schema.optional(Schema.Unknown),
  title: Schema.optional(Schema.Unknown),
  rawInput: Schema.optional(Schema.Unknown),
})
const rawInputSchema = Schema.Struct({
  command: Schema.optional(Schema.Unknown),
  subagent_type: Schema.optional(Schema.Unknown),
})
const updateJsonSchema = Schema.fromJsonString(Schema.Struct({ params: Schema.optional(Schema.Unknown) }))
const decodeUpdateJson = Schema.decodeUnknownResult(updateJsonSchema)
const decodeSummaryJson = Schema.decodeUnknownResult(summaryJsonSchema)
const decodeSignalsJson = Schema.decodeUnknownResult(signalsJsonSchema)
const decodeInfo = Schema.decodeUnknownResult(infoSchema)
const decodeParams = Schema.decodeUnknownResult(paramsSchema)
const decodeMeta = Schema.decodeUnknownResult(metaSchema)
const decodeUpdate = Schema.decodeUnknownResult(updateSchema)
const decodeRawInput = Schema.decodeUnknownResult(rawInputSchema)
const decodeNullableString = Schema.decodeUnknownResult(Schema.NullOr(Schema.String))
const decodeUnknownArray = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))
const decodeTokens = Schema.decodeUnknownResult(Schema.Finite)

type GrokSummary = {
  readonly id: string | null
  readonly cwd: string | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly lastActiveAt: string | null
  readonly model: string | null
  readonly sessionSummary: string | null
  readonly generatedTitle: string | null
}

type GrokSignals = { readonly primaryModelId: string | null; readonly modelsUsed: readonly string[] }

function decodedString(value: unknown): string | null {
  const result = decodeNullableString(value)
  return Result.isSuccess(result) ? result.success : null
}

function decodeSummary(raw: string): GrokSummary | null {
  const result = decodeSummaryJson(raw)
  if (Result.isFailure(result)) return null
  const value = result.success
  const info = decodeInfo(value.info)
  const decodedInfo = Result.isSuccess(info) ? info.success : undefined
  return {
    id: decodedInfo ? decodedString(decodedInfo.id) : null,
    cwd: decodedInfo ? decodedString(decodedInfo.cwd) : null,
    createdAt: decodedString(value.created_at),
    updatedAt: decodedString(value.updated_at),
    lastActiveAt: decodedString(value.last_active_at),
    model: decodedString(value.current_model_id),
    sessionSummary: decodedString(value.session_summary),
    generatedTitle: decodedString(value.generated_title),
  }
}

function decodeSignals(raw: string): GrokSignals | null {
  const result = decodeSignalsJson(raw)
  if (Result.isFailure(result)) return null
  const models = decodeUnknownArray(result.success.modelsUsed)
  const firstModel = Result.isSuccess(models) ? decodedString(models.success[0]) : null
  return {
    primaryModelId: decodedString(result.success.primaryModelId),
    // The legacy parser only reads index zero. A malformed later element is
    // unrelated input and must not discard that consumed model candidate.
    modelsUsed: firstModel === null ? [] : [firstModel],
  }
}

function safeDecode(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

type GrokUpdate = {
  readonly params?: unknown
}

type UpdateTotals = {
  readonly turns: Map<string, { first: number; last: number }>
  readonly tools: string[]
  readonly bashCommands: string[]
  readonly subagentTypes: string[]
  prevTotal: number
  segmentPeak: number
  inputFresh: number
}

function emptyTotals(): UpdateTotals {
  return {
    turns: new Map(),
    tools: [],
    bashCommands: [],
    subagentTypes: [],
    prevTotal: -1,
    segmentPeak: 0,
    inputFresh: 0,
  }
}

function decodeLine(line: string): GrokUpdate | null {
  if (!line.trim()) return null
  const decoded = decodeUpdateJson(line)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function addUpdate(state: UpdateTotals, line: string): void {
  const record = decodeLine(line)
  if (!record) return
  const paramsResult = decodeParams(record.params)
  if (Result.isFailure(paramsResult)) return
  const params = paramsResult.success
  const metaResult = decodeMeta(params._meta)

  if (Result.isSuccess(metaResult)) {
    const meta = metaResult.success
    const totalResult = decodeTokens(meta.totalTokens)
    if (Result.isSuccess(totalResult)) {
      const total = totalResult.success
      if (state.prevTotal >= 0 && total < state.prevTotal * 0.5) {
        state.inputFresh += state.segmentPeak
        state.segmentPeak = 0
      }
      if (total > state.segmentPeak) state.segmentPeak = total
      state.prevTotal = total

      const promptId = decodedString(meta.promptId)
      if (promptId) {
        const turn = state.turns.get(promptId)
        if (!turn) state.turns.set(promptId, { first: total, last: total })
        else turn.last = total
      }
    }
  }

  const updateResult = decodeUpdate(params.update)
  if (Result.isFailure(updateResult)) return
  const update = updateResult.success
  const sessionUpdate = decodedString(update.sessionUpdate)
  const title = decodedString(update.title)
  if (sessionUpdate !== 'tool_call' || title === null) return
  state.tools.push(toolNameMap[title] ?? title)

  const rawInputResult = decodeRawInput(update.rawInput)
  if (Result.isFailure(rawInputResult)) return
  const command = decodedString(rawInputResult.success.command)
  if (title === 'run_terminal_command' && command !== null) {
    state.bashCommands.push(...extractBashCommands(command))
  }
  const subagentType = decodedString(rawInputResult.success.subagent_type)
  if (title === 'spawn_subagent' && subagentType !== null) state.subagentTypes.push(subagentType)
}

function finishTotals(state: UpdateTotals): {
  input: number
  cacheRead: number
  output: number
  tools: string[]
  bashCommands: string[]
  subagentTypes: string[]
} {
  const input = state.inputFresh + state.segmentPeak
  let sumFirst = 0
  let output = 0
  for (const { first, last } of state.turns.values()) {
    sumFirst += first
    output += Math.max(0, last - first)
  }
  // Fresh input (summed segment peaks) is billed once; the rest of the per-turn
  // re-sends are cache reads (Grok caches them, even though it reports nothing).
  const cacheRead = Math.max(0, sumFirst - input)
  return {
    input,
    cacheRead,
    output,
    tools: state.tools,
    bashCommands: state.bashCommands,
    subagentTypes: state.subagentTypes,
  }
}

const readSummary = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<GrokSummary | null, Error> {
  const raw = yield* readSessionFileEffect(path, 'utf-8', signal ? { signal } : {})
  yield* checkScanAbort(signal)
  return raw === null ? null : decodeSummary(raw)
})

const readSignals = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<GrokSignals | null, Error> {
  const raw = yield* readSessionFileEffect(path, 'utf-8', signal ? { signal } : {})
  yield* checkScanAbort(signal)
  return raw === null ? null : decodeSignals(raw)
})

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        const dir = dirname(source.path)
        const summary = yield* readSummary(join(dir, 'summary.json'), signal)
        if (!summary) return Stream.empty

        const totals = emptyTotals()
        yield* Stream.runForEach(
          readSessionLinesStream(source.path, undefined, {
            // Preserve Grok's previous 128 MiB capped read. The shared line
            // reader also records its standard oversize operational notice.
            maxBytes: MAX_SESSION_FILE_BYTES,
            ...(signal ? { signal } : {}),
          }),
          line =>
            Effect.gen(function* () {
              yield* checkScanAbort(signal)
              addUpdate(totals, line.toString())
            }),
        )
        const { input, cacheRead, output, tools, bashCommands, subagentTypes } = finishTotals(totals)
        if (input === 0 && output === 0) return Stream.empty

        const signals = yield* readSignals(join(dir, 'signals.json'), signal)
        const model = summary.model ?? signals?.primaryModelId ?? signals?.modelsUsed[0] ?? 'grok-build'
        const timestamp = summary.updatedAt ?? summary.lastActiveAt ?? summary.createdAt ?? ''
        const sessionId = summary.id ?? basename(dir)
        const deduplicationKey = `${source.provider}:${dir}:${timestamp}:${sessionId}`
        return Stream.fromEffect(
          checkScanAbort(signal).pipe(
            Effect.map(() => {
              if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)
              seenKeys.add(deduplicationKey)
              const call: ParsedProviderCall = {
                provider: source.provider,
                model,
                inputTokens: input,
                outputTokens: output,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: cacheRead,
                cachedInputTokens: cacheRead,
                reasoningTokens: 0,
                webSearchRequests: 0,
                costUSD: pricing.calculateCost(model, input, output, 0, cacheRead, 0),
                costIsEstimated: true,
                tools,
                bashCommands,
                subagentTypes,
                timestamp,
                speed: 'standard',
                deduplicationKey,
                userMessage: summary.sessionSummary ?? summary.generatedTitle ?? '',
                sessionId,
                project: source.project,
                projectPath: summary.cwd ?? undefined,
              }
              return Result.succeed(call)
            }),
          ),
        ).pipe(Stream.filterMap(value => value))
      }),
    )

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // Remove this Promise edge when direct parser callers consume parseStream.
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

const isDirectory = Effect.fnUntraced(function* (path: string, signal?: AbortSignal): Effect.fn.Return<boolean, Error> {
  return yield* scanIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isDirectory()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
})

export function createGrokProvider(sessionsDir?: string): Provider {
  const dir = sessionsDir ?? defaultSessionsDir()
  const discoverEffect = Effect.fn('discoverGrokSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkScanAbort(context?.signal)
    const sources: SessionSource[] = []
    const cwdDirs = yield* readDirectoryOrEmpty(dir, context?.signal)
    for (const cwdName of cwdDirs) {
      yield* checkScanAbort(context?.signal)
      const cwdPath = join(dir, cwdName)
      if (!(yield* isDirectory(cwdPath, context?.signal))) continue
      const sessionDirs = yield* readDirectoryOrEmpty(cwdPath, context?.signal)
      for (const sessionName of sessionDirs) {
        yield* checkScanAbort(context?.signal)
        const sessionPath = join(cwdPath, sessionName)
        if (!(yield* isDirectory(sessionPath, context?.signal))) continue
        const summary = yield* readSummary(join(sessionPath, 'summary.json'), context?.signal)
        if (!summary) continue
        const cwd = summary.cwd ?? safeDecode(cwdName)
        sources.push({ path: join(sessionPath, 'updates.jsonl'), project: basename(cwd), provider: 'grok' })
      }
    }
    return sources
  })

  return {
    name: 'grok',
    displayName: 'Grok Build',

    modelDisplayName(model: string): string {
      if (model.startsWith('grok-build')) return 'Grok Build'
      return getShortModelName(model)
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

export const grok = createGrokProvider()
