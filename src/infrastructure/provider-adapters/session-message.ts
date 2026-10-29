import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

import { extractBashCommands } from '@/core/ingestion/parsers/bash-utils.js'
import { billableOutputTokens } from '@/core/ingestion/normalization/billable-output.js'
import { captureScanPricing } from '@/infrastructure/pricing/models.js'
import type { ScanPricing } from '@/core/domain/pricing/scan-pricing.js'
import type { ParsedProviderCall } from '@/infrastructure/provider-adapters/types.js'

const unknownMessageSchema = Schema.Struct({
  role: Schema.optional(Schema.Unknown),
  modelID: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Unknown),
  tokens: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Schema.Unknown),
})
const unknownPartSchema = Schema.Struct({
  type: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.Unknown),
  tool: Schema.optional(Schema.Unknown),
  state: Schema.optional(Schema.Unknown),
})
const unknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeUnknownMessage = Schema.decodeUnknownResult(unknownMessageSchema)
const decodeUnknownRole = Schema.decodeUnknownResult(Schema.Struct({ role: Schema.Unknown }))
const decodeUnknownPart = Schema.decodeUnknownResult(unknownPartSchema)
const decodeRecord = Schema.decodeUnknownResult(unknownRecordSchema)
const decodeString = Schema.decodeUnknownResult(Schema.String)
const decodeFinite = Schema.decodeUnknownResult(Schema.Finite)
const decodeJsonValue = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const v2ModelReferenceSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  providerID: Schema.optional(Schema.NullOr(Schema.String)),
})
const decodeV2ModelReference = Schema.decodeUnknownResult(v2ModelReferenceSchema)

// Reusable projections describe the canonical values handed to the builder.
// Raw source aliases stay unknown until selection so an unused sibling cannot
// invalidate data that the builder actually consumes.
export const consumedMessageSchema = Schema.Struct({
  role: Schema.String,
  modelID: Schema.optional(Schema.String),
  // Selected only after calculated pricing returns zero.
  cost: Schema.optional(Schema.Unknown),
  tokens: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Finite),
      output: Schema.optional(Schema.Finite),
      reasoning: Schema.optional(Schema.Finite),
      cache: Schema.optional(
        Schema.Struct({ read: Schema.optional(Schema.Finite), write: Schema.optional(Schema.Finite) }),
      ),
    }),
  ),
})
export const consumedPartSchema = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Struct({ input: Schema.optional(unknownRecordSchema) })),
})

// Canonical consumed message facts. Source aliases and unused vendor fields are
// resolved once at the JSON boundary, before the pure call builder.
export type MessageData = typeof consumedMessageSchema.Type
export type PartData = typeof consumedPartSchema.Type
export type V2ModelReference = typeof v2ModelReferenceSchema.Type

type RawMessage = typeof unknownMessageSchema.Type
type RawPart = typeof unknownPartSchema.Type
type RawCounters = Record<string, unknown>

