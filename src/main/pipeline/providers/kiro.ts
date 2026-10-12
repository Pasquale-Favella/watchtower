import { Effect, Result, Schema, Stream } from 'effect'
import type { Dirent } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, extname, join } from 'path'

import { billableOutputTokens } from '../billable-output.js'
import { MAX_SESSION_FILE_BYTES, readSessionFileEffect, readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError } from '../scan-control.js'
import { checkScanAbort, readDirectoryOrEmpty, scanIo } from '../scan-io.js'
import type { ScanPricing } from '../scan-pricing.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import type { DateRange } from '../types.js'
import type { ToolCall } from '../types.js'
import type { ParsedProviderCall, Provider, ProviderScanContext, SessionParser, SessionSource } from './types.js'

// Kiro bills in credits: individual plans are $20/mo for 1,000 credits and
// overage is billed at $0.04 per additional credit. We price credits at the
// public overage rate (the marginal price), mirroring the Codebuff provider's
// USD_PER_CREDIT approach, so we never understate real cost.
const USD_PER_KIRO_CREDIT = 0.04
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000
const MODERN_CONVERSATION_KEYS = ['messages', 'conversation', 'chat', 'transcript', 'entries', 'events']
const kiroRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeKiroRecord = Schema.decodeUnknownResult(kiroRecordSchema)
const decodeKiroJson = Schema.decodeUnknownResult(Schema.fromJsonString(kiroRecordSchema))
const decodeKiroString = Schema.decodeUnknownResult(Schema.String)
const decodeKiroNumber = Schema.decodeUnknownResult(Schema.Number)
const decodeKiroTime = Schema.decodeUnknownResult(Schema.Union([Schema.Number, Schema.String]))
const decodeOptionalModel = Schema.decodeUnknownResult(Schema.NullOr(Schema.String))
const decodeKiroFinite = Schema.decodeUnknownResult(Schema.Finite)

const modelDisplayNames: Record<string, string> = {
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-3-5-haiku': 'Haiku 3.5',
}

const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

const toolNameMap: Record<string, string> = {
  readFile: 'Read',
  read_file: 'Read',
  read: 'Read',
  writeFile: 'Edit',
  write_file: 'Edit',
  write: 'Edit',
  editFile: 'Edit',
  edit_file: 'Edit',
  createFile: 'Write',
  create_file: 'Write',
  deleteFile: 'Delete',
  listDir: 'LS',
  list_dir: 'LS',
  openFolders: 'LS',
  runCommand: 'Bash',
  run_command: 'Bash',
  shell: 'Bash',
  executeBash: 'Bash',
  searchFiles: 'Grep',
  search_files: 'Grep',
  grep: 'Grep',
  grepSearch: 'Grep',
  findFiles: 'Glob',
  find_files: 'Glob',
  glob: 'Glob',
  fileSearch: 'Glob',
  webSearch: 'WebSearch',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  fsWrite: 'Edit',
  strReplace: 'Edit',
  listDirectory: 'LS',
  code: 'Read',
  subagent: 'Agent',
}

type KiroModernExecution = Record<string, unknown>

type KiroCost =
  | {
      readonly _tag: 'calculated'
      readonly model: string
      readonly inputTokens: number
      readonly outputTokens: number
    }
  | { readonly _tag: 'recorded'; readonly amount: number }

type KiroCandidate =
  | { readonly _tag: 'unparsed'; readonly deduplicationKey?: string; readonly seenBeforePricing?: boolean }
  | {
      readonly _tag: 'call'
      readonly fields: Omit<ParsedProviderCall, 'costUSD'>
      readonly cost: KiroCost
      readonly seenBeforePricing: boolean
    }

function unparsedCandidate(deduplicationKey?: string, seenBeforePricing = false): KiroCandidate {
  return { _tag: 'unparsed', deduplicationKey, seenBeforePricing }
}

function callCandidate(
  fields: Omit<ParsedProviderCall, 'costUSD'>,
  cost: KiroCost,
  seenBeforePricing = false,
): KiroCandidate {
  return { _tag: 'call', fields, cost, seenBeforePricing }
}

function addLegacyCreditValue(sum: number | string, value: unknown): number | string {
  if (typeof sum === 'string') return `${sum}${String(value)}`
  if (typeof value === 'number') return sum + value
  if (value === null || value === false) return sum
  if (value === true) return sum + 1
  return `${sum}${String(value)}`
}

function normalizeModelId(raw: string): string {
  return raw.replace(/(\d+)\.(\d+)/g, '$1-$2')
}

