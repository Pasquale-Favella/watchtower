import { Effect, Result, Schema, Stream } from 'effect'
import { readFile } from 'fs/promises'
import { join } from 'path'

import { captureScanPricing } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, readDirectoryOrEmpty, scanIo } from '../scan-io.js'
import type { ScanPricing } from '../scan-pricing.js'
import { buildAssistantCall, type MessageData, type PartData, sanitize } from './session-message.js'
import type { ParsedProviderCall, ProviderScanContext, SessionParser, SessionSource } from './types.js'

// OpenCode 1.1+ stores sessions as file-based JSON instead of a SQLite DB:
//   storage/session/<projectID>/<sessionID>.json   session metadata
//   storage/message/<sessionID>/<messageID>.json    one file per message
//   storage/part/<messageID>/<partID>.json          one file per part
// The message/part shape matches the SQLite layout, so the per-message build
// logic is shared via buildAssistantCall.

const createdAtSchema = Schema.optional(Schema.Union([Schema.Number, Schema.String]))
const fileTimeSchema = Schema.Struct({ created: createdAtSchema })

const sessionMetaSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  directory: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  time: Schema.optional(fileTimeSchema),
})

// Keep only helper-consumed top-level fields. Nested vendor fields remain
// unknown until the shared builder reads them, so an unrelated sibling cannot
// invalidate an otherwise usable message.
const fileMessageSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.optional(Schema.Unknown),
  time: Schema.optional(fileTimeSchema),
  modelID: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Unknown),
  tokens: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Schema.Unknown),
})

const filePartSchema = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.Unknown),
  tool: Schema.optional(Schema.Unknown),
  state: Schema.optional(Schema.Unknown),
})
const decodeSessionMetaJson = Schema.decodeUnknownResult(Schema.fromJsonString(sessionMetaSchema))
const decodeFileMessageJson = Schema.decodeUnknownResult(Schema.fromJsonString(fileMessageSchema))
const decodeFilePartJson = Schema.decodeUnknownResult(Schema.fromJsonString(filePartSchema))
const decodeString = Schema.decodeUnknownResult(Schema.String)
type SessionMeta = Schema.Schema.Type<typeof sessionMetaSchema>
type FileMessageData = Schema.Schema.Type<typeof fileMessageSchema> & { readonly id: string }

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

const readJsonText = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<string | null, Error> {
  return yield* scanIo(() => readFile(path, 'utf8'), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
})

function stringOrEmpty(value: unknown): string {
  const decoded = decodeString(value)
  return Result.isSuccess(decoded) ? decoded.success : ''
}

function metaDirectory(meta: SessionMeta): string | undefined {
  return meta.directory || undefined
}

function metaProject(meta: SessionMeta): string {
  return sanitize(metaDirectory(meta) || meta.title || '')
}

function createdAt(value: FileMessageData['time'] | SessionMeta['time']): number | string | undefined {
  return value?.created
}

