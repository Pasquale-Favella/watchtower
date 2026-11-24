import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type DelegationCallerScope, DelegationService } from '@/core/application/commands/delegation-service.js'
import { ExecutionService } from '@/core/application/commands/execution-service.js'
import { DelegationCoordinator } from '@/core/application/execution/delegation-coordinator.js'
import { AgentDriver } from '@/core/ports/agent-driver.js'
import { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { acquireOrchestratorMcp } from '@/platform/electron/main/orchestrator/orchestrator-mcp.js'
import {
  delegationToolCancelInputSchema,
  delegationToolCapabilitiesInputSchema,
  delegationToolReadInputSchema,
  delegationToolSendInputSchema,
  delegationToolStartInputSchema,
  delegationToolStatusInputSchema,
} from '@/shared/schemas/delegation-tools.js'
import type { BeginRunCommand } from '@/shared/schemas/workspace-store.js'

const ts = '2026-10-29T10:00:00Z'
const project = { id: 'p-1' as never, name: 'Project', repositoryIdentity: 'repo:one', createdAt: ts, updatedAt: ts }
const checkout = {
  id: 'co-1' as never,
  kind: 'main' as const,
  path: 'C:/repo',
  createdAt: ts,
  branch: 'feature/parent',
}
const parentTask = { id: 't-parent' as never, projectId: project.id, title: 'Parent', description: '', createdAt: ts }
const parentConversation = { id: 'c-parent' as never, title: 'Parent chat', createdAt: ts }
const parentCommand: BeginRunCommand = {
  commandId: 'cmd-parent',
  issuedAt: ts,
  runId: 'run-parent' as never,
  taskId: parentTask.id,
  conversationId: parentConversation.id,
  checkoutId: checkout.id,
  provisionalAgentSessionId: 'session-parent',
  generation: 1,
  driverId: 'codex-app-server',
  connectionId: 'codex-1',
  modelId: 'gpt-5',
  prompt: 'Coordinate the audit',
}
const parentCaller: DelegationCallerScope = {
  projectId: project.id,
  taskId: parentTask.id,
  conversationId: parentConversation.id,
  runId: parentCommand.runId,
  accessMode: 'auto',
}
const catalog = [
  {
    id: 'codex-1',
    label: 'Codex',
    driverId: 'codex-app-server',
    models: [{ id: 'gpt-5', label: 'GPT-5', modes: [{ id: 'high', label: 'High' }] }],
  },
]

/** Drives a Run through claim and acceptance, the path the execution service takes before a Run is live. */
const acceptRun = (store: WorkspaceStore['Service'], command: BeginRunCommand) =>
  Effect.gen(function* () {
    yield* store.beginRun(command)
    yield* store.claimDispatch(command.runId, 7, ts)
    yield* store.acknowledgeDispatch(command.runId, {
      ownerEpoch: 7,
      nativeSessionId: `native-${command.runId}`,
      nativeTurnId: 'native-turn',
      acknowledgedAt: ts,
    })
  })

const childCallerOf = (command: BeginRunCommand): DelegationCallerScope => ({
  projectId: project.id,
  taskId: command.taskId,
  conversationId: command.conversationId,
  runId: command.runId,
  accessMode: 'auto',
})

const expectedSchema = (schema: Parameters<typeof Schema.toStandardJSONSchemaV1>[0]) => ({
  ...Schema.toStandardJSONSchemaV1(schema)['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
  type: 'object',
})

type ToolResult = {
  readonly isError?: boolean
  readonly structuredContent?: Record<string, unknown>
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

const errorCodeOf = (result: ToolResult): string | undefined => {
  const text = result.content[0]?.text
  return text ? (JSON.parse(text) as { code?: string }).code : undefined
}

/** The real delegation services over a temp SQLite file; execution accepts each child Run and records it. */
function buildRuntime(filename: string) {
  const storeLayer = WorkspaceStoreLive({ filename })
  const registry = Layer.succeed(
    AgentDriverRegistry,
    AgentDriverRegistry.fromDrivers([
      AgentDriver.of({
        driverId: 'codex-app-server',
        connect: () => Effect.die('connect is not used by the live delegation test'),
        accessModes: ['approval-required', 'auto-accept-edits'],
      }),
      AgentDriver.of({
        driverId: 'acp',
        connect: () => Effect.die('connect is not used by the live delegation test'),
      }),
    ]),
  )
  const execution = Layer.effect(
    ExecutionService,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceStore
      return ExecutionService.of({
        start: (command: BeginRunCommand) =>
          acceptRun(workspace, command).pipe(
            Effect.tap(() => Effect.sync(() => starts.push(command))),
            Effect.as({} as never),
          ),
        interrupt: () => Effect.void,
        cancelQueuedFollowUp: () => Effect.void,
        enqueueFollowUp: () => Effect.succeed({} as never),
      } as unknown as ExecutionService['Service'])
    }),
  ).pipe(Layer.provideMerge(Layer.merge(storeLayer, registry)))
  const service = DelegationService.layer({ loadConnections: () => Effect.succeed(catalog) }).pipe(
    Layer.provideMerge(DelegationCoordinator.layer),
    Layer.provideMerge(execution),
  )
  return ManagedRuntime.make(service)
}

let dir = ''
let runtime: ReturnType<typeof buildRuntime>
let store: WorkspaceStore['Service']
const starts: BeginRunCommand[] = []
let parentClient: Client
let parentEndpoint: { url: string; token: string }
let parentChildId = ''
let parentDelegationId = ''
let settledDelegationId = ''
let cancelledDelegationId = ''
const clients: Client[] = []
const endpointScopes: Scope.Closeable[] = []

const callTool = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>

const connect = async (endpoint: { url: string; token: string }): Promise<Client> => {
  const client = new Client({ name: 'live-delegation-test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
    }),
  )
  clients.push(client)
  return client
}

