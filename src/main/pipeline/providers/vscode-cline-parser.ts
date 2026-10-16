import { Effect, Result, Schema, Stream } from 'effect'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join, posix, win32 } from 'path'

import { captureScanPricing } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { ScanPricing } from '../scan-pricing.js'
import type { ProviderScanContext } from './types.js'
import type { ParsedProviderCall, SessionParser, SessionSource } from './types.js'

export type ClineTaskCandidate = {
  source: SessionSource
  mtimeMs: number
}

const stringSchema = Schema.String
const finiteSchema = Schema.Finite
const timestampSchema = Schema.Union([Schema.Finite, Schema.String])
const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
const arraySchema = Schema.Array(Schema.Unknown)
const uiMessageRoleSchema = Schema.Struct({ type: Schema.String, say: Schema.String })
const historyMessageRoleSchema = Schema.Struct({ role: Schema.String })
const historyContentSchema = Schema.Struct({ content: Schema.Array(Schema.Unknown) })
const historyTextSchema = Schema.Struct({ text: Schema.String })
const decodeUiMessageRole = Schema.decodeUnknownResult(uiMessageRoleSchema)
const decodeHistoryMessageRole = Schema.decodeUnknownResult(historyMessageRoleSchema)
const decodeHistoryContent = Schema.decodeUnknownResult(historyContentSchema)
const decodeHistoryText = Schema.decodeUnknownResult(historyTextSchema)
const decodeString = Schema.decodeUnknownResult(stringSchema)
const decodeFinite = Schema.decodeUnknownResult(finiteSchema)
const decodeTimestamp = Schema.decodeUnknownResult(timestampSchema)
const decodeRecord = Schema.decodeUnknownResult(recordSchema)
const decodeArray = Schema.decodeUnknownResult(arraySchema)

type UiMessage = {
  type: string
  say: string
  text?: unknown
  ts?: unknown
}

type HistoryMeta = { model: string; workspace: string | null }
type ApiRequestEntry = {
  index: number
  entry: UiMessage
}

function ignoredUnlessAborted<A>(effect: Effect.Effect<A, Error>): Effect.Effect<A | null, Error> {
  return effect.pipe(Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))))
}

