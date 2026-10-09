import { extractBashCommands } from '../bash-utils.js'
import { billableOutputTokens } from '../billable-output.js'
import { captureScanPricing } from '../models.js'
import type { ScanPricing } from '../scan-pricing.js'
import type { ParsedProviderCall } from './types.js'

// The message/part shape shared by OpenCode-style stores (OpenCode SQLite, the
// OpenCode file-based JSON layout, and Kilo Code). Token-bearing assistant
// messages carry either the normalized `tokens` object or a raw `usage` block.
export type MessageData = {
  role: string
  modelID?: string
  model?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export type PartData = {
  type: string
  text?: string
  tool?: string
  state?: { input?: { command?: string; name?: string; subagent_type?: string } }
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
    const server = rawTool.slice(0, serverSeparator)
    const tool = rawTool.slice(serverSeparator + 1)
    return `mcp__${server}__${tool}`
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

// Build a ParsedProviderCall from one assistant message and its parts. Returns
// null when the message has no tokens, no cost, and no substantive parts (an
// empty or errored turn worth skipping). Shared by the SQLite and file-based
// OpenCode parsers so both attribute tokens, tools, and cost identically.
export function buildAssistantCall(opts: {
  providerName: string
  dedupKey: string
  sessionId: string
  data: MessageData
  parts: PartData[]
  timeCreatedMs: number
  userMessage: string
  /// Exact session directory when the store records one (drives the
  /// canonical project identity; copilot/codex carry the same pair).
  directory?: string
  pricing?: ScanPricing
}): ParsedProviderCall | null {
  const { data, parts } = opts

  const tokens = {
    input: data.tokens?.input ?? data.usage?.input_tokens ?? 0,
    output: data.tokens?.output ?? data.usage?.output_tokens ?? 0,
    reasoning: data.tokens?.reasoning ?? 0,
    cacheRead: data.tokens?.cache?.read ?? data.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: data.tokens?.cache?.write ?? data.usage?.cache_creation_input_tokens ?? 0,
  }

  const toolParts = parts.filter(
    p => (p.type === 'tool' || p.type === 'tool-call' || p.type === 'tool_call') && normalizeToolName(p.tool),
  )
  const hasTextOutput = parts.some(p => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0)
  const hasToolOrTextParts = hasTextOutput || toolParts.length > 0
  const hasAnySubstantiveParts = parts.some(
    p =>
      p.type === 'text' ||
      p.type === 'tool' ||
      p.type === 'tool-call' ||
      p.type === 'tool_call' ||
      p.type === 'tool-result' ||
      p.type === 'tool_result' ||
      p.type === 'reasoning' ||
      p.type === 'file',
  )
  const hasActivity = hasToolOrTextParts || hasAnySubstantiveParts

  const allZero =
    tokens.input === 0 &&
    tokens.output === 0 &&
    tokens.reasoning === 0 &&
    tokens.cacheRead === 0 &&
    tokens.cacheWrite === 0
  if (allZero && (data.cost ?? 0) === 0 && !hasActivity) return null

  const tools = toolParts.map(p => normalizeToolName(p.tool)).filter(Boolean)

  const bashCommands = toolParts
    .filter(p => p.tool === 'bash' && typeof p.state?.input?.command === 'string')
    .flatMap(p => extractBashCommands(p.state!.input!.command!))

  // The skill/subagent name lives in the tool-call input, not the tool name, so
  // the Skills & Agents breakdown needs these extracted alongside the tool list.
  const skills = toolParts
    .filter(p => p.tool === 'skill' && typeof p.state?.input?.name === 'string')
    .map(p => p.state!.input!.name!)
    .filter(Boolean)

  const subagentTypes = toolParts
    .filter(p => p.tool === 'task' && typeof p.state?.input?.subagent_type === 'string')
    .map(p => p.state!.input!.subagent_type!)
    .filter(Boolean)

  const model = data.modelID ?? data.model ?? 'unknown'
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
    costUSD = data.cost
  }

  // Bounded assistant/tool-output evidence for the central PR scan (e.g. the
  // agent printing the URL of the PR it just created, or a `gh` invocation in
  // a tool input). Transient: parsed into per-turn prRefs downstream, never
  // persisted per-call.
  const evidenceParts: string[] = []
  const pushEvidence = (s: string): void => {
    if (s.trim()) evidenceParts.push(s)
  }
  for (const p of parts) {
    if (p.type === 'text' && typeof p.text === 'string') {
      pushEvidence(p.text)
    } else if ((p.type === 'tool-result' || p.type === 'tool_result') && typeof p.text === 'string') {
      pushEvidence(p.text)
    } else if ((p.type === 'tool' || p.type === 'tool-call' || p.type === 'tool_call') && p.state?.input) {
      // Tool inputs (commands, prompts, URLs) as evidence; walk string values
      // two levels deep instead of dumping raw JSON so empty inputs (`{}`)
      // contribute nothing.
      const input = p.state.input as Record<string, unknown>
      const scanValue = (v: unknown): void => {
        if (typeof v === 'string') pushEvidence(v)
      }
      for (const v of Object.values(input)) {
        if (typeof v === 'string') pushEvidence(v)
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const w of Object.values(v as Record<string, unknown>)) scanValue(w)
        }
      }
    }
    if (evidenceParts.join('\n').length >= 2000) break
  }
  const assistantText = evidenceParts.join('\n').slice(0, 2000)

  return {
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
  }
}