function extractToolNames(content: string): string[] {
  const tools: string[] = []
  const regex = /<tool_use>\s*<name>([^<]+)<\/name>/g
  let match
  while ((match = regex.exec(content)) !== null) {
    const name = match[1]?.trim()
    if (!name) continue
    tools.push(toolNameMap[name] ?? name)
  }
  return tools
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const decoded = decodeKiroRecord(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function stringField(record: Record<string, unknown> | null, names: string[]): string {
  if (!record) return ''
  for (const name of names) {
    const decoded = decodeKiroString(record[name])
    if (Result.isSuccess(decoded) && decoded.success.trim()) return decoded.success.trim()
  }
  return ''
}

function rawStringField(record: Record<string, unknown> | null, name: string): string | undefined {
  if (!record) return undefined
  const decoded = decodeKiroString(record[name])
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function timeField(record: Record<string, unknown> | null, names: string[]): number | string | undefined {
  if (!record) return undefined
  for (const name of names) {
    const decoded = decodeKiroTime(record[name])
    if (Result.isSuccess(decoded)) return decoded.success
  }
  return undefined
}

function parseKiroTimestamp(value: number | string | undefined): Date | null {
  if (value === undefined) return null

  let parsed: number | string = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    parsed = /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed
  }

  if (typeof parsed === 'number') {
    if (!Number.isFinite(parsed)) return null
    const ms = parsed < MIN_REASONABLE_TIMESTAMP_MS ? parsed * 1000 : parsed
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) || date.getTime() < MIN_REASONABLE_TIMESTAMP_MS ? null : date
  }

  const date = new Date(parsed)
  return Number.isNaN(date.getTime()) || date.getTime() < MIN_REASONABLE_TIMESTAMP_MS ? null : date
}

function textField(record: Record<string, unknown> | null, names: string[]): string {
  if (!record) return ''
  for (const name of names) {
    const text = extractText(record[name])
    if (text) return text
  }
  return ''
}

function extractText(value: unknown): string {
  const decodedText = decodeKiroString(value)
  if (Result.isSuccess(decodedText)) return decodedText.success
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  const record = asRecord(value)
  if (!record) return ''
  for (const key of ['content', 'text', 'message', 'value', 'parts', 'entries']) {
    const text = extractText(record[key])
    if (text) return text
  }
  return ''
}

function messageRole(value: unknown): string {
  const record = asRecord(value)
  if (!record) return ''
  return stringField(record, ['role', 'type', 'author']).toLowerCase()
}

function extractStructuredToolNames(
  value: unknown,
  text: string,
  options: { includeDirectName?: boolean } = {},
): string[] {
  const tools = extractToolNames(text)
  const record = asRecord(value)
  if (!record) return tools

  if (options.includeDirectName ?? true) {
    const directName = stringField(record, ['toolName', 'name'])
    if (directName) tools.push(toolNameMap[directName] ?? directName)
  }

  for (const key of ['toolCalls', 'tool_calls', 'tools']) {
    const entries = record[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const name = stringField(asRecord(entry), ['name', 'toolName', 'tool_name'])
      if (name) tools.push(toolNameMap[name] ?? name)
    }
  }

  return tools
}

function parseChatFile(data: Record<string, unknown>, sessionId: string): KiroCandidate[] {
  const results: KiroCandidate[] = []
  const chat = data['chat']
  const metadata = asRecord(data['metadata'])
  if (!Array.isArray(chat) || !metadata) return results

  let modelId = normalizeModelId(stringField(metadata, ['modelId']))
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  let pendingUserMessage = ''
  const allTools: string[] = []
  const toolSequence: ToolCall[][] = []

  let totalOutputChars = 0
  for (const value of chat) {
    const msg = asRecord(value)
    if (!msg) continue
    const role = rawStringField(msg, 'role')
    const content = rawStringField(msg, 'content')
    if (role === 'human' && content !== undefined) {
      if (content.startsWith('<identity>')) continue
      pendingUserMessage = content.slice(0, 500)
    }
    if (role === 'bot' && content !== undefined) {
      const msgTools = extractToolNames(content)
      allTools.push(...msgTools)
      if (msgTools.length > 0) toolSequence.push(msgTools.map(t => ({ tool: t })))
      totalOutputChars += content.length
    }
  }

  if (totalOutputChars === 0) return results

  const dedupKey = `kiro:${sessionId}:${rawStringField(data, 'executionId') ?? ''}`
  const timestamp = parseKiroTimestamp(timeField(metadata, ['startTime']))
  if (!timestamp) return results

  const outputTokens = estimateTokensFromChars(totalOutputChars)
  const inputTokens = estimateTokensFromChars(pendingUserMessage.length)

  results.push(
    callCandidate(
      {
        provider: 'kiro',
        model: modelId,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costIsEstimated: true,
        tools: [...new Set(allTools)],
        bashCommands: [],
        toolSequence: toolSequence.length > 1 ? toolSequence : undefined,
        timestamp: timestamp.toISOString(),
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: pendingUserMessage,
        sessionId,
      },
      { _tag: 'calculated', model: modelId, inputTokens, outputTokens },
    ),
  )

  return results
}

function parseModernExecution(data: KiroModernExecution, sourcePath: string): KiroCandidate[] {
  const results: KiroCandidate[] = []
  if (Array.isArray(data['executions'])) return results

  const metadata = asRecord(data['metadata'])
  const modelObj = asRecord(data['model'])
  let modelId = normalizeModelId(
    stringField(data, ['modelId', 'modelID', 'modelName', 'model']) ||
      stringField(modelObj, ['id', 'name']) ||
      stringField(metadata, ['modelId', 'modelID', 'modelName']),
  )
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  const executionId = stringField(data, ['executionId', 'id']) || basename(sourcePath)
  const sessionId =
    stringField(data, ['sessionId', 'chatSessionId', 'conversationId', 'workflowId']) ||
    stringField(metadata, ['workflowId', 'sessionId']) ||
    basename(dirname(sourcePath)) ||
    executionId

  let inputChars = 0
  let outputChars = 0
  let pendingUserMessage = ''
  const allTools: string[] = []
  let hasOutputActivity = false
  const directInput = textField(data, ['prompt', 'input', 'userMessage', 'user_message', 'request'])
  const directOutput = textField(data, ['response', 'output', 'assistantMessage', 'assistant_message', 'result'])
  const directTools = extractStructuredToolNames(data, directOutput, { includeDirectName: false })

  if (directInput) {
    inputChars += directInput.length
    pendingUserMessage = directInput.slice(0, 500)
  }

  if (directOutput) {
    outputChars += directOutput.length
    hasOutputActivity = true
  }

  if (directTools.length > 0) {
    hasOutputActivity = true
    allTools.push(...directTools)
  }

  // Check both data.context[key] and data[key] for conversation arrays.
  // Kiro IDE stores messages at data.context.messages in current builds.
  const context = asRecord(data['context'])
  const conversationSources = context ? [context, data] : [data]

  for (const source of conversationSources) {
    let found = false
    for (const key of MODERN_CONVERSATION_KEYS) {
      const messages = source[key]
      if (!Array.isArray(messages)) continue

      for (const message of messages) {
        const text = extractText(message)
        const role = messageRole(message)
        const tools = extractStructuredToolNames(message, text)

        if (role === 'human' || role === 'user') {
          if (!text) continue
          inputChars += text.length
          pendingUserMessage = text.slice(0, 500)
        } else if (role === 'bot' || role === 'assistant' || role === 'ai' || role === 'model') {
          if (text) outputChars += text.length
          if (text || tools.length > 0) hasOutputActivity = true
          allTools.push(...tools)
        } else if (role === 'tool' || role === 'system') {
          if (text) inputChars += text.length
          allTools.push(...tools)
        }
      }
      found = true
      break
    }
    if (found) break
  }

  // Extract tools and metered credits from usageSummary (reliable structured
  // data in current Kiro builds). usageSummary is an array of per-turn entries
  // with optional usedTools and usage (credits, unit "credit") fields — the
  // v1 predecessor of v2's usage_summary.promptTurnSummaries.
  let executionCredits = 0
  const usageSummary = data['usageSummary']
  if (Array.isArray(usageSummary)) {
    for (const entry of usageSummary) {
      const rec = asRecord(entry)
      if (!rec) continue
      const usage = rec['usage']
      if (typeof usage === 'number' && Number.isFinite(usage)) executionCredits += usage
      const usedTools = rec['usedTools']
      if (Array.isArray(usedTools)) {
        for (const tool of usedTools) {
          if (typeof tool === 'string' && tool) {
            // Strip mcp_ prefix for cleaner display (e.g. mcp_aws_sentral_mcp_search_accounts -> aws_sentral_mcp_search_accounts)
            const cleaned = tool.startsWith('mcp_') ? tool.slice(4) : tool
            allTools.push(toolNameMap[cleaned] ?? cleaned)
            hasOutputActivity = true
          }
        }
      }
    }
  }

  if (!hasOutputActivity) return results

  const dedupKey = `kiro:${sessionId}:${executionId}`
  const rawStartTime =
    timeField(data, ['startTime', 'createdAt', 'timestamp']) ??
    timeField(metadata, ['startTime', 'createdAt', 'timestamp'])
  const tsDate = parseKiroTimestamp(rawStartTime)
  if (!tsDate) return results

  const inputTokens = estimateTokensFromChars(inputChars)
  const outputTokens = estimateTokensFromChars(outputChars)
  // Prefer real metered credits at the public overage rate; fall back to
  // token-estimated pricing when the execution has no usage data — same
  // contract as the CLI and v2 parsers.
  results.push(
    callCandidate(
      {
        provider: 'kiro',
        model: modelId,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costIsEstimated: executionCredits === 0,
        tools: [...new Set(allTools)],
        bashCommands: [],
        timestamp: tsDate.toISOString(),
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: pendingUserMessage,
        sessionId,
      },
      executionCredits > 0
        ? { _tag: 'recorded', amount: executionCredits * USD_PER_KIRO_CREDIT }
        : { _tag: 'calculated', model: modelId, inputTokens, outputTokens },
    ),
  )

  return results
}

// --- Kiro CLI session parser ---
function createCliCandidateParser(meta: Record<string, unknown>): {
  push: (entry: Record<string, unknown>) => KiroCandidate[]
  finish: () => KiroCandidate[]
} {
  const sessionId = rawStringField(meta, 'session_id') ?? ''
  const project = basename(rawStringField(meta, 'cwd') ?? '')

  const state = asRecord(meta['session_state'])
  const rtsState = asRecord(state?.['rts_model_state'])
  const modelInfo = asRecord(rtsState?.['model_info'])
  const malformedModel = hasMalformedSelectedModelField(modelInfo, ['model_id'])
  let modelId = rawStringField(modelInfo, 'model_id') ?? 'auto'
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'
  else modelId = normalizeModelId(modelId)

  const conversation = asRecord(state?.['conversation_metadata'])
  const rawTurns = conversation?.['user_turn_metadatas']
  const turns = Array.isArray(rawTurns) ? rawTurns.map(asRecord) : []

  // Walk through JSONL entries grouping by prompt turns
  let turnIndex = 0
  let pendingUserMessage = ''
  let outputChars = 0
  let inputChars = 0
  const allTools: string[] = []
  let turnStartTimestamp: string | undefined

  function flushTurn(): KiroCandidate[] {
    if (outputChars === 0) return []
    const turnMeta = turns[turnIndex]
    const dedupKey = `kiro-cli:${sessionId}:${turnIndex}`

    const timestamp = timeField(turnMeta, ['end_timestamp']) ?? turnStartTimestamp ?? rawStringField(meta, 'created_at')
    const tsDate = parseKiroTimestamp(timestamp)
    if (!tsDate) {
      turnIndex++
      return []
    }
    if (malformedModel) {
      turnIndex++
      return [unparsedCandidate(dedupKey, true)]
    }
    const inputTokens = estimateTokensFromChars(inputChars)
    const outputTokens = estimateTokensFromChars(outputChars)
    // metering_usage values are credits (unit: "credit"), not dollars —
    // convert at the public overage rate. Gate on credits > 0, not array
    // presence: real sessions carry empty metering_usage arrays (turn still
    // in flight when the meta was written), which must fall back to
    // token-estimated pricing — same contract as the v1-execution and v2
    // parsers.
    const usage = turnMeta?.['metering_usage']
    const turnCredits: number | string = Array.isArray(usage)
      ? usage.reduce<number | string>((sum, item) => {
          const decoded = decodeKiroRecord(item)
          if (Result.isFailure(decoded)) return sum
          return addLegacyCreditValue(sum, decoded.success['value'])
        }, 0)
      : 0
    const hasRecordedCredits = Number(turnCredits) > 0
    const candidate = callCandidate(
      {
        provider: 'kiro',
        model: modelId,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costIsEstimated: !hasRecordedCredits,
        tools: [...new Set(allTools)],
        bashCommands: [],
        timestamp: tsDate.toISOString(),
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: pendingUserMessage,
        sessionId,
        project,
      },
      hasRecordedCredits
        ? { _tag: 'recorded', amount: Number(turnCredits) * USD_PER_KIRO_CREDIT }
        : { _tag: 'calculated', model: modelId, inputTokens, outputTokens },
      true,
    )
    turnIndex++
    return [candidate]
  }

  let isFirstPrompt = true
  const push = (entry: Record<string, unknown>): KiroCandidate[] => {
    const completed: KiroCandidate[] = []
    const kind = rawStringField(entry, 'kind')
    const data = asRecord(entry['data'])
    if (!data) return completed
    if (kind === 'Prompt') {
      if (!isFirstPrompt) {
        completed.push(...flushTurn())
        pendingUserMessage = ''
        outputChars = 0
        inputChars = 0
        allTools.length = 0
      }
      isFirstPrompt = false
      const content = data['content']
      if (Array.isArray(content)) {
        for (const item of content) {
          const rec = asRecord(item)
          const text = rawStringField(rec, 'data')
          if (rec && rawStringField(rec, 'kind') === 'text' && text !== undefined) {
            pendingUserMessage = text.slice(0, 500)
            inputChars += text.length
          }
        }
      }
      const meta2 = asRecord(data['meta'])
      if (meta2) {
        const ts = decodeKiroNumber(meta2['timestamp'])
        if (Result.isSuccess(ts)) turnStartTimestamp = new Date(ts.success * 1000).toISOString()
      }
    } else if (kind === 'AssistantMessage') {
      const content = data['content']
      if (Array.isArray(content)) {
        for (const item of content) {
          const rec = asRecord(item)
          if (!rec) continue
          const text = rawStringField(rec, 'data')
          if (rawStringField(rec, 'kind') === 'text' && text !== undefined) {
            outputChars += text.length
          } else if (rawStringField(rec, 'kind') === 'toolUse') {
            const toolData = asRecord(rec['data'])
            if (toolData) {
              const name = rawStringField(toolData, 'name') ?? ''
              if (name) allTools.push(toolNameMap[name] ?? name)
            }
          }
        }
      }
    } else if (kind === 'ToolResults') {
      // Tool results count as input context
      const content = data['content']
      if (Array.isArray(content)) {
        for (const item of content) {
          const text = extractText(item)
          if (text) inputChars += text.length
        }
      }
    }
    return completed
  }
  return { push, finish: flushTurn }
}

// --- Kiro IDE workspace-session parser (workspace-sessions/<b64>/<sessionId>.json) ---
// Newer v1-era Kiro builds store session state here: history[] carries user prompts
// and assistant messages, some of which are stubs referencing per-execution files
// (parsed separately by parseModernExecution).
function parseWorkspaceSession(
  record: Record<string, unknown>,
  source: SessionSource,
  modifiedAt: number | undefined,
): KiroCandidate[] {
  const results: KiroCandidate[] = []
  const historyArr = record['history']
  if (!Array.isArray(historyArr) || typeof record['sessionId'] !== 'string') return results

  const sessionId = record['sessionId']
  const modelRaw = stringField(record, ['selectedModel'])
  let modelId = normalizeModelId(modelRaw)
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  let inputChars = 0
  let outputChars = 0
  let pendingUserMessage = ''
  const allTools: string[] = []
  let hasExecutionRefs = false
  let hasRealAssistantContent = false

  for (const item of historyArr) {
    const rec = asRecord(item)
    if (!rec) continue

    // Track if this session references execution files (which are parsed separately)
    const execBacked = typeof rec['executionId'] === 'string'
    if (execBacked) hasExecutionRefs = true

    const msg = asRecord(rec['message'])
    if (!msg) continue
    const role = stringField(msg, ['role'])
    const text = extractText(msg['content'])
    if (role === 'user' && text) {
      inputChars += text.length
      pendingUserMessage = text.slice(0, 500)
    } else if (role === 'assistant' && !execBacked && text && text !== 'On it.') {
      // An item carrying an executionId is execution-backed: its content is
      // counted from the execution file, so counting it here would double-count.
      // 'On it.' is the observed placeholder text Kiro writes for such stubs
      // when the executionId rides a separate history item.
      outputChars += text.length
      hasRealAssistantContent = true
    }
  }

  // Skip workspace-session entries that are pure execution stubs:
  // they reference executionIds (parsed separately as execution files)
  // and have no real assistant content beyond "On it." placeholders.
  // This avoids double-counting input tokens from both paths.
  if (hasExecutionRefs && !hasRealAssistantContent) return results

  // Skip sessions with no meaningful content
  if (inputChars === 0 && outputChars === 0) return results

  // Use file mtime as timestamp (workspace-session files don't carry startTime).
  // No stat means no usable timestamp: drop the call like the other parse paths.
  if (modifiedAt === undefined) return results
  const timestamp = new Date(modifiedAt).toISOString()

  const dedupKey = `kiro:ws-session:${sessionId}`

  const inputTokens = estimateTokensFromChars(inputChars)
  const outputTokens = estimateTokensFromChars(outputChars)

  results.push(
    callCandidate(
      {
        provider: 'kiro',
        model: modelId,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costIsEstimated: true,
        tools: [...new Set(allTools)],
        bashCommands: [],
        timestamp,
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: pendingUserMessage,
        sessionId,
      },
      { _tag: 'calculated', model: modelId, inputTokens, outputTokens },
      true,
    ),
  )

  return results
}

// --- Kiro IDE v2 session types & parser (~/.kiro/sessions/<hash>/sess_*/) ---
// v2 is a self-contained, event-sourced store: one directory per session holding
// session.json (metadata incl. the real modelId) + messages.jsonl (append-only
// event log). Unlike v1 it does NOT use separate execution files — assistant
// content is inline. Usage is billed in credits with no token counts, so tokens
// and cost are estimated from transcript text priced at the real model.

function createV2CandidateParser(
  source: SessionSource,
  metadata: Record<string, unknown> | null,
): { push: (raw: string, event: Record<string, unknown>) => KiroCandidate[]; finish: () => KiroCandidate[] } {
  // Companion session.json carries the real model + session metadata.
  const sessionId = rawStringField(metadata, 'id') || basename(dirname(source.path))
  const malformedModel = hasMalformedSelectedModelField(metadata, ['modelId'])
  let modelId = normalizeModelId(rawStringField(metadata, 'modelId') ?? '')
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  // In-flight turn state. A turn spans turn_start..turn_end sharing an
  // executionId; the preceding `user` event carries its prompt.
  let pendingUserMessage = ''
  let pendingUserChars = 0

  let inTurn = false
  let execId = ''
  let turnStartTs: string | undefined
  let outputChars = 0
  let reasoningChars = 0
  let toolResultChars = 0
  let turnCredits = 0
  let turnUserMessage = ''
  let turnUserChars = 0
  const tools: string[] = []
  let emittedCandidateCount = 0

  const resetTurn = () => {
    inTurn = false
    execId = ''
    turnStartTs = undefined
    outputChars = 0
    reasoningChars = 0
    toolResultChars = 0
    turnCredits = 0
    turnUserMessage = ''
    turnUserChars = 0
    tools.length = 0
  }

  const pushTool = (raw: string) => {
    if (!raw) return
    // Strip mcp_ prefix for cleaner display, matching the modern-execution parser.
    const cleaned = raw.startsWith('mcp_') ? raw.slice(4) : raw
    tools.push(toolNameMap[cleaned] ?? cleaned)
  }

  const flushTurn = (): KiroCandidate[] => {
    if (!inTurn) {
      resetTurn()
      return []
    }
    let candidate: KiroCandidate | undefined
    const hasActivity = outputChars > 0 || reasoningChars > 0 || tools.length > 0
    if (hasActivity) {
      const dedupKey = `kiro-v2:${sessionId}:${execId || String(emittedCandidateCount)}`
      const tsDate = parseKiroTimestamp(turnStartTs)
      if (tsDate) {
        if (malformedModel) {
          candidate = unparsedCandidate(dedupKey, true)
          emittedCandidateCount++
          resetTurn()
          return [candidate]
        }
        // Tool results are fed back to the model as input context, so count them
        // toward input tokens — same treatment as the CLI parser's ToolResults.
        const inputTokens = estimateTokensFromChars(turnUserChars + toolResultChars)
        // outputTokens and reasoningTokens are kept disjoint — downstream
        // aggregation (models-report, audit-report, parser) sums the two
        // fields, so folding reasoning into outputTokens would double-count.
        const reasoningTokens = estimateTokensFromChars(reasoningChars)
        const outputTokens = estimateTokensFromChars(outputChars)
        // Prefer real metered credits (converted at the public overage rate)
        // over token estimation; fall back to token pricing when the turn has
        // no usage_summary (e.g. still in progress or null usage). Kiro's
        // reported output does not cover the reasoning text, so the shared
        // helper combines them for pricing only.
        candidate = callCandidate(
          {
            provider: 'kiro',
            model: modelId,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens,
            webSearchRequests: 0,
            costIsEstimated: turnCredits === 0,
            tools: [...new Set(tools)],
            bashCommands: [],
            timestamp: tsDate.toISOString(),
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: turnUserMessage,
            sessionId,
            project: source.project,
          },
          turnCredits > 0
            ? { _tag: 'recorded', amount: turnCredits * USD_PER_KIRO_CREDIT }
            : {
                _tag: 'calculated',
                model: modelId,
                inputTokens,
                outputTokens: billableOutputTokens('kiro', outputTokens, reasoningTokens),
              },
          true,
        )
        emittedCandidateCount++
      }
    }
    resetTurn()
    return candidate ? [candidate] : []
  }

  const push = (line: string, evt: Record<string, unknown>): KiroCandidate[] => {
    if (!line.trim()) return []
    const payload = asRecord(evt['payload'])
    if (!payload) return []
    const candidates: KiroCandidate[] = []
    const type = stringField(payload, ['type'])
    const ts = rawStringField(evt, 'timestamp')

    if (type === 'user') {
      // New prompt: close any in-flight turn defensively, then stash the text
      // for the upcoming turn_start.
      if (inTurn) candidates.push(...flushTurn())
      const text = rawStringField(payload, 'content') ?? extractText(payload['content'])
      pendingUserMessage = text.slice(0, 500)
      pendingUserChars = text.length
    } else if (type === 'turn_start') {
      if (inTurn) candidates.push(...flushTurn())
      inTurn = true
      execId = stringField(payload, ['executionId'])
      turnStartTs = ts
      turnUserMessage = pendingUserMessage
      turnUserChars = pendingUserChars
      pendingUserMessage = ''
      pendingUserChars = 0
    } else if (type === 'assistant') {
      const text = rawStringField(payload, 'content') ?? extractText(payload['content'])
      if (stringField(payload, ['operationType']) === 'Reasoning') reasoningChars += text.length
      else outputChars += text.length
      if (!inTurn && text.length > 0) inTurn = true
      if (!turnStartTs && ts) turnStartTs = ts
    } else if (type === 'tool_call') {
      pushTool(stringField(payload, ['toolName', 'name']))
    } else if (type === 'tool_result') {
      // Tool output re-enters the model as context on the next inference call.
      // content is a plain string in observed logs; extractText covers nesting.
      const text = rawStringField(payload, 'content') ?? extractText(payload['content'])
      toolResultChars += text.length
    } else if (type === 'usage_summary') {
      // usedTools is a reliable per-turn tool list. Credits are the real billed
      // usage (promptTurnSummaries[].usage with unit "credit") — harvest them
      // for credit-based cost. usage can be null on some turns.
      const summaries = payload['promptTurnSummaries']
      if (Array.isArray(summaries)) {
        for (const s of summaries) {
          const rec = asRecord(s)
          const used = rec?.['usedTools']
          if (Array.isArray(used)) for (const u of used) if (typeof u === 'string') pushTool(u)
          const usage = rec?.['usage']
          if (usage !== undefined && usage !== null) {
            const decodedUsage = decodeKiroFinite(usage)
            if (Result.isSuccess(decodedUsage)) turnCredits += decodedUsage.success
            // Malformed optional credit values were ignored by the legacy
            // parser; valid token-derived pricing remains available.
          }
        }
      }
    } else if (type === 'turn_end') {
      candidates.push(...flushTurn())
    }
    return candidates
  }
  return { push, finish: flushTurn }
}

function decodeKiroJsonRecord(raw: string): Record<string, unknown> | null {
  const decoded = decodeKiroJson(raw)
  return Result.isSuccess(decoded) ? decoded.success : null
}

function hasMalformedSelectedModelField(record: Record<string, unknown> | null, names: readonly string[]): boolean {
  if (!record) return false
  let malformed = false
  for (const name of names) {
    const value = record[name]
    if (value === undefined || value === null) continue
    const decoded = decodeOptionalModel(value)
    if (Result.isFailure(decoded)) {
      malformed = true
      continue
    }
    if (decoded.success?.trim()) return false
  }
  return malformed
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  pricing: ScanPricing,
  context?: ProviderScanContext,
): SessionParser {
  const signal = context?.signal

  const parseEffect = Effect.fn('parseKiroSession')(function* (): Effect.fn.Return<KiroCandidate[], Error> {
    yield* checkScanAbort(signal)

    const content = yield* readSessionFileEffect(source.path, 'utf-8', signal ? { signal } : {})
    if (content === null) return []
    const record = decodeKiroJsonRecord(content)
    if (!record) return []

    if (Array.isArray(record['history']) && typeof record['sessionId'] === 'string') {
      const selectedModel = record['selectedModel']
      if (selectedModel !== undefined && Result.isFailure(decodeOptionalModel(selectedModel))) {
        return [unparsedCandidate()]
      }
      const fileInfo = yield* scanIo(() => stat(source.path), signal).pipe(
        Effect.map(info => info.mtimeMs),
        Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(undefined))),
      )
      return parseWorkspaceSession(record, source, fileInfo)
    }

    const metadata = asRecord(record['metadata'])
    if (Array.isArray(record['chat']) && metadata) {
      if (hasMalformedSelectedModelField(metadata, ['modelId'])) {
        return [unparsedCandidate()]
      }
      return parseChatFile(record, stringField(metadata, ['workflowId']) || basename(source.path, '.chat'))
    }
    return parseModernExecution(record, source.path)
  })

  const parseStream: NonNullable<SessionParser['parseStream']> = (onUnparsedCall = Effect.void) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const isV2 = /[/\\]sess_[^/\\]+[/\\]messages\.jsonl$/.test(source.path)
        if (source.path.endsWith('.jsonl')) {
          const metaPath = isV2 ? join(dirname(source.path), 'session.json') : source.path.replace(/\.jsonl$/, '.json')
          let parser: ReturnType<typeof createV2CandidateParser> | undefined
          const lineStream = readSessionLinesStream(source.path, undefined, {
            maxBytes: MAX_SESSION_FILE_BYTES,
            ...(signal ? { signal } : {}),
          }).pipe(
            Stream.map(line => (typeof line === 'string' ? line : line.toString('utf-8'))),
            Stream.filter(line => line.trim().length > 0),
            Stream.mapEffect(line =>
              Effect.gen(function* () {
                const record = decodeKiroJsonRecord(line)
                if (!record) return []
                if (!parser) {
                  const metaContent = yield* readCompanionFile(metaPath, signal)
                  const decodedMeta = metaContent === null ? null : decodeKiroJsonRecord(metaContent)
                  if (isV2) {
                    parser = createV2CandidateParser(source, decodedMeta)
                  } else {
                    const meta = decodedMeta ?? {
                      session_id: basename(source.path, '.jsonl'),
                      cwd: '',
                      created_at: '',
                      updated_at: '',
                    }
                    const cli = createCliCandidateParser(meta)
                    parser = { push: (_raw, decodedRecord) => cli.push(decodedRecord), finish: cli.finish }
                  }
                }
                return parser.push(line, record)
              }),
            ),
            Stream.flatMap(candidates => Stream.fromIterable(candidates)),
            Stream.concat(Stream.suspend(() => Stream.fromIterable(parser?.finish() ?? []))),
          )
          return lineStream
        }

        const candidates = yield* parseEffect()
        return Stream.fromIterable(candidates)
      }).pipe(
        Effect.map(candidates =>
          candidates.pipe(
            Stream.mapEffect(candidate =>
              Effect.gen(function* () {
                if (candidate._tag === 'unparsed') {
                  if (candidate.deduplicationKey) {
                    if (seenKeys.has(candidate.deduplicationKey)) return Result.fail(undefined)
                    if (candidate.seenBeforePricing) seenKeys.add(candidate.deduplicationKey)
                  }
                  yield* onUnparsedCall
                  return Result.fail(undefined)
                }

                const deduplicationKey = candidate.fields.deduplicationKey
                if (seenKeys.has(deduplicationKey)) return Result.fail(undefined)
                if (candidate.seenBeforePricing) seenKeys.add(deduplicationKey)

                const cost = candidate.cost
                const costUSD =
                  cost._tag === 'recorded'
                    ? cost.amount
                    : yield* Effect.try({
                        try: () => pricing.calculateCost(cost.model, cost.inputTokens, cost.outputTokens, 0, 0, 0),
                        catch: toError,
                      })
                if (!candidate.seenBeforePricing) seenKeys.add(deduplicationKey)
                return Result.succeed({ ...candidate.fields, costUSD })
              }),
            ),
            Stream.filterMap(result => result),
          ),
        ),
      ),
    )

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

