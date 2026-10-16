import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

import { type AppPaths, overrideFor } from '../../env.js'
import { extractBashCommands } from '../bash-utils.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

// Codebuff (formerly Manicode) uses a credit-based billing system. The local
// chat-messages.json doesn't record per-call token counts the way Claude Code
// or Codex do -- only `credits` on completed assistant messages. We convert
// credits to USD using Codebuff's retail pay-as-you-go rate so the cost shows
// up in the dashboard even when tokens are absent. The rate intentionally
// rounds up to the public PAYG tier ($0.01 / credit) so we never understate
// spend; users on a subscription plan get a conservative upper bound.
const USD_PER_CREDIT = 0.01

// Codebuff's chat history lives under `~/.config/manicode/` (the legacy
// product name is still on disk). Development and staging channels use
// `manicode-dev` and `manicode-staging` -- we walk all three when present.
const CHANNELS = ['manicode', 'manicode-dev', 'manicode-staging'] as const
const PROVIDER_NAME = 'codebuff'
const ENV_DIR = 'CODEBUFF_DATA_DIR'

const modelDisplayNames: Record<string, string> = {
  codebuff: 'Codebuff',
  'codebuff-base': 'Codebuff Base',
  'codebuff-base2': 'Codebuff Base 2',
  'codebuff-lite': 'Codebuff Lite',
  'codebuff-max': 'Codebuff Max',
}

// Codebuff's native tool names map to the canonical tool set so
// classifier heuristics (edit/read/bash/etc.) behave consistently with the
// other providers.
const toolNameMap: Record<string, string> = {
  read_files: 'Read',
  read_file: 'Read',
  code_search: 'Grep',
  glob: 'Glob',
  find_files: 'Glob',
  str_replace: 'Edit',
  edit_file: 'Edit',
  write_file: 'Write',
  run_terminal_command: 'Bash',
  terminal: 'Bash',
  spawn_agents: 'Agent',
  spawn_agent: 'Agent',
  write_todos: 'TodoWrite',
  create_plan: 'TodoWrite',
  browser_logs: 'WebFetch',
  web_search: 'WebSearch',
  fetch_url: 'WebFetch',
}

// Tool names we ignore for classification -- they're not useful signals for
// distinguishing "coding" vs "exploration" vs "planning" work.
const IGNORED_TOOLS = new Set(['suggest_followups', 'end_turn'])

