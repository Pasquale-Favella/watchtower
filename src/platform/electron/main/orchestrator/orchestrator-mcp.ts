import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type { DelegationCallerScope, DelegationService } from '@/core/application/commands/delegation-service.js'
import type { AgentMcpEndpoint } from '@/core/ports/agent-driver.js'
import { AgentDriverError } from '@/core/ports/agent-driver.js'
import { acquireLoopbackMcp } from '@/platform/mcp/loopback-endpoint.js'
import { DelegationError, type DelegationId, type DelegationSummary } from '@/shared/schemas/delegation.js'
import {
  DELEGATION_TOOL_SUMMARY_MAX_CHARS,
  delegationToolCancelInputSchema,
  delegationToolCapabilitiesOutputSchema,
  delegationToolErrorSchema,
  delegationToolListInputSchema,
  delegationToolListOutputSchema,
  delegationToolNoInputSchema,
  delegationToolStartInputSchema,
  delegationToolStatusInputSchema,
  type DelegationToolSummary,
} from '@/shared/schemas/delegation-tools.js'

/**
 * The `watchtower-orchestrator` MCP server. One endpoint is bound to one Agent Run at dispatch time, so the caller
 * identity comes from the endpoint, never from tool arguments. Each tool's Effect Schema validates its arguments and
 * is the source of its advertised JSON Schema. Errors are typed tool results, never thrown past the transport.
 */

const TOOLS = [
  {
    name: 'delegation_capabilities',
    description: 'List connections, their access modes, this run access mode, and remaining delegation capacity.',
    input: delegationToolNoInputSchema,
  },
  {
    name: 'delegation_start',
    description:
      'Start a delegated task. The child sees only `task`, not your conversation, so write it complete. Completion wakes this run; do not poll. Keep the returned id. Never put secrets in `task`.',
    input: delegationToolStartInputSchema,
  },
  {
    name: 'delegation_status',
    description: 'Read one delegation you started. A settled result is marked read.',
    input: delegationToolStatusInputSchema,
  },
  {
    name: 'delegation_list',
    description: 'List delegations this task started, newest first.',
    input: delegationToolListInputSchema,
  },
  {
    name: 'delegation_cancel',
    description: 'Stop one delegation and its child run. A settled delegation keeps its result.',
    input: delegationToolCancelInputSchema,
  },
] as const

type ToolName = (typeof TOOLS)[number]['name']

/** The advertised JSON Schema comes from the same Effect Schema that validates the call. */
const advertised = TOOLS.map(tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    ...Schema.toStandardJSONSchemaV1(tool.input)['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
    type: 'object' as const,
  },
}))

/** Executes an Effect for this Node callback boundary. The composition root supplies it, so this module runs no Effects itself. */
export type OrchestrationRunner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>

export interface OrchestratorMcpScope {
  readonly caller: DelegationCallerScope
  readonly delegations: DelegationService['Service']
  readonly run: OrchestrationRunner
  readonly signal: AbortSignal
}

const toolError = (code: string, message: string) => {
  const payload = Schema.decodeUnknownResult(delegationToolErrorSchema)({ code, message })
  const body = payload._tag === 'Success' ? payload.success : { code: 'unavailable', message: 'Delegation is unavailable.' }
  return { isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify(body) }] }
}

const unavailable = () => toolError('unavailable', 'Delegation is unavailable.')

/** The compact view a parent reads. The full task and any transcript never appear here. */
function summaryView(summary: DelegationSummary): DelegationToolSummary {
  const result = summary.resultText ?? undefined
  return {
    id: summary.delegationId,
    childTaskId: summary.childTaskId,
    title: summary.title,
    status: summary.status,
    connection: summary.connectionId,
    accessMode: summary.accessMode,
    ...(summary.accessModeSteppedDownFrom ? { steppedDownFrom: summary.accessModeSteppedDownFrom } : {}),
    ...(summary.pendingRequest ? { pending: summary.pendingRequest.kind } : {}),
    ...(result !== undefined
      ? { summary: result.slice(0, DELEGATION_TOOL_SUMMARY_MAX_CHARS), truncated: summary.resultTruncated || result.length > DELEGATION_TOOL_SUMMARY_MAX_CHARS }
      : {}),
    ...(summary.waitTimedOut ? { waitTimedOut: true } : {}),
    ...(summary.cancelRequested ? { cancelRequested: true } : {}),
    ...(summary.next ? { next: summary.next } : {}),
  }
}

