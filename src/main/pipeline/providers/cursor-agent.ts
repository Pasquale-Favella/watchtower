import { createHash } from 'crypto'
import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { billableOutputTokens } from '../billable-output.js'
import { reportProviderIssue } from '../file-errors.js'
import { readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, scanIo } from '../scan-io.js'
import type { ScanPricing } from '../scan-pricing.js'
import { openDatabase } from '../sqlite.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import type { DateRange } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

type ConversationSummary = {
  model: string | null
  updatedAt: string | null
}

type SummaryRead = {
  summary?: ConversationSummary
  invalidModel: boolean
}

function noSummaryRead(): SummaryRead {
  return { invalidModel: false }
}

type AssistantTurn = {
  body: string
  reasoning: string
  tools: string[]
}

type ParsedTurn = {
  userMessage: string
  assistant: AssistantTurn
}

type TranscriptState = {
  turnIndex: number
  recognized: boolean
  currentUserMessage: string
  pendingUsers: string[]
  active: 'none' | 'user' | 'assistant'
  userLines: string[]
  assistantLines: string[]
}

const CURSOR_AGENT_COST_MODEL = 'claude-sonnet-4-5'
const MAX_USER_TEXT_LENGTH = 500
const DIGITS_ONLY = /^\d+$/
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USER_MARKER = /^\s*user:\s*/i
const ASSISTANT_MARKER = /^\s*A:\s*/
const THINKING_MARKER = /^\s*\[Thinking\]\s*/
const TOOL_CALL_MARKER = /^\s*\[Tool call\]\s*(.+?)\s*$/i
const TOOL_RESULT_MARKER = /^\s*\[Tool result\]\b/i
const USER_QUERY_OPEN = '<user_query>'
const USER_QUERY_CLOSE = '</user_query>'
const warnedUnrecognizedTranscripts = new Set<string>()
const summaryRowSchema = Schema.Struct({
  model: Schema.Unknown,
  updatedAt: Schema.Unknown,
})
const transcriptEntrySchema = Schema.Struct({
  role: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.Unknown),
})
const transcriptMessageSchema = Schema.Struct({ content: Schema.optional(Schema.Unknown) })
const contentBlockSchema = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.Unknown),
  name: Schema.optional(Schema.Unknown),
})
const decodeSummaryRow = Schema.decodeUnknownResult(summaryRowSchema)
const decodeTranscriptEntry = Schema.decodeUnknownResult(transcriptEntrySchema)
const decodeTranscriptMessage = Schema.decodeUnknownResult(transcriptMessageSchema)
const decodeContentBlock = Schema.decodeUnknownResult(contentBlockSchema)
const decodeJsonlEntry = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeTranscriptContent = Schema.decodeUnknownResult(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]))
const decodeString = Schema.decodeUnknownResult(Schema.String)
const decodeOptionalSummaryField = Schema.decodeUnknownResult(Schema.NullOr(Schema.String))
const decodeSummaryTimestamp = Schema.decodeUnknownResult(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite])))