const readCompanionFile = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<string | null, Error> {
  yield* checkScanAbort(signal)
  const result = yield* Effect.uninterruptible(
    Effect.result(Effect.tryPromise({ try: () => readFile(path, 'utf-8'), catch: toError })),
  )
  yield* checkScanAbort(signal)
  return Result.isSuccess(result) ? result.success : null
})

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause })
}

// --- Discovery ---

function getKiroAgentDir(override?: string): string[] {
  if (override) return [override]
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')]
  }
  if (process.platform === 'win32') {
    return [join(homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')]
  }
  // On Linux, scan both ~/.kiro-server/data/... (remote dev boxes) and
  // ~/.config/Kiro/... (local installs). Both can have data simultaneously
  // if the user switches between local and remote, or if .kiro-server exists
  // but is stale while .config/Kiro has current sessions.
  const kiroServer = join(homedir(), '.kiro-server', 'data', 'User', 'globalStorage', 'kiro.kiroagent')
  const kiroConfig = join(homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  return [kiroServer, kiroConfig]
}

function getKiroWorkspaceStorageDir(override?: string): string {
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'workspaceStorage')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'workspaceStorage')
  }
  return join(homedir(), '.config', 'Kiro', 'User', 'workspaceStorage')
}

const readDirentsOrEmpty = Effect.fnUntraced(function* (
  path: string,
  signal?: AbortSignal,
): Effect.fn.Return<Dirent[], Error> {
  return yield* scanIo(() => readdir(path, { withFileTypes: true }), signal).pipe(
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed([]))),
  )
})

