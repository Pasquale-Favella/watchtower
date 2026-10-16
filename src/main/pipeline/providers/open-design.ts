import { Effect, Result, Schema, Stream } from 'effect'
import { stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

import { type AppPaths, overrideFor, platformFor } from '../../env.js'
import { billableOutputTokens } from '../billable-output.js'
import { readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, readDirectoryOrEmpty, scanIo } from '../scan-io.js'
import type { ScanPricing } from '../scan-pricing.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

const PROVIDER_NAME = 'open-design'
const ENV_DIR = 'WATCHTOWER_OPEN_DESIGN_DIR'

const modelDisplayNames = new Map<string, string>([
  ['openai-codex:gpt-5.5', 'GPT-5.5'],
  ['glm-5.2', 'GLM-5.2'],
  ['GLM-5.2', 'GLM-5.2'],
])

const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
const stringSchema = Schema.String
const finiteSchema = Schema.Finite
const decodeRecord = Schema.decodeUnknownResult(recordSchema)
const decodeEventJson = Schema.decodeUnknownResult(Schema.fromJsonString(recordSchema))
const decodeString = Schema.decodeUnknownResult(stringSchema)
const decodeFinite = Schema.decodeUnknownResult(finiteSchema)

type OpenDesignEntry = Record<string, unknown>

type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

function stringValue(value: unknown): string | undefined {
  const decoded = decodeString(value)
  return Result.isSuccess(decoded) && decoded.success.length > 0 ? decoded.success : undefined
}

function tokenValue(value: unknown): number {
  const decoded = decodeFinite(value)
  return Result.isSuccess(decoded) && decoded.success > 0 ? decoded.success : 0
}

function timestampValue(value: unknown): string {
  const text = stringValue(value)
  if (text) return text
  const decoded = decodeFinite(value)
  if (Result.isFailure(decoded)) return ''

  const date = new Date(decoded.success)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function parseEvent(line: string | Buffer): OpenDesignEntry | null {
  const decoded = decodeEventJson(typeof line === 'string' ? line.trim() : line.toString('utf-8').trim())
  return Result.isSuccess(decoded) ? decoded.success : null
}

function recordValue(value: unknown): OpenDesignEntry | null {
  const decoded = decodeRecord(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function parseUsage(data: OpenDesignEntry): TokenUsage | null {
  if (data['type'] !== 'usage') return null
  const usage = recordValue(data['usage'])
  if (!usage) return null

  return {
    inputTokens: tokenValue(usage['input_tokens']),
    outputTokens: tokenValue(usage['output_tokens']),
    cacheReadTokens: tokenValue(usage['cached_read_tokens']),
    reasoningTokens: tokenValue(usage['thought_tokens']),
  }
}

export function getOpenDesignDir(paths?: AppPaths): string {
  const override = overrideFor(paths, ENV_DIR)
  // The environment override historically used a truthiness check. An empty
  // factory override is distinct because createOpenDesignProvider uses ??.
  if (override) return override

  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Open Design')
  if (process.platform === 'win32') {
    return join(platformFor(paths).appData ?? join(home, 'AppData', 'Roaming'), 'Open Design')
  }
  return join(home, '.config', 'Open Design')
}

function namespaceFromDataDir(dataDir: string): string {
  const ns = basename(dirname(dataDir))
  return ns && ns !== 'namespaces' ? ns : PROVIDER_NAME
}

function namespaceFromRunsDir(runsDir: string): string {
  return namespaceFromDataDir(dirname(runsDir))
}

function statFile(path: string, signal?: AbortSignal): Effect.Effect<boolean, Error> {
  return scanIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isFile()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
}

const discoverRunsDir = Effect.fnUntraced(function* (
  runsDir: string,
  project: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const sources: SessionSource[] = []
  const runDirs = yield* readDirectoryOrEmpty(runsDir, signal)

  for (const runDir of runDirs) {
    yield* checkScanAbort(signal)
    const eventsPath = join(runsDir, runDir, 'events.jsonl')
    if (!(yield* statFile(eventsPath, signal))) continue
    sources.push({ path: eventsPath, project, provider: PROVIDER_NAME })
  }

  return sources
})

const discoverNamespacesDir = Effect.fnUntraced(function* (
  namespacesDir: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const sources: SessionSource[] = []
  const namespaces = yield* readDirectoryOrEmpty(namespacesDir, signal)

  for (const ns of namespaces) {
    yield* checkScanAbort(signal)
    sources.push(...(yield* discoverRunsDir(join(namespacesDir, ns, 'data', 'runs'), ns, signal)))
  }

  return sources
})

function dedupeSources(sources: SessionSource[]): SessionSource[] {
  const seen = new Set<string>()
  const out: SessionSource[] = []
  for (const source of sources) {
    if (seen.has(source.path)) continue
    seen.add(source.path)
    out.push(source)
  }
  return out
}

const discoverOpenDesignSessionsEffect = Effect.fn('discoverOpenDesignSessions')(function* (
  baseDir: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  yield* checkScanAbort(signal)
  const baseName = basename(baseDir)
  if (baseName === 'runs') return yield* discoverRunsDir(baseDir, namespaceFromRunsDir(baseDir), signal)
  if (baseName === 'data') {
    return yield* discoverRunsDir(join(baseDir, 'runs'), namespaceFromDataDir(baseDir), signal)
  }

  const project = baseName || PROVIDER_NAME
  const sources = [
    ...(yield* discoverRunsDir(join(baseDir, 'data', 'runs'), project, signal)),
    ...(yield* discoverRunsDir(join(baseDir, 'runs'), project, signal)),
    ...(yield* discoverNamespacesDir(baseName === 'namespaces' ? baseDir : join(baseDir, 'namespaces'), signal)),
  ]
  yield* checkScanAbort(signal)
  return dedupeSources(sources)
})

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing: ScanPricing,
  context?: ProviderScanContext,
): SessionParser {
  const signal = context?.signal
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        const sessionId = basename(dirname(source.path))
        let currentModel = ''
        let fallbackEventCounter = 0

        return readSessionLinesStream(source.path, undefined, signal ? { signal } : {}).pipe(
          Stream.mapEffect(line =>
            Effect.gen(function* () {
              yield* checkScanAbort(signal)
              const entry = parseEvent(line)
              if (!entry) return Result.fail(undefined)

              const eventName = stringValue(entry['event'])
              const data = recordValue(entry['data'])
              if (!data) return Result.fail(undefined)

              if (eventName === 'start') {
                const model = stringValue(data['model'])
                if (model) currentModel = model
                return Result.fail(undefined)
              }
              if (eventName !== 'agent') return Result.fail(undefined)

              if (data['type'] === 'status') {
                const model = stringValue(data['model'])
                if (model) currentModel = model
                return Result.fail(undefined)
              }

              const usage = parseUsage(data)
              if (!usage || !currentModel) return Result.fail(undefined)

              const eventId = stringValue(entry['id']) ?? `line-${fallbackEventCounter++}`
              const dedupKey = `${PROVIDER_NAME}:${sessionId}:${eventId}`
              if (seenKeys.has(dedupKey)) return Result.fail(undefined)
              yield* checkScanAbort(signal)
              seenKeys.add(dedupKey)

              const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens)
              const costUSD = yield* Effect.try({
                try: () =>
                  pricing.calculateCost(
                    currentModel,
                    uncachedInputTokens,
                    billableOutputTokens(PROVIDER_NAME, usage.outputTokens, usage.reasoningTokens),
                    0,
                    usage.cacheReadTokens,
                    0,
                  ),
                catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
              })

              return Result.succeed({
                provider: PROVIDER_NAME,
                sessionId,
                project: source.project,
                model: currentModel,
                inputTokens: uncachedInputTokens,
                outputTokens: usage.outputTokens,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: usage.cacheReadTokens,
                cachedInputTokens: usage.cacheReadTokens,
                reasoningTokens: usage.reasoningTokens,
                webSearchRequests: 0,
                costUSD,
                tools: [],
                bashCommands: [],
                timestamp: timestampValue(entry['timestamp']),
                speed: 'standard',
                deduplicationKey: dedupKey,
                userMessage: '',
              } satisfies ParsedProviderCall)
            }),
          ),
          Stream.filterMap(call => call),
        )
      }),
    )

  return {
    parseStream,
    // Remove this compatibility adapter when direct callers use parseStream.
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

export function createOpenDesignProvider(overrideDir?: string, paths?: AppPaths): Provider {
  const discoverEffect = Effect.fn('discoverOpenDesignSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    const baseDir = overrideDir ?? getOpenDesignDir(paths)
    return yield* discoverOpenDesignSessionsEffect(baseDir, context?.signal)
  })

  return {
    name: PROVIDER_NAME,
    displayName: 'Open Design',

    modelDisplayName(model: string): string {
      return modelDisplayNames.get(model) ?? model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    discoverSessionsEffect: discoverEffect,
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // Remove this Promise edge after external callers consume native discovery.
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

export const openDesign = createOpenDesignProvider()