/** Runs one call against the bound caller. A DelegationError becomes a typed tool error with its code. */
function invoke(scope: OrchestratorMcpScope, name: ToolName, input: unknown): Effect.Effect<unknown, unknown> {
  const { caller, delegations } = scope
  switch (name) {
    case 'delegation_capabilities':
      return delegations.capabilities(caller).pipe(
        Effect.map(capabilities => ({
          accessMode: capabilities.parentAccessMode,
          remaining: capabilities.remainingDepth,
          active: capabilities.activeCount,
          maxActive: capabilities.maxActive,
          connections: capabilities.connections.map(connection => ({
            connection: connection.connectionId,
            label: connection.label,
            accessModes: connection.accessModes,
            models: connection.models.slice(0, 20).map(model => ({
              id: model.id,
              label: model.label,
              ...(model.modes ? { efforts: model.modes.map(mode => mode.id) } : {}),
            })),
            modelsKnown: connection.modelsKnown,
          })),
        })),
      )
    case 'delegation_start': {
      const request = input as Schema.Schema.Type<typeof delegationToolStartInputSchema>
      return delegations
        .start(caller, {
          task: request.task,
          title: request.title,
          target: request.target
            ? {
                connectionId: request.target.connection,
                modelId: request.target.model,
                modeId: request.target.effort,
              }
            : undefined,
          isolation: request.isolation,
          accessMode: request.accessMode,
          wait: request.mode === 'wait',
          waitTimeoutMs: request.timeoutMs ?? 30_000,
          clientRequestId: request.clientRequestId,
        })
        .pipe(Effect.map(summaryView))
    }
    case 'delegation_status': {
      const request = input as Schema.Schema.Type<typeof delegationToolStatusInputSchema>
      // The id is an opaque string from the parent; ownership is checked by the service, not by the brand.
      return delegations
        .status(caller, request.id as DelegationId)
        .pipe(Effect.map(summaryView))
    }
    case 'delegation_list': {
      const request = input as Schema.Schema.Type<typeof delegationToolListInputSchema>
      return delegations.list(caller, request.limit ?? 20).pipe(
        Effect.map(listing => ({ items: listing.items.map(summaryView), truncated: listing.truncated })),
      )
    }
    case 'delegation_cancel': {
      const request = input as Schema.Schema.Type<typeof delegationToolCancelInputSchema>
      return delegations.cancel(caller, request.id as DelegationId).pipe(Effect.map(summaryView))
    }
  }
}

/** Validates the decoded output against its schema, so the wire shape cannot drift from the contract. */
function validatedOutput(name: ToolName, value: unknown): unknown {
  const schema =
    name === 'delegation_capabilities'
      ? delegationToolCapabilitiesOutputSchema
      : name === 'delegation_list'
        ? delegationToolListOutputSchema
        : undefined
  if (!schema) return value
  const decoded = Schema.decodeUnknownResult(schema)(value)
  return decoded._tag === 'Success' ? decoded.success : value
}

async function callTool(scope: OrchestratorMcpScope, name: string, args: unknown) {
  const tool = TOOLS.find(item => item.name === name)
  if (!tool) return toolError('invalid-request', 'Unknown orchestration tool.')
  if (scope.signal.aborted) return toolError('unavailable', 'This run can no longer delegate.')
  const decoded = Schema.decodeUnknownResult(tool.input)(args ?? {})
  if (decoded._tag === 'Failure') return toolError('invalid-request', 'Invalid arguments. Check the tool schema.')
  const outcome = await scope
    .run(
      invoke(scope, tool.name, decoded.success).pipe(
        Effect.map(value => ({ ok: true as const, value: validatedOutput(tool.name, value) })),
        Effect.catch(error =>
          Effect.succeed({
            ok: false as const,
            error: error instanceof DelegationError ? { code: error.code, message: error.message } : null,
          }),
        ),
      ),
    )
    .catch(() => ({ ok: false as const, error: null }))
  if (!outcome.ok) return outcome.error ? toolError(outcome.error.code, outcome.error.message) : unavailable()
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(outcome.value) }],
    structuredContent: outcome.value as Record<string, unknown>,
  }
}

export function createOrchestratorMcpServer(scope: OrchestratorMcpScope): Server {
  const server = new Server({ name: 'watchtower-orchestrator', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // The start tool is hidden once no depth remains, so a child never sees a tool it cannot use.
    const capabilities = await scope.run(scope.delegations.capabilities(scope.caller)).catch(() => null)
    const hideStart = capabilities !== null && capabilities.remainingDepth < 1
    return { tools: advertised.filter(tool => !(hideStart && tool.name === 'delegation_start')) }
  })
  server.setRequestHandler(CallToolRequestSchema, (request) => callTool(scope, request.params.name, request.params.arguments))
  return server
}

/** One loopback endpoint per dispatch, bound to the Run that owns it and released with its connection scope. */
export const acquireOrchestratorMcp = Effect.fn('acquireOrchestratorMcp')(function* (scope: {
  readonly caller: DelegationCallerScope
  readonly delegations: DelegationService['Service']
  readonly run: OrchestrationRunner
}): Effect.fn.Return<AgentMcpEndpoint, AgentDriverError, Scope.Scope> {
  const endpoint = yield* acquireLoopbackMcp({
    createServer: signal => createOrchestratorMcpServer({ ...scope, signal }),
    runRequest: request => scope.run(request),
    startFailure: 'The orchestration connection could not start.',
  })
  return { name: 'watchtower-orchestrator' as const, ...endpoint }
})