const isDirectory = Effect.fnUntraced(function* (path: string, signal?: AbortSignal): Effect.fn.Return<boolean, Error> {
  return yield* scanIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isDirectory()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
})

function readWorkspaceProject(workspaceDir: string, raw: string | null): string {
  if (raw !== null) {
    const data = decodeKiroJsonRecord(raw)
    const folder = data?.['folder']
    if (typeof folder === 'string' && folder) {
      const url = folder.replace(/^file:\/\//, '')
      try {
        return basename(decodeURIComponent(url))
      } catch {
        return basename(workspaceDir)
      }
    }
  }
  return basename(workspaceDir)
}

const resolveWorkspaceProject = Effect.fnUntraced(function* (
  agentDir: string,
  workspaceStorageDir: string,
  workspaceHash: string,
  signal?: AbortSignal,
): Effect.fn.Return<string, Error> {
  const wsDir = join(workspaceStorageDir, workspaceHash)
  const workspaceJson = yield* readCompanionFile(join(wsDir, 'workspace.json'), signal)
  const project = readWorkspaceProject(wsDir, workspaceJson)
  if (project !== workspaceHash) return project

  const sessionsPath = join(agentDir, 'workspace-sessions')
  const dirs = yield* readDirectoryOrEmpty(sessionsPath, signal)
  for (const dir of dirs) {
    const decoded = Buffer.from(dir.replace(/_$/, ''), 'base64').toString('utf-8')
    if (decoded) return basename(decoded)
  }

  return workspaceHash
})

const discoverSessions = Effect.fnUntraced(function* (
  agentDir: string,
  workspaceStorageDir: string,
  cliSessionsDir: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const sources: SessionSource[] = []

  // --- Kiro CLI sessions (~/.kiro/sessions/cli/) ---
  const cliEntries = yield* readDirentsOrEmpty(cliSessionsDir, signal)
  for (const entry of cliEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const jsonlPath = join(cliSessionsDir, entry.name)
    const metaPath = jsonlPath.replace(/\.jsonl$/, '.json')
    const raw = yield* readCompanionFile(metaPath, signal)
    const meta = raw === null ? null : decodeKiroJsonRecord(raw)
    const cwd = meta?.['cwd']
    const project = typeof cwd === 'string' && cwd ? basename(cwd) : 'kiro-cli'
    sources.push({ path: jsonlPath, project, provider: 'kiro' })
  }

  // --- Kiro IDE sessions ---
  const entries = yield* readDirentsOrEmpty(agentDir, signal)
  const workspaceDirs = entries.filter(e => e.isDirectory() && e.name.length === 32).map(e => e.name)

  for (const wsHash of workspaceDirs) {
    const wsPath = join(agentDir, wsHash)
    const project = yield* resolveWorkspaceProject(agentDir, workspaceStorageDir, wsHash, signal)
    const entries = yield* readDirentsOrEmpty(wsPath, signal)

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const entryPath = join(wsPath, entry.name)
      if (entry.isFile() && (entry.name.endsWith('.chat') || extname(entry.name) === '')) {
        sources.push({ path: entryPath, project, provider: 'kiro' })
        continue
      }

      if (!entry.isDirectory()) continue

      const childEntries = yield* readDirentsOrEmpty(entryPath, signal)
      for (const child of childEntries) {
        if (child.name.startsWith('.')) continue
        if (!child.isFile()) continue
        if (extname(child.name) !== '') continue
        sources.push({ path: join(entryPath, child.name), project, provider: 'kiro' })
      }
    }
  }

  // --- Kiro IDE workspace-sessions (newer builds store session state here) ---
  // These files contain history[].message with user prompts and assistant stubs
  // plus executionId references. They capture sessions not written as per-execution files.
  {
    const wsSessionsDir = join(agentDir, 'workspace-sessions')
    const wsSessionDirs = yield* readDirentsOrEmpty(wsSessionsDir, signal)
    for (const dir of wsSessionDirs) {
      if (!dir.isDirectory()) continue
      // Directory name is base64-encoded workspace path
      let project = 'kiro-ide'
      const decoded = Buffer.from(dir.name.replace(/_/g, '='), 'base64').toString('utf-8')
      if (decoded) project = basename(decoded)
      // Skip bare homedir as project name
      if (project === basename(homedir())) project = 'kiro-ide'

      const sessionFiles = yield* readDirentsOrEmpty(join(wsSessionsDir, dir.name), signal)
      for (const sf of sessionFiles) {
        if (!sf.isFile() || !sf.name.endsWith('.json') || sf.name === 'sessions.json') continue
        sources.push({ path: join(wsSessionsDir, dir.name, sf.name), project, provider: 'kiro' })
      }
    }
  }

  return sources
})