export function getVSCodeGlobalStoragePaths(
  extensionId: string,
  homeDir = homedir(),
  platform = process.platform,
): string[] {
  const pathJoin = platform === 'win32' ? win32.join : posix.join

  if (platform === 'darwin') {
    return [
      pathJoin(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extensionId),
      pathJoin(homeDir, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', extensionId),
      pathJoin(homeDir, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', extensionId),
    ]
  }

  if (platform === 'win32') {
    return [
      pathJoin(homeDir, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', extensionId),
      pathJoin(homeDir, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage', extensionId),
      pathJoin(homeDir, 'AppData', 'Roaming', 'VSCodium', 'User', 'globalStorage', extensionId),
    ]
  }

  return [
    pathJoin(homeDir, '.config', 'Code', 'User', 'globalStorage', extensionId),
    pathJoin(homeDir, '.config', 'Code - Insiders', 'User', 'globalStorage', extensionId),
    pathJoin(homeDir, '.config', 'VSCodium', 'User', 'globalStorage', extensionId),
  ]
}

export function getVSCodeGlobalStoragePath(extensionId: string): string {
  return getVSCodeGlobalStoragePaths(extensionId)[0] ?? ''
}

function defaultBaseDirs(extensionId: string, overrideDir?: string | string[]): string[] {
  return overrideDir
    ? Array.isArray(overrideDir)
      ? overrideDir
      : [overrideDir]
    : getVSCodeGlobalStoragePaths(extensionId)
}

function statOrNull(path: string, signal?: AbortSignal) {
  return ignoredUnlessAborted(scanIo(() => stat(path), signal))
}

export const discoverClineTaskCandidatesEffect = Effect.fn('discoverClineTaskCandidates')(function* (
  extensionId: string,
  providerName: string,
  displayName: string,
  overrideDir?: string | string[],
  signal?: AbortSignal,
): Effect.fn.Return<ClineTaskCandidate[], Error> {
  return yield* discoverClineTaskCandidatesInBaseDirsEffect(
    defaultBaseDirs(extensionId, overrideDir),
    providerName,
    displayName,
    signal,
  )
})

export const discoverClineTaskCandidatesInBaseDirsEffect = Effect.fn('discoverClineTaskCandidatesInBaseDirs')(
  function* (
    baseDirs: string[],
    providerName: string,
    displayName: string,
    signal?: AbortSignal,
  ): Effect.fn.Return<ClineTaskCandidate[], Error> {
    const candidates: ClineTaskCandidate[] = []
    const seenPaths = new Set<string>()

    for (const baseDir of baseDirs) {
      yield* checkScanAbort(signal)
      const tasksDir = join(baseDir, 'tasks')
      const taskDirs = yield* ignoredUnlessAborted(scanIo(() => readdir(tasksDir), signal))
      if (taskDirs === null) continue

      for (const taskId of taskDirs) {
        yield* checkScanAbort(signal)
        const taskDir = join(tasksDir, taskId)
        const dirStat = yield* statOrNull(taskDir, signal)
        if (!dirStat?.isDirectory()) continue

        const uiPath = join(taskDir, 'ui_messages.json')
        const uiStat = yield* statOrNull(uiPath, signal)
        if (!uiStat?.isFile() || seenPaths.has(taskDir)) continue
        seenPaths.add(taskDir)
        candidates.push({
          source: { path: taskDir, project: displayName, provider: providerName },
          mtimeMs: uiStat.mtimeMs,
        })
      }
    }

    yield* checkScanAbort(signal)
    return candidates
  },
)

// Remove these Promise adapters once all direct discovery callers use Effect.
export function discoverClineTasks(
  extensionId: string,
  providerName: string,
  displayName: string,
  overrideDir?: string | string[],
): Promise<SessionSource[]> {
  return Effect.runPromise(discoverClineTaskCandidatesEffect(extensionId, providerName, displayName, overrideDir)).then(
    candidates => candidates.map(candidate => candidate.source),
  )
}

export function discoverClineTasksInBaseDirs(
  baseDirs: string[],
  providerName: string,
  displayName: string,
): Promise<SessionSource[]> {
  return Effect.runPromise(discoverClineTaskCandidatesInBaseDirsEffect(baseDirs, providerName, displayName)).then(
    candidates => candidates.map(candidate => candidate.source),
  )
}

const MODEL_TAG_RE = /<model>([^<]+)<\/model>/
const WORKSPACE_DIR_RE = /Current Workspace Directory \(([^)]+)\)/

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function decodeUiMessages(raw: string): UiMessage[] | null {
  const parsed = decodeArray(parseJson(raw))
  if (Result.isFailure(parsed)) return null
  return parsed.success.flatMap(candidate => {
    const role = decodeUiMessageRole(candidate)
    if (Result.isFailure(role)) return []
    const record = decodeRecord(candidate)
    if (Result.isSuccess(record)) {
      return [
        { type: role.success.type, say: role.success.say, text: record.success['text'], ts: record.success['ts'] },
      ]
    }
    return [{ type: role.success.type, say: role.success.say }]
  })
}

function decodedString(value: unknown): string | undefined {
  const decoded = decodeString(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function extractHistoryMeta(raw: string, fallbackModel: string): HistoryMeta {
  const parsed = decodeArray(parseJson(raw))
  if (Result.isFailure(parsed)) return { model: fallbackModel, workspace: null }
  let model: string | null = null
  let workspace: string | null = null

  for (const candidate of parsed.success) {
    const role = decodeHistoryMessageRole(candidate)
    if (Result.isFailure(role) || role.success.role !== 'user') continue
    const content = decodeHistoryContent(candidate)
    if (Result.isFailure(content)) continue
    for (const block of content.success.content) {
      const decoded = decodeHistoryText(block)
      if (Result.isFailure(decoded)) continue
      if (!model) {
        const match = MODEL_TAG_RE.exec(decoded.success.text)
        if (match?.[1]) {
          const modelParts = match[1].split('/')
          model = match[1].includes('/') ? (modelParts[modelParts.length - 1] ?? '') : match[1]
        }
      }
      if (!workspace) {
        const match = WORKSPACE_DIR_RE.exec(decoded.success.text)
        if (match?.[1]) workspace = match[1]
      }
      if (model && workspace) break
    }
    if (model && workspace) break
  }

  return { model: model ?? fallbackModel, workspace }
}

function workspaceToProject(workspace: string): string {
  return basename(workspace) || workspace
}

function requestNumber(record: Record<string, unknown>, key: string): { value: number; invalid: boolean } {
  const value = record[key]
  if (value == null) return { value: 0, invalid: false }
  const decoded = decodeFinite(value)
  return Result.isSuccess(decoded) ? { value: decoded.success, invalid: false } : { value: 0, invalid: true }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function createParserStream(
  source: SessionSource,
  seenKeys: Set<string>,
  providerName: string,
  fallbackModel: string,
  pricing: ScanPricing,
  signal?: AbortSignal,
  onUnparsedCall: Effect.Effect<void> = Effect.void,
): Stream.Stream<ParsedProviderCall, Error> {
  const parseEffect = Effect.fnUntraced(function* (): Effect.fn.Return<
    Stream.Stream<ParsedProviderCall, Error>,
    Error
  > {
    yield* checkScanAbort(signal)
    const uiRaw = yield* ignoredUnlessAborted(
      scanIo(() => readFile(join(source.path, 'ui_messages.json'), 'utf-8'), signal),
    )
    yield* checkScanAbort(signal)
    if (uiRaw === null) return Stream.empty
    const uiMessages = decodeUiMessages(uiRaw)
    if (uiMessages === null) return Stream.empty
    yield* checkScanAbort(signal)

    const historyRaw = yield* ignoredUnlessAborted(
      scanIo(() => readFile(join(source.path, 'api_conversation_history.json'), 'utf-8'), signal),
    )
    const meta =
      historyRaw === null ? { model: fallbackModel, workspace: null } : extractHistoryMeta(historyRaw, fallbackModel)
    yield* checkScanAbort(signal)
    const project = meta.workspace ? workspaceToProject(meta.workspace) : undefined
    const projectPath = meta.workspace ?? undefined

    let userMessage = ''
    for (const message of uiMessages) {
      if (message.type !== 'say' || (message.say !== 'user_feedback' && message.say !== 'text')) continue
      userMessage = (decodedString(message.text) ?? '').slice(0, 500)
      break
    }

    const apiRequests: ApiRequestEntry[] = uiMessages
      .filter(message => message.type === 'say' && message.say === 'api_req_started')
      .map((entry, index) => ({ entry, index }))

    return Stream.fromIterable(apiRequests).pipe(
      Stream.rechunk(1),
      Stream.mapEffect(request =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const deduplicationKey = `${providerName}:${basename(source.path)}:${request.index}`
          if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)
          seenKeys.add(deduplicationKey)

          let values: Record<string, unknown> = {}
          const text = decodedString(request.entry.text)
          if (text) {
            const parsed = decodeRecord(parseJson(text))
            if (Result.isSuccess(parsed)) values = parsed.success
          }
          const tokensIn = requestNumber(values, 'tokensIn')
          const tokensOut = requestNumber(values, 'tokensOut')
          const cacheReads = requestNumber(values, 'cacheReads')
          const cacheWrites = requestNumber(values, 'cacheWrites')
          const rawCost = values['cost']
          const costDecoded = rawCost == null ? null : decodeFinite(rawCost)
          const invalidCost = costDecoded !== null && Result.isFailure(costDecoded)

          // Keep legacy ordering: key, zero-token skip, timestamp conversion, then validation.
          const invalidCounters = tokensIn.invalid || tokensOut.invalid || cacheReads.invalid || cacheWrites.invalid
          const otherwiseEmittable =
            tokensIn.invalid || tokensOut.invalid || tokensIn.value !== 0 || tokensOut.value !== 0
          if (!otherwiseEmittable) return Result.fail(undefined)

          const rawTimestamp = request.entry.ts
          let timestamp = ''
          if (rawTimestamp) {
            const decodedTimestamp = decodeTimestamp(rawTimestamp)
            if (Result.isFailure(decodedTimestamp))
              return yield* Effect.fail(new Error('Invalid Cline request timestamp'))
            timestamp = yield* Effect.try({
              try: () => new Date(decodedTimestamp.success).toISOString(),
              catch: toError,
            })
          }

          if (invalidCounters || invalidCost) {
            yield* onUnparsedCall
            return Result.fail(undefined)
          }

          const model = meta.model
          const costUSD = yield* Effect.try({
            try: () =>
              costDecoded && Result.isSuccess(costDecoded)
                ? costDecoded.success
                : pricing.calculateCost(model, tokensIn.value, tokensOut.value, cacheWrites.value, cacheReads.value, 0),
            catch: toError,
          })
          yield* checkScanAbort(signal)
          return Result.succeed({
            provider: providerName,
            model,
            inputTokens: tokensIn.value,
            outputTokens: tokensOut.value,
            cacheCreationInputTokens: cacheWrites.value,
            cacheReadInputTokens: cacheReads.value,
            cachedInputTokens: cacheReads.value,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD,
            tools: [],
            bashCommands: [],
            timestamp,
            speed: 'standard',
            deduplicationKey,
            userMessage: request.index === 0 ? userMessage : '',
            sessionId: basename(source.path),
            project,
            projectPath,
          } satisfies ParsedProviderCall)
        }),
      ),
      Stream.filterMap(call => call),
    )
  })

  return Stream.unwrap(parseEffect())
}

export function createClineParser(
  source: SessionSource,
  seenKeys: Set<string>,
  providerName: string,
  fallbackModel = 'cline-auto',
  pricing?: ScanPricing,
  context?: ProviderScanContext,
): SessionParser {
  const activePricing = context?.pricing ?? pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseStream = (onUnparsedCall: Effect.Effect<void> = Effect.void): Stream.Stream<ParsedProviderCall, Error> =>
    createParserStream(source, seenKeys, providerName, fallbackModel, activePricing, signal, onUnparsedCall)

  return {
    parseStream,
    // Remove this async-generator adapter when all direct callers consume parseStream.
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}