const bindEndpoint = async (caller: DelegationCallerScope) => {
  const scope = await runtime.runPromise(Scope.make())
  endpointScopes.push(scope)
  const delegations = await runtime.runPromise(DelegationService)
  return runtime.runPromise(
    acquireOrchestratorMcp({
      caller,
      delegations,
      run: effect => runtime.runPromise(effect),
    }).pipe(Scope.provide(scope)),
  )
}

const settleChild = (command: BeginRunCommand, terminal: 'turnCompleted') =>
  Effect.gen(function* () {
    const coordinator = yield* DelegationCoordinator
    const event = (eventId: string, body: Parameters<WorkspaceStore['Service']['recordDriverEvent']>[1]['event']) =>
      store.recordDriverEvent(command.runId, { ownerEpoch: 7, generation: 1, eventId, occurredAt: ts, event: body })
    yield* event('child-start', { kind: 'turnStarted', nativeTurnId: 'native-turn' })
    yield* event('child-text', { kind: 'textDelta', text: 'Audit done' })
    yield* event('child-terminal', { kind: terminal, nativeTurnId: 'native-turn' })
    yield* coordinator.runFinished({ runId: command.runId, taskId: command.taskId })
  })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'watchtower-orchestrator-live-'))
  runtime = buildRuntime(join(dir, 'workspace.db'))
  store = await runtime.runPromise(WorkspaceStore)
  await runtime.runPromise(store.registerProject({ project, mainCheckout: checkout }))
  await runtime.runPromise(store.createTask({ task: parentTask, conversation: parentConversation }))
  await runtime.runPromise(acceptRun(store, parentCommand))
  const endpoint = await bindEndpoint(parentCaller)
  parentEndpoint = endpoint
  parentClient = await connect(endpoint)
}, 60_000)