class CursorAgentDatabaseError extends Schema.TaggedError<CursorAgentDatabaseError>()('CursorAgentDatabaseError', {
  operation: Schema.Literals(['open', 'read', 'close']),
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

const CONVERSATION_SUMMARY_QUERY = `
  SELECT model, updatedAt
  FROM conversation_summaries
  WHERE conversationId = ?
`

const modelDisplayNames: Record<string, string> = {
  'claude-4.5-opus-high-thinking': 'Opus 4.5 (Thinking)',
  'claude-4-opus': 'Opus 4',
  'claude-4-sonnet-thinking': 'Sonnet 4 (Thinking)',
  'claude-4.5-sonnet-thinking': 'Sonnet 4.5 (Thinking)',
  'claude-4.6-sonnet': 'Sonnet 4.6',
  'composer-1': 'Composer 1',
  'grok-code-fast-1': 'Grok Code Fast',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gpt-5.1-codex-high': 'GPT-5.1 Codex',
  'gpt-5': 'GPT-5',
  'gpt-4.1': 'GPT-4.1',
  default: 'Auto (Sonnet est.)',
}

function getCursorAgentBaseDir(baseDirOverride?: string): string {
  if (baseDirOverride) return baseDirOverride
  // Windows paths unverified; tracked as Open Question 3 in issue #55.
  return join(homedir(), '.cursor')
}

function getProjectsDir(baseDir: string): string {
  return join(baseDir, 'projects')
}

function getAttributionDbPath(baseDir: string): string {
  return join(baseDir, 'ai-tracking', 'ai-code-tracking.db')
}

function estimateTokens(charCount: number): number {
  if (charCount <= 0) return 0
  return estimateTokensFromChars(charCount)
}

function parseToolName(raw: string): string {
  const clean = raw.trim()
  if (clean.length === 0) return 'unknown'
  return clean.toLowerCase().replace(/\s+/g, '-')
}

function normalizeTimestamp(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    if (DIGITS_ONLY.test(trimmed)) {
      const num = Number(trimmed)
      if (!Number.isNaN(num)) {
        const ms = num < 1e12 ? num * 1000 : num
        return new Date(ms).toISOString()
      }
    }
    const parsed = new Date(trimmed)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
    return null
  }

  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function prettifyProjectId(raw: string): string {
  if (!raw) return raw

  if (DIGITS_ONLY.test(raw)) {
    const num = Number(raw)
    if (!Number.isNaN(num) && raw.length >= 13) {
      const iso = new Date(num).toISOString()
      return `cursor-agent:${iso}`
    }
  }

  const withoutPrefix = raw.replace(/^-Users-/, '')
  const parts = withoutPrefix.split('-').filter(Boolean)
  const lastPart = parts.at(-1)
  if (lastPart) return lastPart

  return raw
}

function resolveModel(raw: string | null | undefined): string {
  if (!raw || raw === 'default') return 'cursor-agent-auto'
  return raw
}

function costModel(model: string): string {
  return model === 'cursor-agent-auto' ? CURSOR_AGENT_COST_MODEL : model
}

function transcriptStem(transcriptPath: string): string {
  const name = basename(transcriptPath)
  if (name.endsWith('.jsonl')) return name.slice(0, -'.jsonl'.length)
  if (name.endsWith('.txt')) return name.slice(0, -'.txt'.length)
  return name
}

function toConversationId(transcriptPath: string): string {
  const filename = transcriptStem(transcriptPath)
  if (filename.length === 36 && UUID_LIKE.test(filename)) return filename
  return createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16)
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

function databaseError(operation: CursorAgentDatabaseError['operation'], cause: unknown): CursorAgentDatabaseError {
  const error = toError(cause)
  return new CursorAgentDatabaseError({ operation, cause: error, message: error.message })
}

function isScanAborted(error: Error): boolean {
  return isScanAbortedError(error)
}

const listDirectory = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>, Error> {
  return yield* scanIo(() => readdir(path, { withFileTypes: true }), signal).pipe(
    Effect.catch(error => (isScanAborted(error) ? Effect.fail(error) : Effect.succeed([]))),
  )
})

const appendTranscriptSources = Effect.fnUntraced(function* (
  scanDir: string,
  projectId: string,
  sources: SessionSource[],
  signal?: AbortSignal,
): Effect.fn.Return<void, Error> {
  const transcriptEntries = yield* listDirectory(scanDir, signal)
  for (const transcript of transcriptEntries) {
    yield* checkScanAbort(signal)
    if (transcript.isFile() && transcript.name.endsWith('.txt')) {
      sources.push({ path: join(scanDir, transcript.name), project: projectId, provider: 'cursor-agent' })
      continue
    }

    if (!transcript.isDirectory() || !UUID_LIKE.test(transcript.name)) continue
    const subdir = join(scanDir, transcript.name)
    const subEntries = yield* listDirectory(subdir, signal)
    const transcriptFilesByStem = new Map<string, { jsonl?: string; txt?: string }>()

    for (const sub of subEntries) {
      yield* checkScanAbort(signal)
      if (sub.isFile() && (sub.name.endsWith('.jsonl') || sub.name.endsWith('.txt'))) {
        const stem = transcriptStem(sub.name)
        const existing = transcriptFilesByStem.get(stem) ?? {}
        if (sub.name.endsWith('.jsonl')) transcriptFilesByStem.set(stem, { ...existing, jsonl: sub.name })
        else transcriptFilesByStem.set(stem, { ...existing, txt: sub.name })
        continue
      }

      if (!sub.isDirectory() || sub.name !== 'subagents') continue
      const subagentDir = join(subdir, sub.name)
      const subagentEntries = yield* listDirectory(subagentDir, signal)
      for (const subagent of subagentEntries) {
        yield* checkScanAbort(signal)
        if (!subagent.isFile() || (!subagent.name.endsWith('.jsonl') && !subagent.name.endsWith('.txt'))) continue
        sources.push({ path: join(subagentDir, subagent.name), project: projectId, provider: 'cursor-agent' })
      }
    }

    for (const files of transcriptFilesByStem.values()) {
      const selectedName = files.jsonl ?? files.txt
      if (selectedName) {
        sources.push({ path: join(subdir, selectedName), project: projectId, provider: 'cursor-agent' })
      }
    }
  }
})

function extractUserQuery(userBlock: string): string {
  const chunks: string[] = []
  let cursor = 0

  while (cursor < userBlock.length) {
    const openIndex = userBlock.indexOf(USER_QUERY_OPEN, cursor)
    if (openIndex === -1) break
    const start = openIndex + USER_QUERY_OPEN.length
    const closeIndex = userBlock.indexOf(USER_QUERY_CLOSE, start)
    if (closeIndex === -1) {
      chunks.push(userBlock.slice(start).trim())
      break
    }
    chunks.push(userBlock.slice(start, closeIndex).trim())
    cursor = closeIndex + USER_QUERY_CLOSE.length
  }

  const combined = chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  return combined.slice(0, MAX_USER_TEXT_LENGTH)
}

function finishAssistant(state: TranscriptState): ParsedTurn | undefined {
  if (state.assistantLines.length === 0) return undefined
  let output = ''
  let reasoning = ''
  const toolsByTurn = new Map<string, true>()

  for (const line of state.assistantLines) {
    if (TOOL_RESULT_MARKER.test(line)) continue
    const thinkingMatch = line.match(THINKING_MARKER)
    if (thinkingMatch) {
      const body = line.replace(THINKING_MARKER, '').trim()
      if (body.length > 0) reasoning += `${body}\n`
      continue
    }
    const toolMatch = line.match(TOOL_CALL_MARKER)
    if (toolMatch) {
      toolsByTurn.set(`cursor:${parseToolName(toolMatch[1] ?? '')}`, true)
      continue
    }
    output += `${line}\n`
  }

  state.assistantLines = []
  const userMessage = state.pendingUsers.shift()
  if (userMessage === undefined) return undefined
  return {
    userMessage,
    assistant: { body: output.trim(), reasoning: reasoning.trim(), tools: [...toolsByTurn.keys()] },
  }
}

function transcriptContentBlocks(value: unknown): readonly unknown[] {
  const decoded = decodeTranscriptContent(value)
  if (Result.isFailure(decoded)) return []
  if (typeof decoded.success === 'string') return [{ type: 'text', text: decoded.success }]
  return decoded.success.filter(Predicate.isObject)
}

const jsonlTurn = Effect.fnUntraced(function* (
  line: string,
  state: TranscriptState,
  onUnparsedCall: Effect.Effect<void>,
): Effect.fn.Return<ParsedTurn | undefined> {
  if (!line.trim()) return undefined
  const parsedJson = decodeJsonlEntry(line)
  if (Result.isFailure(parsedJson)) return undefined
  const decodedEntry = decodeTranscriptEntry(parsedJson.success)
  if (Result.isFailure(decodedEntry)) return undefined

  const role = decodedEntry.success.role
  if (role === undefined) return undefined
  const decodedRole = decodeString(role)
  if (Result.isFailure(decodedRole)) {
    yield* onUnparsedCall
    return undefined
  }

  const messageValue = decodedEntry.success.message
  let contentValue: unknown
  if (messageValue !== undefined && messageValue !== null) {
    const decodedMessage = decodeTranscriptMessage(messageValue)
    if (Result.isFailure(decodedMessage)) {
      yield* onUnparsedCall
      return undefined
    }
    contentValue = decodedMessage.success.content
  }

  if (decodedRole.success === 'user') {
    const texts: string[] = []
    for (const block of transcriptContentBlocks(contentValue)) {
      const decodedBlock = decodeContentBlock(block)
      if (Result.isFailure(decodedBlock)) {
        yield* onUnparsedCall
        continue
      }
      const type = decodedBlock.success.type
      if (type === undefined) continue
      const decodedType = decodeString(type)
      if (Result.isFailure(decodedType)) {
        yield* onUnparsedCall
        continue
      }
      if (decodedType.success !== 'text') continue
      const text = decodedBlock.success.text
      if (text === undefined) continue
      const decodedText = decodeString(text)
      if (Result.isFailure(decodedText)) {
        yield* onUnparsedCall
        continue
      }
      texts.push(decodedText.success)
    }
    const combined = texts.join(' ')
    state.currentUserMessage = extractUserQuery(combined) || combined.slice(0, MAX_USER_TEXT_LENGTH)
    return undefined
  }

  if (decodedRole.success !== 'assistant' || !state.currentUserMessage) return undefined
  const bodyParts: string[] = []
  const tools: string[] = []
  for (const block of transcriptContentBlocks(contentValue)) {
    const decodedBlock = decodeContentBlock(block)
    if (Result.isFailure(decodedBlock)) {
      yield* onUnparsedCall
      continue
    }
    const typeValue = decodedBlock.success.type
    if (typeValue === undefined) continue
    const type = decodeString(typeValue)
    if (Result.isFailure(type)) {
      yield* onUnparsedCall
      continue
    }
    if (type.success === 'text' && decodedBlock.success.text !== undefined) {
      const text = decodeString(decodedBlock.success.text)
      if (Result.isFailure(text)) yield* onUnparsedCall
      else if (text.success) bodyParts.push(text.success)
    }
    if (type.success === 'tool_use' && decodedBlock.success.name !== undefined) {
      const name = decodeString(decodedBlock.success.name)
      if (Result.isFailure(name)) yield* onUnparsedCall
      else if (name.success) tools.push(`cursor:${name.success.toLowerCase()}`)
    }
  }

  const turn = {
    userMessage: state.currentUserMessage,
    assistant: { body: bodyParts.join('\n').trim(), reasoning: '', tools },
  }
  state.currentUserMessage = ''
  return turn
})

function textTurn(line: string, state: TranscriptState): ParsedTurn | undefined {
  if (USER_MARKER.test(line)) {
    state.recognized = true
    if (state.active === 'user') {
      const userQuery = extractUserQuery(state.userLines.join('\n'))
      if (userQuery) state.pendingUsers.push(userQuery)
    } else if (state.active === 'assistant') {
      const turn = finishAssistant(state)
      state.active = 'user'
      state.userLines = [line.replace(USER_MARKER, '')]
      return turn
    }
    state.active = 'user'
    state.userLines = [line.replace(USER_MARKER, '')]
    return undefined
  }

  if (ASSISTANT_MARKER.test(line)) {
    state.recognized = true
    if (state.active === 'user') {
      const userQuery = extractUserQuery(state.userLines.join('\n'))
      if (userQuery) state.pendingUsers.push(userQuery)
    }
    const completed = state.active === 'assistant' ? finishAssistant(state) : undefined
    state.active = 'assistant'
    state.assistantLines = [line.replace(ASSISTANT_MARKER, '')]
    return completed
  }

  if (state.active === 'user') state.userLines.push(line)
  if (state.active === 'assistant') state.assistantLines.push(line)
  return undefined
}

function flushText(state: TranscriptState): ParsedTurn | undefined {
  if (state.active === 'user') {
    const userQuery = extractUserQuery(state.userLines.join('\n'))
    if (userQuery) state.pendingUsers.push(userQuery)
    state.userLines = []
    return undefined
  }
  if (state.active === 'assistant') return finishAssistant(state)
  return undefined
}

const readSummary = Effect.fnUntraced(
  function* (
    dbPath: string,
    conversationId: string,
    summariesByConversationId: Map<string, ConversationSummary>,
    signal?: AbortSignal,
    onUnparsedCall: Effect.Effect<void> = Effect.void,
  ): Effect.fn.Return<SummaryRead, Error> {
    const cached = summariesByConversationId.get(conversationId)
    if (cached) return { summary: cached, invalidModel: false }

    yield* checkScanAbort(signal)
    const result = yield* Effect.result(
      Effect.acquireUseRelease(
        Effect.try({ try: () => openDatabase(dbPath), catch: cause => databaseError('open', cause) }),
        db =>
          Effect.try({
            try: () => db.query(CONVERSATION_SUMMARY_QUERY, [conversationId]),
            catch: cause => databaseError('read', cause),
          }).pipe(Effect.catchTag('CursorAgentDatabaseError', () => Effect.succeed([]))),
        db => Effect.try({ try: () => db.close(), catch: cause => databaseError('close', cause) }),
      ),
    )
    yield* checkScanAbort(signal)
    if (Result.isFailure(result)) {
      if (result.failure instanceof CursorAgentDatabaseError && result.failure.operation === 'close') {
        return yield* Effect.fail(result.failure)
      }
      return { invalidModel: false }
    }
    if (result.success.length === 0) return { invalidModel: false }

    const row = decodeSummaryRow(result.success[0])
    if (Result.isFailure(row)) {
      yield* onUnparsedCall
      return { invalidModel: false }
    }
    const raw = row.success
    const model = decodeOptionalSummaryField(raw.model)
    if (Result.isFailure(model)) {
      yield* onUnparsedCall
      return { invalidModel: true }
    }
    const updatedAt = decodeSummaryTimestamp(raw.updatedAt)
    if (Result.isFailure(updatedAt)) {
      yield* onUnparsedCall
      return { invalidModel: false }
    }
    const summary: ConversationSummary = {
      model: model.success,
      updatedAt: normalizeTimestamp(updatedAt.success),
    }
    summariesByConversationId.set(conversationId, summary)
    return { summary, invalidModel: false }
  },
  Effect.catch(error =>
    isScanAborted(error) || (error instanceof CursorAgentDatabaseError && error.operation === 'close')
      ? Effect.fail(error)
      : Effect.succeed(noSummaryRead()),
  ),
)

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dbPath: string,
  summariesByConversationId: Map<string, ConversationSummary>,
  pricing: ScanPricing,
  context?: ProviderScanContext,
): SessionParser {
  const signal = context?.signal
  const emptyCalls: Stream.Stream<ParsedProviderCall, Error> = Stream.empty
  const parseStream: NonNullable<SessionParser['parseStream']> = (onUnparsedCall = Effect.void) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* checkScanAbort(signal)
        const conversationId = toConversationId(source.path)
        const summaryRead = yield* readSummary(
          dbPath,
          conversationId,
          summariesByConversationId,
          signal,
          onUnparsedCall,
        )
        if (summaryRead.invalidModel) return emptyCalls
        const summary = summaryRead.summary
        let timestamp = summary?.updatedAt ?? null
        const readTimestamp = Effect.fnUntraced(function* (): Effect.fn.Return<string, Error> {
          if (!timestamp) {
            const fileStat = yield* scanIo(() => stat(source.path), signal)
            timestamp = fileStat.mtime.toISOString()
          }
          return timestamp
        })
        const rawModel = summary?.model
        const model = resolveModel(rawModel)
        const state: TranscriptState = {
          turnIndex: 0,
          recognized: false,
          currentUserMessage: '',
          pendingUsers: [],
          active: 'none',
          userLines: [],
          assistantLines: [],
        }
        const jsonl = source.path.endsWith('.jsonl')
        const lines = readSessionLinesStream(source.path, undefined, {
          maxBytes: Number.POSITIVE_INFINITY,
          preserveEmptyLines: !jsonl,
          ...(signal ? { signal } : {}),
        })
        const perLine = lines.pipe(
          Stream.mapEffect((line: string | Buffer) => {
            const text = (typeof line === 'string' ? line : line.toString('utf-8')).replace(/\r$/, '')
            if (jsonl) return jsonlTurn(text, state, onUnparsedCall)
            return Effect.succeed(textTurn(text, state))
          }),
          Stream.filterMapEffect(turn =>
            turn
              ? readTimestamp().pipe(
                  Effect.flatMap(timestamp =>
                    makeCall(turn, state, conversationId, model, timestamp, seenKeys, pricing),
                  ),
                  Effect.map(call => (call ? Result.succeed(call) : Result.fail(undefined))),
                )
              : Effect.succeed(Result.fail(undefined)),
          ),
        )
        const finish = Stream.fromEffectDrain(
          Effect.gen(function* () {
            if (state.recognized && state.turnIndex === 0) yield* readTimestamp()
            if (state.recognized || state.turnIndex > 0) return
            if (!warnedUnrecognizedTranscripts.has(source.path)) {
              warnedUnrecognizedTranscripts.add(source.path)
              reportProviderIssue('cursor-agent', 'format-unrecognized', source.path)
            }
          }),
        )
        const finalTextTurn = jsonl
          ? Stream.empty
          : Stream.unwrap(
              Effect.sync(() => flushText(state)).pipe(
                Effect.map(turn =>
                  turn
                    ? Stream.fromEffect(
                        readTimestamp().pipe(
                          Effect.flatMap(timestamp =>
                            makeCall(turn, state, conversationId, model, timestamp, seenKeys, pricing),
                          ),
                          Effect.map(call => (call ? Result.succeed(call) : Result.fail(undefined))),
                        ),
                      ).pipe(Stream.filterMap(call => call))
                    : Stream.empty,
                ),
              ),
            )
        return Stream.concat(perLine, Stream.concat(finalTextTurn, finish))
      }),
    )

  return {
    parseStream,
    // Remove this async-iterator adapter when direct callers use parseStream.
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

function makeCall(
  turn: ParsedTurn,
  state: TranscriptState,
  conversationId: string,
  model: string,
  timestamp: string,
  seenKeys: Set<string>,
  pricing: ScanPricing,
): Effect.Effect<ParsedProviderCall | undefined, Error> {
  const turnIndex = state.turnIndex++
  const inputTokens = estimateTokens(turn.userMessage.length)
  const outputTokens = estimateTokens(turn.assistant.body.length)
  const reasoningTokens = estimateTokens(turn.assistant.reasoning.length)
  const deduplicationKey = `cursor-agent:${conversationId}:${turnIndex}`
  if (seenKeys.has(deduplicationKey)) return Effect.succeed(undefined)
  seenKeys.add(deduplicationKey)

  return Effect.try({
    try: () => {
      const costUSD = pricing.calculateCost(
        costModel(model),
        inputTokens,
        billableOutputTokens('cursor-agent', outputTokens, reasoningTokens),
        0,
        0,
        0,
      )
      return {
        provider: 'cursor-agent',
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens,
        webSearchRequests: 0,
        costUSD,
        tools: turn.assistant.tools,
        bashCommands: [],
        timestamp,
        speed: 'standard',
        deduplicationKey,
        userMessage: turn.userMessage,
        sessionId: conversationId,
      } satisfies ParsedProviderCall
    },
    catch: toError,
  })
}

export function createCursorAgentProvider(baseDirOverride?: string): Provider {
  const baseDir = getCursorAgentBaseDir(baseDirOverride)
  const projectsDir = getProjectsDir(baseDir)
  const dbPath = getAttributionDbPath(baseDir)
  const summariesByConversationId = new Map<string, ConversationSummary>()
  const discoverSessionsEffect = Effect.fn('discoverCursorAgentSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    const signal = context?.signal
    yield* checkScanAbort(signal)
    const entries = yield* listDirectory(projectsDir, signal)
    const sources: SessionSource[] = []

    for (const entry of entries) {
      yield* checkScanAbort(signal)
      if (!entry.isDirectory()) continue
      const projectId = prettifyProjectId(entry.name)
      const projectDir = join(projectsDir, entry.name)
      if (entry.name === 'agent-transcripts') {
        yield* appendTranscriptSources(projectDir, projectId, sources, signal)
        continue
      }
      yield* appendTranscriptSources(join(projectDir, 'agent-transcripts'), projectId, sources, signal)
    }
    return sources
  })

  return {
    name: 'cursor-agent',
    displayName: 'Cursor Agent',

    modelDisplayName(model: string): string {
      if (model === 'cursor-agent-auto') return 'Cursor (auto)'
      const label = modelDisplayNames[model] ?? model
      return `${label} (est.)`
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    discoverSessionsEffect,
    // Remove this Promise edge when external callers use native discovery.
    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // eslint-disable-next-line no-restricted-syntax
      return Effect.runPromise(discoverSessionsEffect(context))
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      return createParser(
        source,
        seenKeys,
        dbPath,
        summariesByConversationId,
        context?.pricing ?? captureScanPricing(),
        context,
      )
    },
  }
}

export const cursor_agent = createCursorAgentProvider()