// Discover v2 IDE sessions under ~/.kiro/sessions/<workspaceHash>/sess_*/.
// Each session is a self-contained directory (session.json + messages.jsonl);
// the emitted source points at messages.jsonl and routes to parseV2Session.
const discoverV2Sessions = Effect.fnUntraced(function* (
  sessionsRoot: string,
  signal?: AbortSignal,
): Effect.fn.Return<SessionSource[], Error> {
  const sources: SessionSource[] = []
  const hashDirs = yield* readDirentsOrEmpty(sessionsRoot, signal)

  for (const hd of hashDirs) {
    // Skip the CLI store (scanned separately) and any stray files.
    if (!hd.isDirectory() || hd.name === 'cli') continue
    const hashPath = join(sessionsRoot, hd.name)

    const sessDirs = yield* readDirentsOrEmpty(hashPath, signal)

    for (const sd of sessDirs) {
      if (!sd.isDirectory() || !sd.name.startsWith('sess_')) continue
      const sessDir = join(hashPath, sd.name)
      const messagesPath = join(sessDir, 'messages.jsonl')
      if (!(yield* isFile(messagesPath, signal))) continue

      // Project from session.json workspacePaths; fall back to a generic label.
      let project = 'kiro-ide'
      const raw = yield* readCompanionFile(join(sessDir, 'session.json'), signal)
      const sessionMeta = raw === null ? null : decodeKiroJsonRecord(raw)
      const workspacePaths = sessionMeta?.['workspacePaths']
      const wp = Array.isArray(workspacePaths) && typeof workspacePaths[0] === 'string' ? workspacePaths[0] : undefined
      if (wp) project = basename(wp)
      if (project === basename(homedir())) project = 'kiro-ide'

      sources.push({ path: messagesPath, project, provider: 'kiro' })
    }
  }

  return sources
})

