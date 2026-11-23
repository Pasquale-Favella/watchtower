import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'

import type { DelegationService } from '@/core/application/commands/delegation-service.js'
import { acquireOrchestratorMcp } from '@/platform/electron/main/orchestrator/orchestrator-mcp.js'
import { DelegationError, type DelegationSummary } from '@/shared/schemas/delegation.js'

const caller = {
  projectId: 'p-1',
  taskId: 't-1',
  conversationId: 'c-1',
  runId: 'r-1',
  accessMode: 'auto' as const,
} as never

const summary: DelegationSummary = {
  delegationId: 'dlg-1' as never,
  childTaskId: 'task-1' as never,
  title: 'Audit',
  status: 'running',
  settled: false,
  cancelRequested: false,
  connectionId: 'codex-1',
  modelId: null,
  accessMode: 'approval-required',
  accessModeSteppedDownFrom: null,
  isolation: 'shared',
  pendingRequest: null,
  resultText: null,
  resultTruncated: false,
  waitTimedOut: false,
  next: 'Completion wakes this run. Do not poll; continue other work or end your turn.',
}

function fakeDelegations(remainingDepth: number) {
  const start = vi.fn(() => Effect.succeed(summary))
  const models = Array.from({ length: 25 }, (_, index) => ({ id: `opencode/model-${index}`, label: `Model ${index}` }))
  const capabilities = vi.fn((_caller: unknown, _search?: string) =>
    Effect.succeed({
      parentAccessMode: 'auto',
      depth: 0,
      remainingDepth,
      activeCount: 1,
      maxActive: 4,
      connections: [
        {
          connectionId: 'opencode-1',
          label: 'OpenCode',
          driverId: 'acp',
          accessModes: ['approval-required'],
          models,
          modelCount: 449,
          modelsKnown: true,
        },
      ],
    }),
  )
  const service = {
    capabilities,
    start,
    status: (...args: ReadonlyArray<unknown>) =>
      args[1] === 'dlg-missing'
        ? Effect.fail(new DelegationError({ code: 'not-found', message: 'Delegation was not found.' }))
        : Effect.succeed(summary),
    list: () => Effect.succeed({ items: [summary], truncated: false }),
    cancel: () => Effect.succeed({ ...summary, status: 'cancelled', settled: true, cancelRequested: true }),
  } as unknown as DelegationService['Service']
  return { service, start, capabilities }
}

async function withEndpoint<A>(
  delegations: DelegationService['Service'],
  use: (url: string, token: string) => Promise<A>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* acquireOrchestratorMcp({
          caller,
          delegations,
          run: effect => Effect.runPromise(effect),
        })
        return yield* Effect.promise(() => use(endpoint.url, endpoint.token))
      }),
    ),
  )
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'watchtower-orchestrator-test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  )
  return client
}

function text(result: unknown): string {
  const content = (result as { content?: ReadonlyArray<{ type: string; text?: string }> }).content ?? []
  return content.find(part => part.type === 'text')?.text ?? ''
}

describe('watchtower-orchestrator endpoint', () => {
  it('refuses requests without the endpoint bearer token', async () => {
    const { service } = fakeDelegations(1)
    const status = await withEndpoint(service, async url => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      return response.status
    })
    expect(status).toBeGreaterThanOrEqual(400)
  })

  it('advertises the tools only while delegation depth remains', async () => {
    const roomy = fakeDelegations(1)
    const names = await withEndpoint(roomy.service, async (url, token) => {
      const client = await connect(url, token)
      const listed = await client.listTools()
      await client.close()
      return listed.tools.map(tool => tool.name)
    })
    expect(names.sort()).toEqual([
      'delegation_cancel',
      'delegation_capabilities',
      'delegation_read',
      'delegation_send',
      'delegation_start',
      'delegation_status',
    ])

    const exhausted = fakeDelegations(0)
    const withoutStart = await withEndpoint(exhausted.service, async (url, token) => {
      const client = await connect(url, token)
      const listed = await client.listTools()
      await client.close()
      return listed.tools.map(tool => tool.name)
    })
    expect(withoutStart).toEqual([])
  })

  it('reports free slots, not depth, and counts the models past the short list', async () => {
    const { service, capabilities } = fakeDelegations(1)
    const result = await withEndpoint(service, async (url, token) => {
      const client = await connect(url, token)
      const called = await client.callTool({ name: 'delegation_capabilities', arguments: { search: 'flint free' } })
      await client.close()
      return called
    })
    expect(capabilities.mock.calls[0]?.[1]).toBe('flint free')
    const body = JSON.parse(text(result)) as Record<string, unknown> & { connections: Array<Record<string, unknown>> }
    expect(body).toMatchObject({ available: 3, active: 1, maxActive: 4 })
    expect(body).not.toHaveProperty('remaining')
    expect(body.connections[0]?.['models']).toHaveLength(20)
    expect(body.connections[0]?.['moreModels']).toBe(429)
  })

  it('loads only the entry tools up front where a harness defers MCP tools', async () => {
    const { service } = fakeDelegations(1)
    const tools = await withEndpoint(service, async (url, token) => {
      const client = await connect(url, token)
      const listed = await client.listTools()
      await client.close()
      return listed.tools
    })
    const alwaysLoaded = tools.filter(tool => tool._meta?.['anthropic/alwaysLoad'] === true).map(tool => tool.name)
    expect(alwaysLoaded.sort()).toEqual(['delegation_capabilities', 'delegation_start'])
  })

  it('binds the caller from the endpoint, so arguments cannot name another task', async () => {
    const { service, start } = fakeDelegations(1)
    const result = await withEndpoint(service, async (url, token) => {
      const client = await connect(url, token)
      const called = await client.callTool({
        name: 'delegation_start',
        arguments: { task: 'Check the build', taskId: 'someone-else', runId: 'other-run' },
      })
      await client.close()
      return called
    })
    expect(result.isError).toBeFalsy()
    expect(start).toHaveBeenCalledTimes(1)
    const [boundCaller, request] = start.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>]
    expect(boundCaller['taskId']).toBe('t-1')
    expect(boundCaller['runId']).toBe('r-1')
    expect(request).toMatchObject({ task: 'Check the build', wait: false })
    expect(request).not.toHaveProperty('taskId')
    expect(JSON.parse(text(result))).toMatchObject({ id: 'dlg-1', childTaskId: 'task-1', status: 'running' })
  })

  it('returns delegation errors as typed tool errors without stack text', async () => {
    const { service } = fakeDelegations(1)
    const result = await withEndpoint(service, async (url, token) => {
      const client = await connect(url, token)
      const called = await client.callTool({ name: 'delegation_status', arguments: { id: 'dlg-missing' } })
      await client.close()
      return called
    })
    expect(result.isError).toBe(true)
    expect(JSON.parse(text(result))).toEqual({ code: 'not-found', message: 'Delegation was not found.' })
    expect(text(result)).not.toContain('at ')
  })

  it('rejects invalid arguments as a typed tool error', async () => {
    const { service, start } = fakeDelegations(1)
    const result = await withEndpoint(service, async (url, token) => {
      const client = await connect(url, token)
      const called = await client.callTool({ name: 'delegation_start', arguments: { mode: 'wait' } })
      await client.close()
      return called
    })
    expect(result.isError).toBe(true)
    expect(JSON.parse(text(result))).toMatchObject({ code: 'invalid-request' })
    expect(start).not.toHaveBeenCalled()
  })
})