const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
const unknownArraySchema = Schema.Array(Schema.Unknown)
const finiteSchema = Schema.Finite
const stringSchema = Schema.String
const messagesJsonSchema = Schema.fromJsonString(unknownArraySchema)
const runStateJsonSchema = Schema.fromJsonString(Schema.Unknown)
const decodeRecord = Schema.decodeUnknownResult(recordSchema)
const decodeArray = Schema.decodeUnknownResult(unknownArraySchema)
const decodeFinite = Schema.decodeUnknownResult(finiteSchema)
const decodeString = Schema.decodeUnknownResult(stringSchema)
const decodeMessagesJson = Schema.decodeUnknownResult(messagesJsonSchema)
const decodeRunStateJson = Schema.decodeUnknownResult(runStateJsonSchema)

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  const decoded = decodeRecord(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function asArray(value: unknown): readonly unknown[] | null {
  const decoded = decodeArray(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function stringValue(value: unknown): string | undefined {
  const decoded = decodeString(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function finiteValue(value: unknown): number | undefined {
  const decoded = decodeFinite(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function field(record: JsonRecord | null, key: string): unknown {
  return record?.[key]
}

function getCodebuffBaseDir(override: string | undefined, paths: AppPaths | undefined): string {
  if (override && override.trim()) return override
  const envPath = overrideFor(paths, ENV_DIR)
  if (envPath && envPath.trim()) return envPath
  return join(homedir(), '.config', 'manicode')
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const decoded = finiteValue(value)
    if (decoded !== undefined) return decoded
  }
  return undefined
}

function normalizeUsage(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const usage = asRecord(value)
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const promptDetails = asRecord(usage['promptTokensDetails'])
  const promptDetailsSnake = asRecord(usage['prompt_tokens_details'])
  return {
    input: pickNumber(usage['inputTokens'], usage['input_tokens'], usage['promptTokens'], usage['prompt_tokens']) ?? 0,
    output:
      pickNumber(
        usage['outputTokens'],
        usage['output_tokens'],
        usage['completionTokens'],
        usage['completion_tokens'],
      ) ?? 0,
    cacheRead:
      pickNumber(
        usage['cacheReadInputTokens'],
        usage['cache_read_input_tokens'],
        promptDetails?.['cachedTokens'],
        promptDetailsSnake?.['cached_tokens'],
      ) ?? 0,
    cacheWrite: pickNumber(usage['cacheCreationInputTokens'], usage['cache_creation_input_tokens']) ?? 0,
  }
}

function coerceTimestamp(value: unknown): string {
  const numeric = finiteValue(value)
  if (numeric !== undefined) return new Date(numeric).toISOString()
  const text = stringValue(value)
  if (text === undefined) return ''
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text
}

function parseChatIdToIso(chatId: string): string {
  const iso = chatId.replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/, '$1:$2:$3')
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

function extractCwd(value: unknown): string | null {
  const metadata = asRecord(value)
  const runState = asRecord(field(metadata, 'runState'))
  const sessionState = asRecord(field(runState, 'sessionState'))
  const projectContext = asRecord(field(sessionState, 'projectContext'))
  const fileContext = asRecord(field(sessionState, 'fileContext'))
  const cwd =
    field(projectContext, 'cwd') ?? field(fileContext, 'cwd') ?? field(sessionState, 'cwd') ?? field(runState, 'cwd')
  return stringValue(cwd) ?? null
}

function extractAgentType(metadata: JsonRecord | null): unknown {
  const runState = asRecord(field(metadata, 'runState'))
  const sessionState = asRecord(field(runState, 'sessionState'))
  const mainAgentState = asRecord(field(sessionState, 'mainAgentState'))
  return field(mainAgentState, 'agentType')
}

function collectBlockTools(value: unknown, acc: { tools: string[]; bash: string[] }): void {
  const blocks = asArray(value)
  if (!blocks) return
  for (const candidate of blocks) {
    const block = asRecord(candidate)
    if (!block) continue
    const type = stringValue(block['type'])
    const raw = stringValue(block['toolName'])
    if (type === 'tool' && raw !== undefined) {
      if (!IGNORED_TOOLS.has(raw)) acc.tools.push(toolNameMap[raw] ?? raw)
      if (raw === 'run_terminal_command' || raw === 'terminal') {
        const input = asRecord(block['input'])
        const command = stringValue(input?.['command'])
        if (command !== undefined) acc.bash.push(...extractBashCommands(command))
      }
    }
    if (type === 'agent') collectBlockTools(block['blocks'], acc)
  }
}

function resolveModel(metadata: JsonRecord | null, stashedModel: unknown): unknown {
  const codebuff = asRecord(field(metadata, 'codebuff'))
  const direct = field(metadata, 'model') ?? field(metadata, 'modelId') ?? field(codebuff, 'model')
  if (direct) return direct
  if (stashedModel) return stashedModel
  const agentType = extractAgentType(metadata)
  if (agentType) return `codebuff-${agentType}`
  return 'codebuff'
}

function usageFromHistory(metadata: JsonRecord | null): {
  model: unknown
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
} {
  const runState = asRecord(field(metadata, 'runState'))
  const sessionState = asRecord(field(runState, 'sessionState'))
  const mainAgentState = asRecord(field(sessionState, 'mainAgentState'))
  const history = asArray(field(mainAgentState, 'messageHistory'))
  if (!history) return { model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  for (let index = history.length - 1; index >= 0; index--) {
    const entry = asRecord(history[index])
    const providerOptions = asRecord(field(entry, 'providerOptions'))
    if (stringValue(field(entry, 'role')) !== 'assistant' || !providerOptions) continue
    const codebuff = asRecord(field(providerOptions, 'codebuff'))
    const usage = normalizeUsage(field(providerOptions, 'usage') ?? field(codebuff, 'usage'))
    if (usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0) {
      return { model: field(codebuff, 'model') ?? null, ...usage }
    }
  }
  return { model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

const readJsonEffect = Effect.fnUntraced(function* (
  filePath: string,
  signal?: AbortSignal,
): Effect.fn.Return<unknown | null, Error> {
  const raw = yield* scanIo(() => readFile(filePath, 'utf-8'), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
  )
  if (raw === null) return null
  const decoded = decodeRunStateJson(raw)
  return Result.isSuccess(decoded) ? decoded.success : null
})

const directoryNamesEffect = Effect.fnUntraced(function* (
  directory: string,
  signal?: AbortSignal,
): Effect.fn.Return<string[], Error> {
  return yield* scanIo(() => readdir(directory), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([]))),
  )
})

const isDirectoryEffect = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<boolean, Error> {
  return yield* scanIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isDirectory()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
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

const discoverChannelEffect = Effect.fnUntraced(function* (
  root: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const sources: SessionSource[] = []
  const projectsDir = join(root, 'projects')
  const projectNames = yield* directoryNamesEffect(projectsDir, signal)

  for (const projectName of projectNames) {
    yield* checkScanAbort(signal)
    const chatsDir = join(projectsDir, projectName, 'chats')
    const chatIds = yield* directoryNamesEffect(chatsDir, signal)

    for (const chatId of chatIds) {
      yield* checkScanAbort(signal)
      const chatDir = join(chatsDir, chatId)
      if (!(yield* isDirectoryEffect(chatDir, signal))) continue

      const messagesPath = join(chatDir, 'chat-messages.json')
      if (!(yield* isFileEffect(messagesPath, signal))) continue

      // Resolve the real cwd from run-state.json so sessions group by the
      // originating project directory instead of the sanitized chat folder
      // name (which is often the same for many users).
      const runState = yield* readJsonEffect(join(chatDir, 'run-state.json'), signal)
      const cwd = extractCwd({ runState })
      const project = cwd ? basename(cwd) : projectName
      sources.push({ path: chatDir, project, provider: PROVIDER_NAME })
    }
  }

  return sources
})

const discoverSessionsInBaseEffect = Effect.fnUntraced(function* (
  baseDir: string,
  singleRoot: boolean,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const results: SessionSource[] = []
  if (singleRoot) {
    if (!(yield* isDirectoryEffect(baseDir, signal))) return results
    return yield* discoverChannelEffect(baseDir, signal)
  }

  const configDir = join(homedir(), '.config')
  for (const channel of CHANNELS) {
    yield* checkScanAbort(signal)
    const root = join(configDir, channel)
    if (!(yield* isDirectoryEffect(root, signal))) continue
    results.push(...(yield* discoverChannelEffect(root, signal)))
  }
  return results
})

// Downstream aggregation groups sessions by `(provider, sessionId, project)`
// (see src/parser.ts). Codebuff chat folders are ISO timestamps, which means
// the same `chatId` can legitimately appear under each channel root
// (`manicode`, `manicode-dev`, `manicode-staging`) and even resolve to the
// same project cwd. To keep those sessions distinct we include the channel
// identity in the sessionId. The channel is derived from the fixed path
// structure Codebuff writes on disk: `<channelRoot>/projects/<project>/chats/<chatId>`.
// Returns null when the path doesn't match that shape so the caller can fall
// back to a plain chatId.
//
// We use '/' as the channel/chatId separator rather than ':' because
// src/parser.ts builds its session key as `${provider}:${sessionId}:${project}`
// and reconstructs the sessionId with `key.split(':')[1]` -- any colon inside
// sessionId would get truncated to just the channel name downstream.
function extractChannelFromChatDir(chatDir: string): string | null {
  const chatsDir = dirname(chatDir)
  if (basename(chatsDir) !== 'chats') return null
  const projectDir = dirname(chatsDir)
  const projectsDir = dirname(projectDir)
  if (basename(projectsDir) !== 'projects') return null
  const channel = basename(dirname(projectsDir))
  return channel ? channel : null
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing: ReturnType<typeof captureScanPricing>,
  context?: ProviderScanContext,
): SessionParser {
  const signal = context?.signal
  const parseEffect = Effect.fn('parseCodebuffSession')(function* (
    onUnparsedCall?: Effect.Effect<void>,
  ): Effect.fn.Return<Stream.Stream<ParsedProviderCall, Error>, Error> {
    yield* checkScanAbort(signal)
    // Keep the legacy uncapped, single source read. In particular, do not stat
    // first or route this through the capped shared whole-file reader.
    const raw = yield* scanIo(() => readFile(join(source.path, 'chat-messages.json'), 'utf-8'), signal).pipe(
      Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(null))),
    )
    if (raw === null) return Stream.empty

    const decodedMessages = decodeMessagesJson(raw)
    if (Result.isFailure(decodedMessages)) return Stream.empty

    const chatDir = source.path
    const chatId = basename(chatDir)
    const channel = extractChannelFromChatDir(chatDir)
    const sessionId = channel ? `${channel}/${chatId}` : chatId
    const fallbackTs = parseChatIdToIso(chatId)
    let pendingUserMessage = ''
    let messageIndex = 0

    return Stream.fromIterable(decodedMessages.success).pipe(
      Stream.mapEffect(candidate =>
        Effect.gen(function* () {
          yield* checkScanAbort(signal)
          const index = messageIndex++
          const msg = asRecord(candidate)
          if (!msg) return Result.fail(undefined)

          const rawVariant = field(msg, 'variant') ?? field(msg, 'role')
          const variant = stringValue(rawVariant)
          if (variant === 'user') {
            const content = stringValue(field(msg, 'content'))
            if (content !== undefined && content.length > 0) pendingUserMessage = content
            return Result.fail(undefined)
          }
          if (variant !== 'ai' && variant !== 'agent' && variant !== 'assistant') return Result.fail(undefined)

          const credits = finiteValue(field(msg, 'credits')) ?? 0
          const metadata = asRecord(field(msg, 'metadata'))
          const codebuffMetadata = asRecord(field(metadata, 'codebuff'))
          const directUsage = normalizeUsage(field(metadata, 'usage') ?? field(codebuffMetadata, 'usage'))
          const stashedUsage = usageFromHistory(metadata)
          const hasDirect =
            directUsage.input > 0 || directUsage.output > 0 || directUsage.cacheRead > 0 || directUsage.cacheWrite > 0
          const usage = hasDirect ? directUsage : stashedUsage
          const stashedModel = stashedUsage.model

          // Skip messages with neither credits nor tokens -- they're typically
          // in-progress mode dividers or empty framing blocks.
          if (
            credits === 0 &&
            usage.input === 0 &&
            usage.output === 0 &&
            usage.cacheRead === 0 &&
            usage.cacheWrite === 0
          ) {
            return Result.fail(undefined)
          }

          const selectedModel = resolveModel(metadata, stashedModel)
          const timestamp = yield* Effect.try({
            try: () => coerceTimestamp(field(msg, 'timestamp') ?? field(metadata, 'timestamp')) || fallbackTs,
            catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
          })
          const dedupId = field(msg, 'id') ?? String(index)
          const dedupKey = `${PROVIDER_NAME}:${chatDir}:${dedupId}`
          if (seenKeys.has(dedupKey)) return Result.fail(undefined)
          seenKeys.add(dedupKey)

          const decodedModel = decodeString(selectedModel)
          if (Result.isFailure(decodedModel)) {
            // The old parser passed truthy malformed model values through to
            // the canonical string schema, which omitted and tallied the row.
            // Keep that verdict here without falling through to a sibling
            // model field or using an unsafe cast. As before, the row is
            // marked seen and consumes its pending prompt before omission.
            // Pricing now receives only valid models; malformed rows are
            // omitted before calling it instead of passing an invalid value.
            pendingUserMessage = ''
            if (onUnparsedCall) yield* onUnparsedCall
            return Result.fail(undefined)
          }
          const model = decodedModel.success

          const acc = { tools: [] as string[], bash: [] as string[] }
          collectBlockTools(field(msg, 'blocks'), acc)

          // Prefer calculated cost from tokens when available (multi-provider
          // models routed through Codebuff still show up in LiteLLM); otherwise
          // fall back to the credit-based approximation.
          let costUSD = yield* Effect.try({
            try: () => pricing.calculateCost(model, usage.input, usage.output, usage.cacheWrite, usage.cacheRead, 0),
            catch: cause => (cause instanceof Error ? cause : new Error(String(cause), { cause })),
          })
          if (costUSD === 0 && credits > 0) costUSD = credits * USD_PER_CREDIT

          const call: ParsedProviderCall = {
            provider: PROVIDER_NAME,
            model,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheCreationInputTokens: usage.cacheWrite,
            cacheReadInputTokens: usage.cacheRead,
            cachedInputTokens: usage.cacheRead,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD,
            tools: acc.tools,
            bashCommands: acc.bash,
            timestamp,
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: pendingUserMessage,
            sessionId,
          }
          pendingUserMessage = ''
          return Result.succeed(call)
        }),
      ),
      Stream.filterMap(call => call),
    )
  })

  return {
    parseStream: onUnparsedCall => Stream.unwrap(parseEffect(onUnparsedCall)),
    // Remove when scan/parser and external iterator callers consume parseStream.
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(Stream.unwrap(parseEffect()))
    },
  }
}

export function createCodebuffProvider(baseDir?: string, paths?: AppPaths): Provider {
  const envOverride = overrideFor(paths, ENV_DIR)
  const dir = getCodebuffBaseDir(baseDir, paths)
  const defaultDir = join(homedir(), '.config', 'manicode')
  // Match the old resolver: raw truthy env overrides force one root even if
  // trimming resolves them back to the default path.
  const singleRoot = Boolean(envOverride) || dir !== defaultDir

  const discoverEffect = Effect.fn('discoverCodebuffSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    return yield* discoverSessionsInBaseEffect(dir, singleRoot, context?.signal)
  })

  return {
    name: PROVIDER_NAME,
    displayName: 'Codebuff',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    discoverSessionsEffect: discoverEffect,
    // Remove this Promise edge after external callers consume native discovery.
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
      const pricing = context?.pricing ?? captureScanPricing()
      return createParser(source, seenKeys, pricing, context)
    },
  }
}

export const codebuff = createCodebuffProvider()
