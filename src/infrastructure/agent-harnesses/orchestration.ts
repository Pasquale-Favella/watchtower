import * as Schema from 'effect/Schema'

import type { AgentAccessMode, AgentToolMetadata } from '@/shared/schemas/execution.js'

/** The server name every harness registers the orchestrator endpoint under. */
export const ORCHESTRATOR_MCP_SERVER = 'watchtower-orchestrator'

const TOOL_PREFIX = 'delegation_'

/** Tools that only read delegation state. Drivers may allow them without an approval prompt. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'delegation_capabilities',
  'delegation_status',
  'delegation_read',
  'delegation_list',
])

/** Claude names MCP tools `mcp__<server>__<tool>`. */
const claudePrefix = `mcp__${ORCHESTRATOR_MCP_SERVER}__`
export const claudeOrchestratorToolName = (tool: string): string => `${claudePrefix}${tool}`

export const isClaudeOrchestratorTool = (name: string): boolean => name.startsWith(`${claudePrefix}${TOOL_PREFIX}`)

export const isClaudeReadOnlyOrchestratorTool = (name: string): boolean =>
  name.startsWith(claudePrefix) && READ_ONLY_TOOLS.has(name.slice(claudePrefix.length))

/** Codex reports the MCP server on each tool item. */
export const isCodexOrchestratorTool = (server: string | undefined, tool: string | undefined): boolean =>
  server === ORCHESTRATOR_MCP_SERVER && tool !== undefined && tool.startsWith(TOOL_PREFIX)

const referenceOutput = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, childTaskId: Schema.optionalKey(Schema.String) }),
)

/**
 * The delegation a successful orchestration tool result describes. Error results carry no `id`, so they yield
 * nothing and never link a timeline row to a Delegation.
 */
export function orchestrationReference(output: string | undefined): AgentToolMetadata['orchestration'] {
  if (output === undefined) return undefined
  const decoded = Schema.decodeUnknownOption(referenceOutput)(output)
  if (decoded._tag === 'None') return undefined
  return {
    delegationId: decoded.value.id,
    ...(decoded.value.childTaskId !== undefined ? { childTaskId: decoded.value.childTaskId } : {}),
  }
}

const referenceObject = Schema.Struct({ id: Schema.String, childTaskId: Schema.optionalKey(Schema.String) })
const mcpWrapped = Schema.Struct({
  structuredContent: Schema.optionalKey(referenceObject),
  content: Schema.optionalKey(Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))),
})

/**
 * The same reference from a raw ACP tool output. Agents report either the tool's own JSON, an MCP result with
 * `structuredContent`, or an MCP result whose text part holds the JSON.
 */
export function orchestrationReferenceFromRaw(raw: unknown): AgentToolMetadata['orchestration'] {
  if (typeof raw === 'string') return orchestrationReference(raw)
  const direct = Schema.decodeUnknownOption(referenceObject)(raw)
  if (direct._tag === 'Some')
    return {
      delegationId: direct.value.id,
      ...(direct.value.childTaskId !== undefined ? { childTaskId: direct.value.childTaskId } : {}),
    }
  const wrapped = Schema.decodeUnknownOption(mcpWrapped)(raw)
  if (wrapped._tag === 'None') return undefined
  if (wrapped.value.structuredContent)
    return {
      delegationId: wrapped.value.structuredContent.id,
      ...(wrapped.value.structuredContent.childTaskId !== undefined
        ? { childTaskId: wrapped.value.structuredContent.childTaskId }
        : {}),
    }
  const text = wrapped.value.content?.find(part => part.text !== undefined)?.text
  return orchestrationReference(text)
}

const ORCHESTRATOR_TOOLS = [
  'delegation_capabilities',
  'delegation_start',
  'delegation_status',
  'delegation_read',
  'delegation_send',
  'delegation_cancel',
  // Kept so a call recorded before status absorbed the listing still reads as an orchestration call.
  'delegation_list',
] as const

/**
 * ACP reports an MCP tool by its title: the bare tool name, or the name with its server prefixed the way the agent
 * writes it (`watchtower-orchestrator: delegation_start`, `mcp__watchtower-orchestrator__delegation_start`,
 * `watchtower-orchestrator_delegation_start`), optionally followed by a parenthesised note. Any other title is not an
 * orchestration tool.
 */
const ORCHESTRATOR_TOOL_TITLE = new RegExp(
  `^(?:(?:mcp__)?watchtower[-_]orchestrator(?:__|_|\\s*[:/.]\\s*))?(${ORCHESTRATOR_TOOLS.join('|')})(?:\\s*\\([^)]*\\))?$`,
)

export const isOrchestratorToolTitle = (title: string | null | undefined): boolean =>
  typeof title === 'string' && ORCHESTRATOR_TOOL_TITLE.test(title.trim())

/** An ACP title that names a read-only orchestration tool. */
export const isReadOnlyOrchestratorToolTitle = (title: string | null | undefined): boolean =>
  typeof title === 'string' && READ_ONLY_TOOLS.has(ORCHESTRATOR_TOOL_TITLE.exec(title.trim())?.[1] ?? '')

/**
 * Whether a Run may call orchestration tools without a prompt. Delegation never widens a child past its parent's
 * access, so only approval-required asks, and even then not for the tools that only read delegation state.
 */
export const orchestrationAutoApproved = (accessMode: AgentAccessMode): boolean => accessMode !== 'approval-required'