const isFile = Effect.fnUntraced(function* (path: string, signal?: AbortSignal): Effect.fn.Return<boolean, Error> {
  return yield* scanIo(() => stat(path), signal).pipe(
    Effect.map(info => info.isFile()),
    Effect.catch(error => (isScanAbortedError(error) ? Effect.fail(error) : Effect.succeed(false))),
  )
})

export function createKiroProvider(
  agentDirOverride?: string,
  workspaceStorageDirOverride?: string,
  cliSessionsDirOverride?: string,
  v2SessionsRootOverride?: string,
): Provider {
  const configuredAgentDirs = getKiroAgentDir(agentDirOverride)
  const wsDir = getKiroWorkspaceStorageDir(workspaceStorageDirOverride)
  // When overrides are provided (tests), don't scan real CLI sessions unless explicitly given
  const cliDir =
    cliSessionsDirOverride ??
    (agentDirOverride
      ? join(agentDirOverride, '..', 'cli-sessions')
      : join(process.env['KIRO_HOME'] || join(homedir(), '.kiro'), 'sessions', 'cli'))
  // v2 IDE sessions live under ~/.kiro/sessions/<hash>/sess_*/, a sibling of the
  // CLI store (.../sessions/cli). Derive the root from cliDir ONLY when cliDir was
  // itself explicit (default path or cliSessionsDirOverride). When only
  // agentDirOverride is set (tests), the derived cliDir parent would point at an
  // arbitrary directory (e.g. the system tmpdir) — scan nothing in that case.
  const v2Root =
    v2SessionsRootOverride ??
    (cliSessionsDirOverride ? dirname(cliSessionsDirOverride) : agentDirOverride ? undefined : dirname(cliDir))

  const discoverEffect = Effect.fn('discoverKiroSessions')(function* (
    context?: ProviderScanContext,
  ): Effect.fn.Return<SessionSource[], Error> {
    yield* checkScanAbort(context?.signal)
    let agentDirs = configuredAgentDirs
    if (!agentDirOverride && process.platform === 'linux') {
      const existing: string[] = []
      for (const path of configuredAgentDirs) {
        if (yield* isDirectory(path, context?.signal)) existing.push(path)
      }
      // Preserve the original config fallback when neither Linux root exists.
      const fallback = configuredAgentDirs.at(-1)
      agentDirs = existing.length > 0 ? existing : fallback ? [fallback] : []
    }

    const allSources: SessionSource[] = []
    for (const agentDir of agentDirs) {
      yield* checkScanAbort(context?.signal)
      allSources.push(...(yield* discoverSessions(agentDir, wsDir, cliDir, context?.signal)))
    }
    if (v2Root) allSources.push(...(yield* discoverV2Sessions(v2Root, context?.signal)))
    const seen = new Set<string>()
    return allSources.filter(source => {
      if (seen.has(source.path)) return false
      seen.add(source.path)
      return true
    })
  })

  return {
    name: 'kiro',
    displayName: 'Kiro',

    modelDisplayName(model: string): string {
      if (model === 'kiro-auto') return 'Kiro (auto)'
      for (const [key, name] of modelDisplayEntries) {
        if (model === key || model.startsWith(key + '-')) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      if (rawTool.startsWith('mcp__')) return rawTool
      return toolNameMap[rawTool] ?? rawTool
    },

    discoverSessionsEffect: discoverEffect,

    discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      // Remove this Promise edge once discovery callers use the native Effect API.
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

export const kiro = createKiroProvider()