afterAll(async () => {
  await Promise.allSettled(clients.map(client => client.close()))
  for (const scope of endpointScopes) await runtime.runPromise(Scope.close(scope, Exit.void))
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('orchestrator MCP endpoint over the real delegation service', () => {
  it('advertises the Effect-generated Standard JSON Schemas for every tool', async () => {
    const listed = await parentClient.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'delegation_capabilities',
      'delegation_start',
      'delegation_status',
      'delegation_read',
      'delegation_send',
      'delegation_cancel',
    ])
    const byName = new Map(listed.tools.map(tool => [tool.name, tool]))
    expect(byName.get('delegation_capabilities')?.inputSchema).toEqual(
      expectedSchema(delegationToolCapabilitiesInputSchema),
    )
    expect(byName.get('delegation_start')?.inputSchema).toEqual(expectedSchema(delegationToolStartInputSchema))
    expect(byName.get('delegation_status')?.inputSchema).toEqual(expectedSchema(delegationToolStatusInputSchema))
    expect(byName.get('delegation_read')?.inputSchema).toEqual(expectedSchema(delegationToolReadInputSchema))
    expect(byName.get('delegation_send')?.inputSchema).toEqual(expectedSchema(delegationToolSendInputSchema))
    expect(byName.get('delegation_cancel')?.inputSchema).toEqual(expectedSchema(delegationToolCancelInputSchema))
  }, 30_000)

  it('reports connections and unlimited delegation through delegation_capabilities', async () => {
    const result = await callTool(parentClient, 'delegation_capabilities')
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ accessMode: 'auto', available: 'unlimited' })
    expect(result.structuredContent?.['connections']).toEqual([
      expect.objectContaining({ connection: 'codex-1', label: 'Codex' }),
    ])
  }, 30_000)

  it('starts a child as its own Task without waiting, then reads and lists it', async () => {
    const result = await callTool(parentClient, 'delegation_start', { task: 'Audit the parser', title: 'Audit' })
    expect(result.isError).toBeFalsy()
    const summary = result.structuredContent as { id: string; childTaskId: string; status: string }
    parentDelegationId = summary.id
    parentChildId = summary.childTaskId
    expect(summary.status).toBe('running')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.taskId).toBe(parentChildId)
    expect(starts[0]?.taskId).not.toBe(parentTask.id)

    const status = await callTool(parentClient, 'delegation_status', { id: parentDelegationId })
    expect(status.structuredContent).toMatchObject({ id: parentDelegationId, status: 'running' })

    const listed = await callTool(parentClient, 'delegation_status', {})
    expect(listed.structuredContent?.['items']).toEqual([expect.objectContaining({ id: parentDelegationId })])
  }, 30_000)

  it('wakes the parent with the captured result when the child settles', async () => {
    const result = await callTool(parentClient, 'delegation_start', { task: 'Audit the lexer', title: 'Lexer' })
    settledDelegationId = (result.structuredContent as { id: string }).id
    const child = starts[1]
    if (!child) throw new Error('The second delegation did not launch a child Run')
    await runtime.runPromise(settleChild(child, 'turnCompleted'))

    const status = await callTool(parentClient, 'delegation_status', { id: settledDelegationId })
    expect(status.structuredContent).toMatchObject({ status: 'completed', summary: 'Audit done' })
    const record = await runtime.runPromise(store.getDelegation(settledDelegationId as never))
    expect(record).toMatchObject({ status: 'completed', wakeState: 'pending' })
  }, 30_000)

  it('cancels a running delegation and keeps it cancelled', async () => {
    const result = await callTool(parentClient, 'delegation_start', { task: 'Audit the cache', title: 'Cache' })
    cancelledDelegationId = (result.structuredContent as { id: string }).id
    const cancelled = await callTool(parentClient, 'delegation_cancel', { id: cancelledDelegationId })
    expect(cancelled.isError).toBeFalsy()
    expect(cancelled.structuredContent).toMatchObject({ id: cancelledDelegationId, cancelRequested: true })
    // A claimed child settles as cancelled only once its Run reports back; until then the request is recorded.
    const status = await callTool(parentClient, 'delegation_status', { id: cancelledDelegationId })
    expect(status.structuredContent).toMatchObject({ status: 'running', cancelRequested: true })
  }, 30_000)

  it('blocks a wait-mode start up to its timeout and reports the timeout on the result', async () => {
    const result = await callTool(parentClient, 'delegation_start', {
      task: 'Audit the indexer',
      title: 'Indexer',
      mode: 'wait',
      timeoutMs: 50,
    })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ status: 'running', waitTimedOut: true })
    expect(starts.at(-1)?.taskId).not.toBe(parentTask.id)
  }, 30_000)

  it('returns typed error codes for not-found, depth and escalation', async () => {
    const missing = await callTool(parentClient, 'delegation_status', { id: 'dlg-missing' })
    expect(missing.isError).toBe(true)
    expect(errorCodeOf(missing)).toBe('not-found')

    const waitingChild = starts[2]
    if (!waitingChild) throw new Error('The wait-mode delegation did not launch a child Run')
    const childEndpoint = await bindEndpoint(childCallerOf(waitingChild))
    const childClient = await connect(childEndpoint)
    const depth = await callTool(childClient, 'delegation_start', { task: 'Nested audit' })
    expect(depth.isError).toBe(true)
    expect(errorCodeOf(depth)).toBe('depth-exceeded')

    const approvalEndpoint = await bindEndpoint({ ...parentCaller, accessMode: 'approval-required' })
    const approvalClient = await connect(approvalEndpoint)
    const escalated = await callTool(approvalClient, 'delegation_start', {
      task: 'Escalated audit',
      accessMode: 'auto-accept-edits',
    })
    expect(escalated.isError).toBe(true)
    expect(errorCodeOf(escalated)).toBe('access-escalation-denied')
  }, 30_000)

  it('serves the same tools and results through the stdio proxy entry', async () => {
    const outfile = join(dir, 'orchestrator-mcp-proxy.cjs')
    await build({
      entryPoints: [resolve('src/platform/mcp/orchestrator-proxy-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      logLevel: 'silent',
    })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [outfile],
      env: {
        WATCHTOWER_ORCHESTRATOR_MCP_URL: parentEndpoint.url,
        WATCHTOWER_ORCHESTRATOR_MCP_TOKEN: parentEndpoint.token,
      },
    })
    const proxy = new Client({ name: 'live-delegation-stdio-test', version: '1.0.0' })
    clients.push(proxy)
    await proxy.connect(transport)

    const listed = await proxy.listTools()
    expect(listed.tools.map(tool => tool.name)).toContain('delegation_start')
    const capabilities = await callTool(proxy, 'delegation_capabilities')
    expect(capabilities.structuredContent).toMatchObject({ accessMode: 'auto', available: 'unlimited' })
    const missing = await callTool(proxy, 'delegation_status', { id: 'dlg-missing' })
    expect(errorCodeOf(missing)).toBe('not-found')
    await proxy.close()
  }, 60_000)
})