function compareMessages(a: FileMessageData, b: FileMessageData): number {
  const byTime = ((createdAt(a.time) ?? 0) as number) - ((createdAt(b.time) ?? 0) as number)
  if (byTime !== 0) return byTime
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const readParts = Effect.fnUntraced(function* (
  dataDir: string,
  messageId: string,
  signal?: AbortSignal,
): Effect.fn.Return<PartData[], Error> {
  const dir = join(dataDir, 'storage', 'part', messageId)
  const files = (yield* readDirectoryOrEmpty(dir, signal)).sort()
  const parts: PartData[] = []
  for (const file of files) {
    yield* checkScanAbort(signal)
    if (!file.endsWith('.json')) continue
    const raw = yield* readJsonText(join(dir, file), signal)
    if (raw === null) continue
    const decoded = decodeFilePartJson(raw)
    if (Result.isSuccess(decoded)) parts.push(decoded.success as PartData)
  }
  return parts
})

export const discoverOpenCodeFileSessionsEffect = Effect.fn('discoverOpenCodeFileSessions')(function* (
  dataDir: string,
  providerName: string,
  context?: ProviderScanContext,
): Effect.fn.Return<SessionSource[], Error> {
  const signal = context?.signal
  yield* checkScanAbort(signal)
  const sessionRoot = join(dataDir, 'storage', 'session')
  const projectDirs = yield* readDirectoryOrEmpty(sessionRoot, signal)
  const sources: SessionSource[] = []

  for (const project of projectDirs) {
    yield* checkScanAbort(signal)
    const sessionFiles = yield* readDirectoryOrEmpty(join(sessionRoot, project), signal)
    for (const file of sessionFiles) {
      yield* checkScanAbort(signal)
      if (!file.endsWith('.json')) continue
      const path = join(sessionRoot, project, file)
      const raw = yield* readJsonText(path, signal)
      if (raw === null) continue
      const decoded = decodeSessionMetaJson(raw)
      if (Result.isFailure(decoded)) continue
      const meta = decoded.success
      const id = meta.id ?? ''
      if (!id) continue
      const directory = metaDirectory(meta)
      sources.push({
        path,
        project: metaProject(meta),
        provider: providerName,
        ...(directory ? { workingDirectory: directory } : {}),
      })
    }
  }
  return sources
})

/** Promise edge for file-session callers that have not moved to the native hook. */
export function discoverOpenCodeFileSessions(
  dataDir: string,
  providerName: string,
  context?: ProviderScanContext,
): Promise<SessionSource[]> {
  // eslint-disable-next-line no-restricted-syntax
  return Effect.runPromise(discoverOpenCodeFileSessionsEffect(dataDir, providerName, context))
}

function parseOpenCodeFileStream(
  source: SessionSource,
  seenKeys: Set<string>,
  dataDir: string,
  providerName: string,
  pricing: ScanPricing,
  context?: ProviderScanContext,
): Stream.Stream<ParsedProviderCall, Error> {
  const signal = context?.signal
  const parseEffect = Effect.fn('parseOpenCodeFileSession')(function* (): Effect.fn.Return<
    Stream.Stream<ParsedProviderCall, Error>,
    Error
  > {
    yield* checkScanAbort(signal)
    const rawMeta = yield* readJsonText(source.path, signal)
    if (rawMeta === null) return Stream.empty
    const decodedMeta = decodeSessionMetaJson(rawMeta)
    if (Result.isFailure(decodedMeta)) return Stream.empty
    const meta = decodedMeta.success
    const sessionId = meta.id ?? ''
    if (!sessionId) return Stream.empty
    const directory = metaDirectory(meta)

    const messageDir = join(dataDir, 'storage', 'message', sessionId)
    const messageFiles = yield* readDirectoryOrEmpty(messageDir, signal)
    const messages: FileMessageData[] = []
    for (const file of messageFiles) {
      yield* checkScanAbort(signal)
      if (!file.endsWith('.json')) continue
      const raw = yield* readJsonText(join(messageDir, file), signal)
      if (raw === null) continue
      const decoded = decodeFileMessageJson(raw)
      if (Result.isFailure(decoded)) continue
      messages.push({ ...decoded.success, id: decoded.success.id ?? file.replace(/\.json$/, '') })
    }
    messages.sort(compareMessages)

    let currentUserMessage = ''
    return Stream.fromIterable(messages).pipe(
      Stream.rechunk(1),
      Stream.mapEffect(message =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const role = stringOrEmpty(message.role)
          if (role === 'user') {
            const parts = yield* readParts(dataDir, message.id, signal)
            const text = parts
              .filter(part => part.type === 'text')
              .map(part => part.text ?? '')
              .filter(Boolean)
              .join(' ')
            if (text) currentUserMessage = text
            return Result.fail(undefined)
          }

          if (role !== 'assistant' && role !== 'model') return Result.fail(undefined)
          const dedupKey = `${providerName}:${sessionId}:${message.id}`
          if (seenKeys.has(dedupKey)) return Result.fail(undefined)

          const parts = yield* readParts(dataDir, message.id, signal)
          const data: MessageData = {
            role,
            ...(message.modelID !== undefined ? { modelID: message.modelID as string } : {}),
            ...(message.model !== undefined ? { model: message.model as string } : {}),
            ...(message.cost !== undefined ? { cost: message.cost as number } : {}),
            ...(message.tokens !== undefined ? { tokens: message.tokens as MessageData['tokens'] } : {}),
            ...(message.usage !== undefined ? { usage: message.usage as MessageData['usage'] } : {}),
          }
          const call = yield* Effect.try({
            try: () =>
              buildAssistantCall({
                providerName,
                dedupKey,
                sessionId,
                data,
                parts,
                timeCreatedMs: (createdAt(message.time) ?? createdAt(meta.time) ?? 0) as number,
                userMessage: currentUserMessage,
                ...(directory ? { directory } : {}),
                pricing,
              }),
            catch: toError,
          })
          if (!call) return Result.fail(undefined)

          // Keep parity: only non-null calls claim their key, after pricing and
          // all per-message parts have been consumed.
          seenKeys.add(dedupKey)
          return Result.succeed(call)
        }),
      ),
      Stream.filterMap(call => call),
    )
  })

  return Stream.unwrap(parseEffect())
}

export function createOpenCodeFileSessionParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dataDir: string,
  providerName: string,
  pricing?: ScanPricing,
  context?: ProviderScanContext,
): SessionParser {
  const activePricing = context?.pricing ?? pricing ?? captureScanPricing()
  // This helper emits the builder's raw record; the shared extraction schema
  // owns its skip-and-tally boundary after the stream yields the call.
  const parseStream: NonNullable<SessionParser['parseStream']> = () =>
    parseOpenCodeFileStream(source, seenKeys, dataDir, providerName, activePricing, context)

  return {
    parseStream,
    // Remove this iterator edge after scanner and external callers use parseStream.
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}