function record(value: unknown): RawCounters | undefined {
  const decoded = decodeRecord(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

function selectedNumber(primary: unknown, fallback?: unknown): Result.Result<number | undefined, unknown> {
  const value = primary ?? fallback
  if (value === undefined || value === null) return Result.succeed(undefined)
  const decoded = decodeFinite(value)
  return Result.isSuccess(decoded) ? Result.succeed(decoded.success) : Result.fail(decoded.failure)
}

export function decodeMessageValue(value: unknown, decodedRole?: string): Result.Result<MessageData, unknown> {
  const rawResult = decodeUnknownMessage(value)
  if (Result.isFailure(rawResult)) return Result.fail(rawResult.failure)
  const raw: RawMessage = rawResult.success
  const role = decodedRole === undefined ? decodeString(raw.role) : Result.succeed(decodedRole)
  if (Result.isFailure(role)) return Result.fail(role.failure)

  const selectedModel = raw.modelID ?? raw.model
  let modelID: string | undefined
  if (selectedModel !== undefined && selectedModel !== null) {
    const decoded = decodeString(selectedModel)
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
    modelID = decoded.success
  }

  const tokens = record(raw.tokens)
  const tokenCache = record(tokens?.['cache'])
  const usage = record(raw.usage)
  const input = selectedNumber(tokens?.['input'], usage?.['input_tokens'])
  if (Result.isFailure(input)) return Result.fail(input.failure)
  const output = selectedNumber(tokens?.['output'], usage?.['output_tokens'])
  if (Result.isFailure(output)) return Result.fail(output.failure)
  const reasoning = selectedNumber(tokens?.['reasoning'])
  if (Result.isFailure(reasoning)) return Result.fail(reasoning.failure)
  const cacheRead = selectedNumber(tokenCache?.['read'], usage?.['cache_read_input_tokens'])
  if (Result.isFailure(cacheRead)) return Result.fail(cacheRead.failure)
  const cacheWrite = selectedNumber(tokenCache?.['write'], usage?.['cache_creation_input_tokens'])
  if (Result.isFailure(cacheWrite)) return Result.fail(cacheWrite.failure)

  const consumed: MessageData = {
    role: role.success,
    ...(modelID !== undefined ? { modelID } : {}),
    ...(raw.cost !== undefined ? { cost: raw.cost } : {}),
    tokens: {
      input: input.success ?? 0,
      output: output.success ?? 0,
      reasoning: reasoning.success ?? 0,
      cache: { read: cacheRead.success ?? 0, write: cacheWrite.success ?? 0 },
    },
  }
  return Result.succeed(consumed)
}

export function decodeMessageRole(value: unknown): Result.Result<string, unknown> {
  const raw = decodeUnknownRole(value)
  if (Result.isFailure(raw)) return Result.fail(raw.failure)
  const role = decodeString(raw.success.role)
  return Result.isFailure(role) ? Result.fail(role.failure) : Result.succeed(role.success)
}

/** Decode JSON and only validate the model alias and token counters actually selected. */
export function decodeMessageJson(text: string): Result.Result<MessageData, unknown> {
  const json = decodeJsonValue(text)
  return Result.isFailure(json) ? Result.fail(json.failure) : decodeMessageValue(json.success)
}

export function decodeOpenCodeJson(text: string): Result.Result<unknown, unknown> {
  return decodeJsonValue(text)
}

export function decodeV2ModelReferenceValue(value: unknown): Result.Result<V2ModelReference | undefined, unknown> {
  if (value === undefined || value === null) return Result.succeed(undefined)
  const decoded = decodeV2ModelReference(value)
  return Result.isFailure(decoded) ? Result.fail(decoded.failure) : Result.succeed(decoded.success)
}

/** Decode one part while retaining its complete tool input for bounded evidence scanning. */
export function decodePartValue(value: unknown): Result.Result<PartData, unknown> {
  const rawResult = decodeUnknownPart(value)
  if (Result.isFailure(rawResult)) return Result.fail(rawResult.failure)
  const raw: RawPart = rawResult.success
  const type = decodeString(raw.type)
  if (Result.isFailure(type)) return Result.fail(type.failure)
  const text = decodeString(raw.text)
  const tool = decodeString(raw.tool)
  if (
    (type.success === 'tool' || type.success === 'tool-call' || type.success === 'tool_call') &&
    raw.tool !== undefined &&
    raw.tool !== null &&
    Result.isFailure(tool)
  ) {
    return Result.fail(tool.failure)
  }
  const state = record(raw.state)
  const input = record(state?.['input'])
  const consumed: PartData = {
    type: type.success,
    ...(Result.isSuccess(text) ? { text: text.success } : {}),
    ...(Result.isSuccess(tool) ? { tool: tool.success } : {}),
    ...(input ? { state: { input } } : {}),
  }
  return Result.succeed(consumed)
}

export function decodePartJson(text: string): Result.Result<PartData, unknown> {
  const json = decodeJsonValue(text)
  return Result.isFailure(json) ? Result.fail(json.failure) : decodePartValue(json.success)
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  skill: 'Skill',
  patch: 'Patch',
}

export function normalizeToolName(rawTool?: string): string {
  if (!rawTool) return ''
  if (rawTool.startsWith('mcp__')) return rawTool
  const builtIn = toolNameMap[rawTool]
  if (builtIn) return builtIn
  const serverSeparator = rawTool.indexOf('_')
  if (serverSeparator > 0 && serverSeparator < rawTool.length - 1) {
    return `mcp__${rawTool.slice(0, serverSeparator)}__${rawTool.slice(serverSeparator + 1)}`
  }
  return rawTool
}

export function sanitize(dir: string): string {
  return dir.replace(/^\//, '').replace(/\//g, '-')
}

export function parseTimestamp(raw: number): string {
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

// Pure projection from decoded message/part facts to the provider call. Null
// means an empty assistant turn with no tokens, cost, or substantive parts.
export function buildAssistantCallResult(opts: {
  providerName: string
  dedupKey: string
  sessionId: string
  data: MessageData
  parts: PartData[]
  timeCreatedMs: number
  userMessage: string
  directory?: string
  pricing?: ScanPricing
}): Result.Result<ParsedProviderCall | null, unknown> {
  const { data, parts } = opts
  const tokens = {
    input: data.tokens?.input ?? 0,
    output: data.tokens?.output ?? 0,
    reasoning: data.tokens?.reasoning ?? 0,
    cacheRead: data.tokens?.cache?.read ?? 0,
    cacheWrite: data.tokens?.cache?.write ?? 0,
  }
  const toolParts = parts.filter(
    p => (p.type === 'tool' || p.type === 'tool-call' || p.type === 'tool_call') && normalizeToolName(p.tool),
  )
  const hasTextOutput = parts.some(p => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0)
  const hasAnySubstantiveParts = parts.some(p =>
    ['text', 'tool', 'tool-call', 'tool_call', 'tool-result', 'tool_result', 'reasoning', 'file'].includes(p.type),
  )
  const allZero = Object.values(tokens).every(value => value === 0)
  if (allZero && (data.cost ?? 0) === 0 && !hasTextOutput && toolParts.length === 0 && !hasAnySubstantiveParts)
    return Result.succeed(null)

  const tools = toolParts.map(p => normalizeToolName(p.tool)).filter(Boolean)
  const bashCommands = toolParts.flatMap(part => {
    const command = part.state?.input?.['command']
    return part.tool === 'bash' && typeof command === 'string' ? extractBashCommands(command) : []
  })
  const skills = toolParts.flatMap(part => {
    const name = part.state?.input?.['name']
    return part.tool === 'skill' && typeof name === 'string' && name ? [name] : []
  })
  const subagentTypes = toolParts.flatMap(part => {
    const type = part.state?.input?.['subagent_type']
    return part.tool === 'task' && typeof type === 'string' && type ? [type] : []
  })
  const model = data.modelID ?? 'unknown'
  const pricing = opts.pricing ?? captureScanPricing()
  let costUSD = pricing.calculateCost(
    model,
    tokens.input,
    billableOutputTokens(opts.providerName, tokens.output, tokens.reasoning),
    tokens.cacheWrite,
    tokens.cacheRead,
    0,
  )
  if (costUSD === 0 && typeof data.cost === 'number' && data.cost > 0) {
    const decodedCost = decodeFinite(data.cost)
    if (Result.isFailure(decodedCost)) return Result.fail(decodedCost.failure)
    costUSD = decodedCost.success
  }

  const evidenceParts: string[] = []
  const pushEvidence = (value: string): void => {
    if (value.trim()) evidenceParts.push(value)
  }
  for (const part of parts) {
    if (
      (part.type === 'text' || part.type === 'tool-result' || part.type === 'tool_result') &&
      typeof part.text === 'string'
    ) {
      pushEvidence(part.text)
    } else if ((part.type === 'tool' || part.type === 'tool-call' || part.type === 'tool_call') && part.state?.input) {
      // Preserve unrelated tool input for bounded PR evidence: include strings
      // directly on input and one object level below it, matching the scan cap.
      for (const value of Object.values(part.state.input)) {
        if (typeof value === 'string') pushEvidence(value)
        else if (value && typeof value === 'object' && !Array.isArray(value)) {
          const nestedRecord = record(value)
          if (nestedRecord) {
            for (const nested of Object.values(nestedRecord)) {
              if (typeof nested === 'string') pushEvidence(nested)
            }
          }
        }
      }
    }
    if (evidenceParts.join('\n').length >= 2000) break
  }
  const assistantText = evidenceParts.join('\n').slice(0, 2000)

  return Result.succeed({
    provider: opts.providerName,
    model,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheCreationInputTokens: tokens.cacheWrite,
    cacheReadInputTokens: tokens.cacheRead,
    cachedInputTokens: tokens.cacheRead,
    reasoningTokens: tokens.reasoning,
    webSearchRequests: 0,
    costUSD,
    tools,
    bashCommands,
    skills,
    subagentTypes,
    timestamp: parseTimestamp(opts.timeCreatedMs),
    speed: 'standard',
    deduplicationKey: opts.dedupKey,
    userMessage: opts.userMessage,
    ...(assistantText ? { assistantText } : {}),
    sessionId: opts.sessionId,
    ...(opts.directory ? { projectPath: opts.directory, workingDirectory: opts.directory } : {}),
  })
}
