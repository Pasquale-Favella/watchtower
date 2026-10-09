import { Effect, Result, Schema, Stream } from 'effect'
import { homedir, platform } from 'os'
import { basename, join } from 'path'

import { readSessionFileEffect } from '../fs-utils.js'
import { captureScanPricing, getShortModelName } from '../models.js'
import { checkScanAbort, readDirectoryOrEmpty } from '../scan-io.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

// zerostack (https://github.com/gi-dellav/zerostack) is a minimal Rust coding
// agent. Each session is a single JSON file under <dataDir>/zerostack/sessions/.
// Token counts are stored as CUMULATIVE session totals (total_input_tokens,
// total_output_tokens, total_cost) — there is no per-call breakdown — so we emit
// one ParsedProviderCall per session.

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  fetch: 'WebFetch',
  search: 'WebSearch',
  task: 'Agent',
}

const zerostackFields = {
  id: Schema.NullOr(Schema.String),
  messages: Schema.Unknown,
  created_at: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
  total_input_tokens: Schema.NullOr(Schema.Finite),
  total_output_tokens: Schema.NullOr(Schema.Finite),
  model: Schema.NullOr(Schema.String),
  working_dir: Schema.NullOr(Schema.String),
}
const zerostackSessionSchema = Schema.Struct({
  id: Schema.optional(zerostackFields.id),
  messages: Schema.optional(zerostackFields.messages),
  created_at: Schema.optional(zerostackFields.created_at),
  updated_at: Schema.optional(zerostackFields.updated_at),
  total_input_tokens: Schema.optional(zerostackFields.total_input_tokens),
  total_output_tokens: Schema.optional(zerostackFields.total_output_tokens),
  model: Schema.optional(zerostackFields.model),
  working_dir: Schema.optional(zerostackFields.working_dir),
})
const zerostackDiscoverySchema = Schema.Struct({ working_dir: Schema.optional(zerostackFields.working_dir) })
const zerostackMessageSchema = Schema.Struct({
  role: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.Unknown),
})
const zerostackContentBlockSchema = Schema.Struct({ text: Schema.optional(Schema.NullOr(Schema.String)) })
const zerostackUserContentSchema = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])
const decodeSessionJson = Schema.decodeUnknownResult(Schema.fromJsonString(zerostackSessionSchema))
const decodeDiscoverySessionJson = Schema.decodeUnknownResult(Schema.fromJsonString(zerostackDiscoverySchema))
const decodeUnknownArray = Schema.decodeUnknownResult(Schema.Array(Schema.Unknown))
const decodeZerostackMessage = Schema.decodeUnknownResult(zerostackMessageSchema)
const decodeUserContent = Schema.decodeUnknownResult(zerostackUserContentSchema)
const decodeContentBlock = Schema.decodeUnknownResult(zerostackContentBlockSchema)
type ZerostackSession = Schema.Schema.Type<typeof zerostackSessionSchema>
type ZerostackDiscovery = Schema.Schema.Type<typeof zerostackDiscoverySchema>

// zerostack uses the platform data dir (Rust `dirs::data_dir`): macOS maps to
// ~/Library/Application Support, everything else to $XDG_DATA_HOME or
// ~/.local/share, then a `zerostack` subdir. ZS_DATA_DIR overrides the whole
// data dir (sessions live directly under it). Matches src/session/storage.rs.
function defaultSessionsDir(): string {
  const override = process.env['ZS_DATA_DIR']
  if (override) return join(override, 'sessions')
  const base =
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : (process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'))
  return join(base, 'zerostack', 'sessions')
}

function decodeSession(raw: string): ZerostackSession | null {
  if (!raw.trim()) return null
  const decoded = decodeSessionJson(raw)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function decodeDiscoverySession(raw: string): ZerostackDiscovery | null {
  if (!raw.trim()) return null
  const decoded = decodeDiscoverySessionJson(raw)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function firstUserMessage(messages: unknown): string {
  const decodedMessages = decodeUnknownArray(messages)
  if (Result.isFailure(decodedMessages)) return ''

  for (const candidate of decodedMessages.success) {
    const decodedMessage = decodeZerostackMessage(candidate)
    if (Result.isFailure(decodedMessage) || decodedMessage.success.role !== 'user') continue

    const content = decodeUserContent(decodedMessage.success.content)
    if (Result.isFailure(content)) return ''
    if (typeof content.success === 'string') return content.success
    return content.success
      .flatMap(block => {
        const decodedBlock = decodeContentBlock(block)
        if (Result.isFailure(decodedBlock)) return []
        return decodedBlock.success.text ? [decodedBlock.success.text] : []
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const signal = context?.signal
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        const raw = yield* readSessionFileEffect(source.path, 'utf-8', signal ? { signal } : {})
        yield* checkScanAbort(signal)
        if (raw === null) return Stream.empty
        const session = decodeSession(raw)
        if (!session) return Stream.empty

        const input = session.total_input_tokens ?? 0
        const output = session.total_output_tokens ?? 0
        if (input === 0 && output === 0) return Stream.empty

        const timestamp = session.updated_at ?? session.created_at ?? ''
        const sessionId = session.id ?? basename(source.path, '.json')
        const dedupKey = `${source.provider}:${source.path}:${timestamp}:${sessionId}`
        if (seenKeys.has(dedupKey)) return Stream.empty

        const model = session.model ?? ''
        const call: ParsedProviderCall = {
          provider: source.provider,
          model,
          inputTokens: input,
          outputTokens: output,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD: pricing.calculateCost(model, input, output, 0, 0, 0),
          // zerostack persists only final assistant text, not tool-call records,
          // so there is nothing to extract here.
          tools: [],
          bashCommands: [],
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: firstUserMessage(session.messages),
          sessionId,
          project: source.project,
          projectPath: session.working_dir ?? undefined,
        }

        return Stream.fromEffect(
          checkScanAbort(signal).pipe(
            Effect.map(() => {
              if (seenKeys.has(dedupKey)) return Result.fail(undefined)
              seenKeys.add(dedupKey)
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

export function createZerostackProvider(sessionsDir?: string): Provider {
  const dir = sessionsDir ?? defaultSessionsDir()
  const discoverEffect = Effect.fn('discoverZerostackSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkScanAbort(context?.signal)
    const files = yield* readDirectoryOrEmpty(dir, context?.signal)
    const sources: SessionSource[] = []
    for (const file of files) {
      yield* checkScanAbort(context?.signal)
      if (!file.endsWith('.json')) continue
      const path = join(dir, file)
      const raw = yield* readSessionFileEffect(path, 'utf-8', context?.signal ? { signal: context.signal } : {})
      yield* checkScanAbort(context?.signal)
      if (raw === null) continue
      const session = decodeDiscoverySession(raw)
      if (!session) continue
      const workingDir = session.working_dir
      const project = workingDir ? basename(workingDir) : basename(file, '.json')
      sources.push({ path, project, provider: 'zerostack' })
    }
    return sources
  })

  return {
    name: 'zerostack',
    displayName: 'Zerostack',

    modelDisplayName(model: string): string {
      // OpenRouter routes arrive prefixed (e.g. "deepseek/deepseek-v4-pro").
      return getShortModelName(model.replace(/^[^/]+\//, ''))
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

export const zerostack = createZerostackProvider()
