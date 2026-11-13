import { tmpdir } from 'node:os'

import {
  type Agent,
  AgentSideConnection,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
  type SessionModelState,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { AgentDriver, AgentDriverError } from '../src/core/ports/agent-driver.js'
import {
  acpSpawnEnvironment,
  automaticPermission,
  layerAcpAgentDriver,
  makeAcpDriver,
} from '../src/infrastructure/agent-harnesses/drivers/acp/driver.js'
import type { JsonRpcTransport } from '../src/infrastructure/agent-harnesses/drivers/json-rpc.js'
import { agentConfigOptionSchema } from '../src/shared/schemas/execution.js'
import type { AgentRunId } from '../src/shared/schemas/workspace.js'
import {
  agentRunIdSchema,
  agentSessionIdSchema,
  conversationIdSchema,
  projectIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '../src/shared/schemas/workspace.js'

type PromptMode = 'events' | 'permission' | 'question' | 'cancel' | 'block' | 'overflow'

interface FakeAcpState {
  driver: ReturnType<typeof makeAcpDriver>
  readonly promptCalls: Array<{ readonly cwd: string; readonly prompt: string }>
  readonly newSessionCalls: number[]
  readonly loadedSessionIds: string[]
  readonly closeCalls: number[]
  readonly cancelCalls: number[]
  readonly permissionOutcomes: Array<{ readonly outcome: string; readonly optionId?: string }>
  readonly questionOutcomes: Array<unknown>
  permissionOptions?: PermissionOption[]
  blockCancelWrite: boolean
  finishPrompt?: () => void
  onPrompt?: () => void
  mode: PromptMode
  allowLoad: boolean
  /** Report OpenCode-style model and thought-level config options. */
  openCodeOptions?: boolean
  /** Report Copilot-style config options, including an empty default persona value. */
  copilotOptions?: boolean
  /** Publish reasoning effort only for the model the session is on, as OpenCode does. */
  modelDependentEffort?: boolean
  omitModeConfigOption?: boolean
  initializeMetadata?: unknown
  sessionModels?: SessionModelState
  catalogUpdates?: readonly SessionUpdate[]
  readonly configCalls: Array<{ readonly configId: string; readonly value: unknown }>
  updates?: readonly SessionUpdate[]
}

function makeFakeAcp(mode: PromptMode = 'events', allowLoad = false): FakeAcpState {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientWriter = clientToAgent.writable.getWriter()
  const state: FakeAcpState = {
    driver: undefined as unknown as ReturnType<typeof makeAcpDriver>,
    promptCalls: [],
    newSessionCalls: [],
    loadedSessionIds: [],
    closeCalls: [],
    cancelCalls: [],
    permissionOutcomes: [],
    questionOutcomes: [],
    blockCancelWrite: false,
    mode,
    allowLoad,
    configCalls: [],
  }
  let peer: AgentSideConnection | undefined
  let cancelPrompt: (() => void) | undefined
  const selectedModels = new Map<string, string>()
  const modelDependentOptions = (modelId: string) => [
    {
      type: 'select' as const,
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: modelId,
      options: [
        { name: 'OpenAI/GPT', value: 'openai/gpt' },
        { name: 'Plain/Model', value: 'plain/model' },
      ],
    },
    ...(modelId === 'openai/gpt'
      ? [
          {
            type: 'select' as const,
            id: 'effort',
            name: 'Effort',
            category: 'thought_level',
            currentValue: 'medium',
            options: [
              { name: 'Low', value: 'low' },
              { name: 'High', value: 'high' },
            ],
          },
        ]
      : []),
    {
      type: 'select' as const,
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: 'build',
      options: [
        { name: 'Build', value: 'build' },
        { name: 'Plan', value: 'plan' },
      ],
    },
  ]

  const agent: Agent = {
    authenticate: async () => ({}),
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: state.allowLoad },
      agentInfo: { name: 'fixture', version: '1' },
      ...(state.initializeMetadata !== undefined ? { _meta: state.initializeMetadata as never } : {}),
    }),
    newSession: async params => {
      state.newSessionCalls.push(state.newSessionCalls.length + 1)
      if (params.cwd !== 'C:/workspace/project' && params.cwd !== tmpdir()) throw new Error('wrong workspace path')
      const sessionId = `native-${state.newSessionCalls.length}`
      if (state.catalogUpdates) {
        for (const update of state.catalogUpdates) await peer?.sessionUpdate({ sessionId, update })
      }
      if (state.modelDependentEffort) return { sessionId, configOptions: modelDependentOptions('plain/model') }
      return {
        sessionId,
        configOptions: [
          ...(state.openCodeOptions
            ? [
                {
                  type: 'select' as const,
                  id: 'model',
                  name: 'Model',
                  category: 'model',
                  currentValue: 'anthropic/sonnet',
                  options: [
                    { name: 'Anthropic/Sonnet', value: 'anthropic/sonnet' },
                    { name: 'OpenAI/GPT', value: 'openai/gpt' },
                  ],
                },
                {
                  type: 'select' as const,
                  id: 'effort',
                  name: 'Effort',
                  category: 'thought_level',
                  currentValue: 'medium',
                  options: [
                    { name: 'Low', value: 'low' },
                    { name: 'High', value: 'high' },
                  ],
                },
                {
                  type: 'select' as const,
                  id: 'agent',
                  name: 'Agent',
                  currentValue: 'default',
                  options: [
                    {
                      group: 'agents',
                      name: 'Profiles',
                      options: [
                        { name: 'Default', value: 'default', description: 'Use the default agent.' },
                        { name: 'Subagent', value: 'subagent', description: 'Delegate this work.' },
                      ],
                    },
                  ],
                },
              ]
            : []),
          ...(state.copilotOptions
            ? [
                {
                  type: 'select' as const,
                  id: 'model',
                  name: 'Model',
                  category: 'model',
                  currentValue: 'auto',
                  options: [
                    { name: 'Auto', value: 'auto' },
                    { name: 'Auto', value: 'auto' },
                    { name: 'Claude Sonnet 5.5', value: 'claude-sonnet-5.5' },
                  ],
                },
                {
                  type: 'select' as const,
                  id: 'agent',
                  name: 'Agent',
                  category: '_agent',
                  currentValue: '',
                  options: [
                    { name: 'Copilot', value: '', description: 'Default Copilot agent' },
                    { name: 'munaciello', value: 'munaciello' },
                  ],
                },
                {
                  type: 'select' as const,
                  id: 'allow_all',
                  name: 'Allow All',
                  category: 'permissions',
                  currentValue: 'off',
                  options: [
                    { name: 'On', value: 'on' },
                    { name: 'Off', value: 'off' },
                  ],
                },
              ]
            : []),
          ...(!state.omitModeConfigOption
            ? [
                {
                  type: 'select' as const,
                  id: 'mode',
                  name: 'Mode',
                  category: 'mode',
                  currentValue: 'code',
                  options: [
                    { name: 'Code', value: 'code' },
                    { name: 'Plan', value: 'plan' },
                  ],
                },
              ]
            : []),
        ],
        ...(state.sessionModels ? { models: state.sessionModels } : {}),
        ...(state.openCodeOptions
          ? {
              modes: {
                currentModeId: 'ask',
                availableModes: [
                  { id: 'ask', name: 'Ask' },
                  { id: 'code', name: 'Code' },
                ],
              },
              ...(!state.sessionModels
                ? {
                    models: {
                      currentModelId: 'anthropic/sonnet',
                      availableModels: [
                        { modelId: 'anthropic/sonnet', name: 'Anthropic/Sonnet' },
                        { modelId: 'openai/gpt', name: 'OpenAI/GPT' },
                      ],
                    },
                  }
                : {}),
            }
          : {}),
      }
    },
    setSessionConfigOption: async params => {
      state.configCalls.push({ configId: params.configId, value: params.value })
      if (!state.modelDependentEffort || params.configId !== 'model') return { configOptions: [] }
      selectedModels.set(params.sessionId, params.value)
      return { configOptions: modelDependentOptions(params.value) }
    },
    loadSession: async params => {
      state.loadedSessionIds.push(params.sessionId)
      await peer?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } },
      })
      return state.copilotOptions
        ? {
            configOptions: [
              {
                type: 'select' as const,
                id: 'agent',
                name: 'Agent',
                category: '_agent',
                currentValue: 'munaciello',
                options: [
                  { name: 'Copilot', value: '', description: 'Default Copilot agent' },
                  { name: 'munaciello', value: 'munaciello' },
                ],
              },
            ],
          }
        : {}
    },
    prompt: async params => {
      state.promptCalls.push({ cwd: 'C:/workspace/project', prompt: JSON.stringify(params.prompt) })
      state.onPrompt?.()
      if (state.updates) {
        for (const update of state.updates) await peer?.sessionUpdate({ sessionId: params.sessionId, update })
        return { stopReason: 'end_turn' }
      }
      if (state.mode === 'events') {
        await peer?.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
        })
        await peer?.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'reasoning' } },
        })
        await peer?.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Read file',
            kind: 'read',
            status: 'in_progress',
            rawInput: { path: 'README.md' },
            locations: [{ path: 'README.md' }],
          },
        })
        await peer?.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: 'source' },
        })
        return { stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }
      }
      if (state.mode === 'permission') {
        const options: PermissionOption[] = state.permissionOptions ?? [
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ]
        const response = await peer?.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'tool-2', title: 'Run command' },
          options,
        })
        if (response) {
          state.permissionOutcomes.push({
            outcome: response.outcome.outcome,
            ...(response.outcome.outcome === 'selected' ? { optionId: response.outcome.optionId } : {}),
          })
        }
        return { stopReason: response?.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' }
      }
      if (state.mode === 'question') {
        const response = await peer?.extMethod('elicitation/create', {
          mode: 'form',
          message: 'Choose a value',
          sessionId: params.sessionId,
          requestId: 'native-question-1',
          toolCallId: 'tool-question',
          requestedSchema: {
            type: 'object',
            required: ['choice'],
            properties: {
              choice: { type: 'string', title: 'Choice', description: 'Pick one', enum: ['alpha', 'beta'] },
            },
          },
        })
        state.questionOutcomes.push(response)
        return { stopReason: response?.action === 'cancel' ? 'cancelled' : 'end_turn' }
      }
      if (state.mode === 'overflow') {
        for (let index = 0; index < 140; index += 1) {
          if (state.closeCalls.length > 0 || state.cancelCalls.length > 0) break
          await peer?.sessionUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chunk-${index}` } },
          })
        }
        return { stopReason: 'end_turn' }
      }
      await new Promise<void>(resolve => {
        if (state.mode === 'block') state.finishPrompt = resolve
        else cancelPrompt = resolve
      })
      return { stopReason: state.mode === 'block' ? 'end_turn' : 'cancelled' }
    },
    cancel: async () => {
      state.cancelCalls.push(state.cancelCalls.length + 1)
      if (state.mode !== 'block') cancelPrompt?.()
    },
  }

  const server = new AgentSideConnection(
    connection => {
      peer = connection
      return agent
    },
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  )
  void server

  const transport: JsonRpcTransport = {
    input: Stream.fromReadableStream({
      evaluate: () => agentToClient.readable,
      onError: error => new AgentDriverError({ code: 'disconnected', message: String(error) }),
    }),
    write: bytes =>
      Effect.tryPromise({
        try: () => {
          if (state.blockCancelWrite && new TextDecoder().decode(bytes).includes('session/cancel')) {
            return new Promise<void>(() => undefined)
          }
          return clientWriter.write(bytes)
        },
        catch: () => new AgentDriverError({ code: 'disconnected', message: 'fixture transport closed' }),
      }),
    close: () =>
      Effect.sync(() => {
        state.closeCalls.push(state.closeCalls.length + 1)
        void clientWriter.close().catch(() => undefined)
      }),
  }
  state.driver = makeAcpDriver({
    clientVersion: 'test',
    transportFactory: () => Effect.succeed(transport),
  })
  return state
}

function runId(value: string): AgentRunId {
  return Schema.decodeUnknownSync(agentRunIdSchema)(value)
}

const context = {
  sessionId: Schema.decodeUnknownSync(agentSessionIdSchema)('managed-session'),
  projectId: Schema.decodeUnknownSync(projectIdSchema)('project-1'),
  taskId: Schema.decodeUnknownSync(taskIdSchema)('task-1'),
  conversationId: Schema.decodeUnknownSync(conversationIdSchema)('conversation-1'),
  checkoutId: Schema.decodeUnknownSync(workspaceCheckoutIdSchema)('checkout-1'),
  workspacePath: 'C:/workspace/project',
  generation: 3,
} as const

function collectUpdates(updates: readonly SessionUpdate[]) {
  const fake = makeFakeAcp()
  fake.updates = updates
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* fake.driver.connect({ connectionId: 'acp-rich-events' })
        const session = yield* connection.openSession(context)
        const id = runId('run-rich-events')
        const submit = yield* Effect.forkScoped(
          session.submit({ runId: id, messages: [{ role: 'user', content: 'Inspect' }], attachmentIds: [] }),
        )
        const events = yield* Stream.runCollect(session.events(id))
        yield* Fiber.join(submit)
        return events
      }),
    ),
  )
}

describe('generic ACP driver', () => {
  it('keeps per-model reasoning efforts, including an explicitly empty effort list', async () => {
    const fake = makeFakeAcp()
    fake.openCodeOptions = true
    fake.sessionModels = {
      currentModelId: 'anthropic/sonnet',
      availableModels: [
        {
          modelId: 'anthropic/sonnet',
          name: 'Anthropic Sonnet',
          description: 'General coding model.',
          _meta: { reasoningEfforts: [{ id: 'low' }, { id: 'high', default: true }] },
        },
        { modelId: 'openai/gpt', name: 'OpenAI GPT', _meta: { reasoningEfforts: [] } },
      ],
    }

    const models = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-model-efforts' })
          const catalog = yield* connection.probeCatalog?.() ?? Effect.die(new Error('Missing ACP probe'))
          yield* connection.close(1000)
          return catalog.models
        }),
      ),
    )

    expect(models).toEqual([
      {
        id: 'anthropic/sonnet',
        label: 'Anthropic/Sonnet',
        description: 'General coding model.',
        modes: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' },
        ],
      },
      { id: 'openai/gpt', label: 'OpenAI/GPT', modes: [] },
    ])
  })

  it('reads ACP model and mode state from initialize metadata when sessions omit it', async () => {
    const fake = makeFakeAcp()
    fake.omitModeConfigOption = true
    fake.initializeMetadata = {
      modelState: {
        currentModelId: 'opus',
        availableModels: [
          { modelId: 'opus', name: 'Opus', _meta: { reasoningEfforts: [{ id: 'high' }] } },
          { modelId: 'plain', name: 'Plain', _meta: { reasoningEfforts: [] } },
          { modelId: 'legacy', name: 'Legacy' },
        ],
      },
      modeState: {
        currentModeId: 'plan',
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-initialize-catalog' })
          const discovered = yield* connection.discover()
          const probed = yield* connection.probeCatalog?.() ?? Effect.die(new Error('Missing ACP probe'))
          yield* connection.close(1000)
          return { discovered, probed }
        }),
      ),
    )

    expect(result.discovered.models).toEqual([
      { id: 'opus', label: 'Opus', modes: [] },
      { id: 'plain', label: 'Plain', modes: [] },
      { id: 'legacy', label: 'Legacy' },
    ])
    expect(result.discovered.modes).toEqual([
      { id: 'code', label: 'Code' },
      { id: 'plan', label: 'Plan' },
    ])
    expect(result.probed.models).toEqual(result.discovered.models)
    expect(result.probed.modes).toEqual(result.discovered.modes)
  })

  it('discovers available ACP commands from a disposable workspace session', async () => {
    const fake = makeFakeAcp()
    fake.catalogUpdates = [
      {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: 'Review the current changes' },
          { name: 'plan', description: 'Create a plan' },
        ],
      },
    ]

    const catalog = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-prompt-catalog' })
          if (!connection.discoverPromptCatalog)
            return yield* Effect.die(new Error('ACP must expose prompt catalog discovery'))
          const result = yield* connection.discoverPromptCatalog(context.workspacePath)
          yield* connection.close(1000)
          return result
        }),
      ),
    )

    expect(fake.newSessionCalls).toEqual([1])
    expect(catalog).toEqual({
      skills: [],
      skillsComplete: false,
      commands: [
        { name: 'review', description: 'Review the current changes' },
        { name: 'plan', description: 'Create a plan' },
      ],
    })
  })

  it('retains native plan content and all execution statuses', async () => {
    const events = await collectUpdates([
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect **the project**', priority: 'high', status: 'completed' },
          { content: 'Update the implementation', priority: 'medium', status: 'in_progress' },
          { content: 'Verify the result', priority: 'low', status: 'pending' },
        ],
      },
    ])
    expect(events).toContainEqual({
      kind: 'planUpdated',
      entries: [
        { content: 'Inspect **the project**', status: 'completed' },
        { content: 'Update the implementation', status: 'inProgress' },
        { content: 'Verify the result', status: 'pending' },
      ],
    })
  })

  it('preserves tool inputs, file locations, output replacements and execution metadata through completion', async () => {
    const events = await collectUpdates([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'shell',
        title: 'Run checks',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: ['npm', 'test'], cwd: '/project' },
        locations: [{ path: '/project/package.json' }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'shell',
        title: 'Run focused checks',
        rawInput: { command: 'npm test -- --run' },
        content: [{ type: 'content', content: { type: 'text', text: 'Running checks' } }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'shell',
        status: 'completed',
        rawOutput: { stdout: 'All checks passed', exitCode: 0, durationMs: 42 },
      },
    ])
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'toolStarted',
        toolCallId: 'shell',
        category: 'command',
        command: 'npm test',
        cwd: '/project',
        paths: ['/project/package.json'],
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'toolUpdated',
        name: 'Run focused checks',
        input: '{"command":"npm test -- --run"}',
        command: 'npm test -- --run',
        output: 'Running checks',
        append: false,
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'toolCompleted',
        output: '{"stdout":"All checks passed","exitCode":0,"durationMs":42}',
        exitCode: 0,
        durationMs: 42,
      }),
    )
    expect(events.some(event => event.kind === 'nativeNotice')).toBe(false)
  })

  it('retains completed diffs, text and inline images even when no progress update preceded completion', async () => {
    const image = 'iVBORw0KGgo='
    const events = await collectUpdates([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'edit',
        title: 'Update source',
        kind: 'edit',
        status: 'completed',
        rawInput: { path: 'src/main.ts' },
        content: [
          { type: 'content', content: { type: 'text', text: 'Updated the implementation' } },
          { type: 'diff', path: 'src/main.ts', oldText: 'before\n', newText: 'after\n' },
          { type: 'diff', path: 'src/new.ts', oldText: null, newText: 'created\n' },
          { type: 'content', content: { type: 'image', data: image, mimeType: 'image/png' } },
        ],
      },
    ])
    const completed = events.find(event => event.kind === 'toolCompleted')
    expect(completed).toMatchObject({
      name: 'Update source',
      category: 'fileWrite',
      input: '{"path":"src/main.ts"}',
      output: 'Updated the implementation',
      paths: ['src/main.ts', 'src/new.ts'],
      changes: [
        { path: 'src/main.ts', kind: 'update', diff: expect.stringContaining('-before\n+after') },
        { path: 'src/new.ts', kind: 'add', diff: expect.stringContaining('+created') },
      ],
    })
    expect(events).toContainEqual({
      kind: 'media',
      itemId: 'edit:image:3',
      mediaType: 'image/png',
      url: `data:image/png;base64,${image}`,
      alt: 'Update source',
    })
  })

  it('keeps failed tool output and deletion patches instead of reducing completion to its status', async () => {
    const events = await collectUpdates([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'remove',
        kind: 'delete',
        status: 'failed',
        title: 'Delete old file',
        rawOutput: 'Permission denied',
        content: [{ type: 'diff', path: 'old.ts', oldText: 'old\n', newText: '' }],
      },
    ])
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'toolCompleted',
        name: 'Delete old file',
        category: 'fileWrite',
        output: 'Permission denied',
        error: 'Permission denied',
        changes: [{ path: 'old.ts', kind: 'delete', diff: expect.stringContaining('-old') }],
      }),
    )
  })

  it('bounds native output and diffs and rejects unsafe or oversized inline images', async () => {
    const events = await collectUpdates([
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', uri: 'javascript:alert(1)' },
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'PHN2Zy8+', mimeType: 'image/svg+xml' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'A'.repeat(524_292), mimeType: 'image/png' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'large',
        status: 'completed',
        rawOutput: 'x'.repeat(100_000),
        content: [{ type: 'diff', path: 'large.txt', oldText: 'x'.repeat(100_000), newText: 'y'.repeat(100_000) }],
      },
    ])
    const media = events.filter(event => event.kind === 'media')
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ url: 'data:image/png;base64,aGVsbG8=' })
    const completed = events.find(event => event.kind === 'toolCompleted')
    expect(completed?.kind === 'toolCompleted' && completed.output?.length).toBe(65_536)
    expect(completed?.kind === 'toolCompleted' && completed.output).toContain('… [truncated]')
    expect(completed?.kind === 'toolCompleted' && completed.changes?.[0]?.diff?.length).toBeLessThanOrEqual(65_536)
  })

  it('marks every tool text truncation path in the final native snapshot', async () => {
    const events = await collectUpdates([
      { sessionUpdate: 'tool_call', toolCallId: 'input', title: 'Input', rawInput: { command: 'x'.repeat(100000) } },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'text',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'y'.repeat(100000) } }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'combined',
        status: 'completed',
        rawOutput: 'raw'.repeat(20000),
        content: [{ type: 'content', content: { type: 'text', text: 'content'.repeat(2000) } }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'items',
        status: 'completed',
        content: Array.from({ length: 65 }, () => ({
          type: 'content' as const,
          content: { type: 'text' as const, text: 'item' },
        })),
      },
    ])
    expect(events.find(event => event.kind === 'toolStarted' && event.toolCallId === 'input')).toMatchObject({
      input: expect.stringContaining('… [truncated]'),
    })
    for (const id of ['text', 'combined', 'items']) {
      const event = events.find(event => event.kind === 'toolCompleted' && event.toolCallId === id)
      expect(event).toMatchObject({ output: expect.stringContaining('… [truncated]') })
      expect(event?.kind === 'toolCompleted' && event.output?.length).toBeLessThanOrEqual(65536)
    }
  })

  it('sets Electron Node mode only for bundled ACP entries and clears inherited mode for PATH tools', () => {
    const scrubbed = acpSpawnEnvironment(['OPENAI_API_KEY'])
    const bundled = acpSpawnEnvironment(['OPENAI_API_KEY'], 'electron')

    expect(scrubbed.OPENAI_API_KEY).toBeUndefined()
    expect(Object.hasOwn(scrubbed, 'ELECTRON_RUN_AS_NODE')).toBe(true)
    expect(scrubbed.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(bundled.OPENAI_API_KEY).toBeUndefined()
    expect(bundled.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('keeps the default secret policy when enabling Electron Node mode', () => {
    const env = acpSpawnEnvironment(undefined, 'electron')
    const secretNames = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'XAI_API_KEY',
      'MOONSHOT_API_KEY',
      'DASHSCOPE_API_KEY',
      'QWEN_API_KEY',
      'PI_API_KEY',
    ]
    for (const name of secretNames) {
      expect(Object.hasOwn(env, name)).toBe(true)
      expect(env[name]).toBeUndefined()
    }
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it.each([undefined, 'C:/app/electron.exe'])(
    'rejects untrusted Electron Node mode before spawn with runtime %s',
    async runtimeExecutable => {
      const spawned: ChildProcess.Command[] = []
      const spawner = ChildProcessSpawner.make(command => {
        spawned.push(command)
        return Effect.die(new Error('Untrusted runtime must not spawn'))
      })
      await expect(
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const driver = yield* AgentDriver
              return yield* driver.connect({
                connectionId: 'untrusted',
                configuration: { command: 'arbitrary-binary', argsJson: '[]', nodeRuntime: 'electron' },
              })
            }).pipe(
              Effect.provide(layerAcpAgentDriver(runtimeExecutable ? { runtimeExecutable } : {})),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ),
        ),
      ).rejects.toMatchObject({ _tag: 'AgentDriverError', code: 'invalid-state' })
      expect(spawned).toEqual([])
    },
  )

  it('spawns the trusted Electron runtime with ordered arguments and the default secret policy', async () => {
    const spawned: ChildProcess.Command[] = []
    const spawner = ChildProcessSpawner.make(command => {
      spawned.push(command)
      return Effect.die(new Error('Stop at the external process boundary'))
    })
    await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          return yield* driver.connect({
            connectionId: 'bundled',
            configuration: {
              command: 'C:/app/electron.exe',
              argsJson: '["C:/app/server.js","--stdio"]',
              nodeRuntime: 'electron',
            },
          })
        }).pipe(
          Effect.provide(layerAcpAgentDriver({ runtimeExecutable: 'C:/app/electron.exe' })),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    )

    expect(spawned).toHaveLength(1)
    const command = spawned[0]
    expect(command?._tag).toBe('StandardCommand')
    if (command?._tag !== 'StandardCommand') throw new Error('Expected standard spawn command')
    expect(command.command).toBe('C:/app/electron.exe')
    expect(command.args).toEqual(['C:/app/server.js', '--stdio'])
    expect(command.options.env).toEqual({
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
      XAI_API_KEY: undefined,
      MOONSHOT_API_KEY: undefined,
      DASHSCOPE_API_KEY: undefined,
      QWEN_API_KEY: undefined,
      PI_API_KEY: undefined,
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(command.options.extendEnv).toBe(true)
  })

  it('applies independent session configuration while retaining native model and mode catalogs', async () => {
    const fake = makeFakeAcp()
    fake.openCodeOptions = true
    const capabilities = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-config-values' })
          const session = yield* connection.openSession({
            ...context,
            modelId: 'openai/gpt',
            modeId: 'code',
            configValues: { effort: 'high', mode: 'plan', agent: 'subagent' },
          })
          yield* connection.close(1000)
          return session.capabilities
        }),
      ),
    )

    expect(fake.configCalls).toEqual([
      { configId: 'model', value: 'openai/gpt' },
      { configId: 'effort', value: 'high' },
      { configId: 'mode', value: 'plan' },
      { configId: 'agent', value: 'subagent' },
    ])
    expect(capabilities.models).toEqual([
      { id: 'anthropic/sonnet', label: 'Anthropic/Sonnet' },
      { id: 'openai/gpt', label: 'OpenAI/GPT' },
    ])
    expect(capabilities.modes).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ])
    expect(capabilities.configOptions).toEqual([
      expect.objectContaining({ id: 'effort', currentValue: 'high' }),
      expect.objectContaining({
        id: 'agent',
        currentValue: 'subagent',
        options: [
          { id: 'default', label: 'Default', description: 'Use the default agent.' },
          { id: 'subagent', label: 'Subagent', description: 'Delegate this work.' },
        ],
      }),
      expect.objectContaining({ id: 'mode', currentValue: 'plan' }),
    ])
  })

  it('offers OpenCode thought levels as the effort and selects the model before the effort', async () => {
    const fake = makeFakeAcp()
    fake.openCodeOptions = true
    const probed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-opencode' })
          if (!connection.probeCatalog) return yield* Effect.die(new Error('ACP must offer a catalog probe'))
          const catalog = yield* connection.probeCatalog()
          yield* connection.openSession({ ...context, modelId: 'openai/gpt', modeId: 'high' })
          return catalog
        }),
      ),
    )
    expect(probed.models.map(model => model.id)).toEqual(['anthropic/sonnet', 'openai/gpt'])
    expect(probed.modes).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ])
    expect(fake.configCalls).toEqual([
      { configId: 'model', value: 'openai/gpt' },
      { configId: 'effort', value: 'high' },
    ])
  })

  it('probes the model and mode catalogs with a disposable session that never occupies the connection', async () => {
    const fake = makeFakeAcp()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-probe' })
          const passive = yield* connection.discover()
          if (!connection.probeCatalog) return yield* Effect.die(new Error('ACP must offer a catalog probe'))
          const probed = yield* connection.probeCatalog()
          const session = yield* connection.openSession(context)
          return { passive, probed, identity: session.identity }
        }),
      ),
    )
    expect(result.passive.modes).toEqual([])
    expect(result.probed.modes).toEqual([
      { id: 'code', label: 'Code' },
      { id: 'plan', label: 'Plan' },
    ])
    expect(result.identity.nativeSessionId).toBe('native-2')
    expect(fake.promptCalls).toHaveLength(0)
  })

  it('uses the official SDK lifecycle, streams events while prompt waits, and never treats unsupported inputs as text', async () => {
    const fake = makeFakeAcp()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-connection' })
          const capabilities = yield* connection.discover()
          expect(capabilities.openSession.support).toBe('supported')
          expect(capabilities.loadSession.support).toBe('unsupported')
          expect(capabilities.steer.support).toBe('unsupported')
          const session = yield* connection.openSession(context)
          expect(session.identity).toEqual({ nativeSessionId: 'native-1', generation: 3 })
          expect(session.capabilities.modes).toEqual([
            { id: 'code', label: 'Code' },
            { id: 'plan', label: 'Plan' },
          ])

          const rejected = yield* session
            .submit({
              runId: runId('run-unsupported'),
              messages: [{ role: 'user', content: 'inspect the image' }],
              attachmentIds: ['image-1'],
            })
            .pipe(Effect.flip)
          expect(rejected._tag).toBe('UnsupportedAgentOperation')
          expect(fake.promptCalls).toHaveLength(0)

          const promptRunId = runId('run-streamed')
          const fiber = yield* Effect.forkScoped(
            session.submit({
              runId: promptRunId,
              messages: [{ role: 'user', content: 'read README' }],
              attachmentIds: [],
            }),
          )
          const events = yield* Stream.runCollect(session.events(promptRunId))
          const accepted = yield* Fiber.join(fiber)
          yield* connection.close(1000)
          return { events: Array.from(events), accepted }
        }),
      ),
    )

    expect(fake.promptCalls).toHaveLength(1)
    expect(result.accepted).toEqual({ nativeSessionId: 'native-1', generation: 3 })
    expect(result.events.map(event => event.kind)).toEqual([
      'turnStarted',
      'textDelta',
      'reasoningDelta',
      'toolStarted',
      'toolCompleted',
      'usageReported',
      'turnCompleted',
    ])
  })

  it('waits for a human permission decision and defaults to allow-once even when allow-always is first', async () => {
    const fake = makeFakeAcp('permission')
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-permissions' })
          const session = yield* connection.openSession(context)
          const promptRunId = runId('run-permission')
          const fiber = yield* Effect.forkScoped(
            session.submit({
              runId: promptRunId,
              messages: [{ role: 'user', content: 'run a command' }],
              attachmentIds: [],
            }),
          )
          const seen: string[] = []
          yield* Stream.runForEach(session.events(promptRunId), event => {
            seen.push(event.kind)
            if (event.kind !== 'requestPending') return Effect.void
            expect(event.request.options).toEqual([
              {
                id: 'allow-always',
                label: 'Always allow',
                scope: 'session',
                kind: 'allowAlways',
                decision: { kind: 'approve', optionId: 'allow-always' },
              },
              {
                id: 'allow-once',
                label: 'Allow once',
                scope: 'once',
                kind: 'allow',
                decision: { kind: 'approve', optionId: 'allow-once' },
              },
              {
                id: 'reject-once',
                label: 'Reject once',
                scope: 'once',
                kind: 'deny',
                decision: { kind: 'deny', optionId: 'reject-once' },
              },
            ])
            return session
              .respond(promptRunId, event.request.requestId, context.generation, { kind: 'approve' })
              .pipe(Effect.asVoid)
          })
          const accepted = yield* Fiber.join(fiber)
          const duplicate = yield* session
            .respond(promptRunId, 'acp-request-1', context.generation, {
              kind: 'approve',
              optionId: 'allow-once',
            })
            .pipe(Effect.flip)
          yield* connection.close(1000)
          return { seen, accepted, duplicate }
        }),
      ),
    )

    expect(result.seen).toContain('requestPending')
    expect(result.seen).toContain('requestResolved')
    expect(result.accepted.nativeSessionId).toBe('native-1')
    expect(fake.permissionOutcomes).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
    expect(result.duplicate._tag).toBe('AgentDriverError')
  })

  it('resolves denial as cancelled when the agent offers no one-time rejection', async () => {
    const fake = makeFakeAcp('permission')
    fake.permissionOptions = [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-deny' })
          const session = yield* connection.openSession(context)
          const id = runId('run-deny')
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId: id, messages: [{ role: 'user', content: 'inspect' }], attachmentIds: [] }),
          )
          yield* Stream.runForEach(session.events(id), event =>
            event.kind === 'requestPending'
              ? session.respond(id, event.request.requestId, context.generation, { kind: 'deny' }).pipe(Effect.asVoid)
              : Effect.void,
          )
          yield* Fiber.join(submitting)
        }),
      ),
    )
    expect(fake.permissionOutcomes).toEqual([{ outcome: 'cancelled' }])
  })

  it('force-closes the transport when a cancel write cannot finish before the close deadline', async () => {
    const fake = makeFakeAcp('block')
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-stalled-close' })
          const session = yield* connection.openSession(context)
          const id = runId('run-stalled-close')
          const started = new Promise<void>(resolve => {
            fake.onPrompt = resolve
          })
          yield* Effect.forkScoped(
            session.submit({ runId: id, messages: [{ role: 'user', content: 'wait' }], attachmentIds: [] }),
          )
          yield* Effect.promise(() => started)
          fake.blockCancelWrite = true
          yield* connection.close(20).pipe(Effect.timeout('500 millis'))
          expect(fake.closeCalls).toHaveLength(1)
          fake.finishPrompt?.()
        }),
      ),
    )
  })

  it('cancels an active prompt without claiming confirmed termination and reports the native cancelled stop', async () => {
    const fake = makeFakeAcp('cancel')
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-cancel' })
          const session = yield* connection.openSession(context)
          const promptRunId = runId('run-cancel')
          const fiber = yield* Effect.forkScoped(
            session.submit({
              runId: promptRunId,
              messages: [{ role: 'user', content: 'wait until cancelled' }],
              attachmentIds: [],
            }),
          )
          const seen: string[] = []
          let interruptResult: unknown
          yield* Stream.runForEach(session.events(promptRunId), event => {
            seen.push(event.kind)
            if (event.kind !== 'turnStarted') return Effect.void
            return session.interrupt(promptRunId).pipe(
              Effect.tap(result =>
                Effect.sync(() => {
                  interruptResult = result
                }),
              ),
              Effect.asVoid,
            )
          })
          yield* Fiber.join(fiber)
          yield* connection.close(1000)
          return { seen, interruptResult }
        }),
      ),
    )
    expect(result.interruptResult).toEqual({ acknowledged: true, termination: 'unknown' })
    expect(result.seen).toEqual(['turnStarted', 'turnInterrupted'])
  })

  it('loads exact native identity and exposes replay-tagged history; unsupported load never creates a fresh session', async () => {
    const loadable = makeFakeAcp('events', true)
    const replay = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* loadable.driver.connect({ connectionId: 'acp-replay' })
          const session = yield* connection.loadSession(context, { nativeSessionId: 'native-existing', generation: 3 })
          const events = yield* Stream.runCollect(session.reconcile())
          yield* connection.close(1000)
          return Array.from(events)
        }),
      ),
    )
    expect(loadable.loadedSessionIds).toEqual(['native-existing'])
    expect(loadable.newSessionCalls).toHaveLength(0)
    expect(replay).toMatchObject([
      { cursor: 'acp-replay:1', replay: true, event: { kind: 'textDelta', text: 'replayed history' } },
    ])

    const nonLoadable = makeFakeAcp('events', false)
    const unsupported = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* nonLoadable.driver.connect({ connectionId: 'acp-no-load' })
          const result = yield* connection
            .loadSession(context, { nativeSessionId: 'must-not-fallback', generation: 3 })
            .pipe(Effect.flip)
          yield* connection.close(1000)
          return result
        }),
      ),
    )
    expect(unsupported._tag).toBe('UnsupportedAgentOperation')
    expect(nonLoadable.loadedSessionIds).toHaveLength(0)
    expect(nonLoadable.newSessionCalls).toHaveLength(0)
  })

  it('closes scoped transports once and uses typed unsupported steering', async () => {
    const fake = makeFakeAcp()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-close' })
          const session = yield* connection.openSession(context)
          const steer = yield* session.steer(runId('run-no-steer'), undefined, 'do this now').pipe(Effect.flip)
          yield* connection.close(1000)
          return steer
        }),
      ),
    )
    expect(result._tag).toBe('UnsupportedAgentOperation')
    expect(fake.closeCalls).toHaveLength(1)
  })

  it('keeps the native prompt fenced after its submit fiber is interrupted', async () => {
    const fake = makeFakeAcp('block')
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-interrupted-submit' })
          const session = yield* connection.openSession(context)
          const promptRunId = runId('run-interrupted-submit')
          let observedPrompt!: () => void
          const promptStarted = new Promise<void>(resolve => {
            observedPrompt = resolve
          })
          fake.onPrompt = observedPrompt
          const submitFiber = yield* Effect.forkScoped(
            session.submit({
              runId: promptRunId,
              messages: [{ role: 'user', content: 'hold open' }],
              attachmentIds: [],
            }),
          )
          let observedStart!: () => void
          const started = new Promise<void>(resolve => {
            observedStart = resolve
          })
          const eventFiber = yield* Effect.forkScoped(
            Stream.runForEach(session.events(promptRunId), event =>
              Effect.sync(() => {
                if (event.kind === 'turnStarted') observedStart()
              }),
            ),
          )
          yield* Effect.promise(() => started)
          yield* Effect.promise(() => promptStarted)
          yield* Fiber.interrupt(submitFiber)
          const second = yield* session
            .submit({
              runId: runId('run-must-not-overlap'),
              messages: [{ role: 'user', content: 'second' }],
              attachmentIds: [],
            })
            .pipe(Effect.flip)
          const callsBeforeNativeSettled = fake.promptCalls.length
          fake.finishPrompt?.()
          yield* connection.close(1000)
          yield* Fiber.interrupt(eventFiber)
          return { second, callsBeforeNativeSettled }
        }),
      ),
    )
    expect(result.second._tag).toBe('AgentDriverError')
    expect(result.callsBeforeNativeSettled).toBe(1)
    expect(fake.promptCalls).toHaveLength(1)
  })

  it('closes and poisons the connection when the event buffer overflows', async () => {
    const fake = makeFakeAcp('overflow')
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-overflow' })
          const session = yield* connection.openSession(context)
          const failed = yield* session
            .submit({
              runId: runId('run-overflow'),
              messages: [{ role: 'user', content: 'overflow' }],
              attachmentIds: [],
            })
            .pipe(Effect.flip)
          const next = yield* session
            .submit({
              runId: runId('run-after-overflow'),
              messages: [{ role: 'user', content: 'next' }],
              attachmentIds: [],
            })
            .pipe(Effect.flip)
          yield* connection.close(1000)
          return { failed, next }
        }),
      ),
    )
    expect(result.failed._tag).toBe('AgentDriverError')
    expect(result.next._tag).toBe('AgentDriverError')
    expect(fake.closeCalls).toHaveLength(1)
    expect(fake.cancelCalls.length).toBeGreaterThan(0)
  })

  it('bounds prepared channels for unknown run IDs', async () => {
    const fake = makeFakeAcp()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-prepared-cap' })
          const session = yield* connection.openSession(context)
          const fibers = []
          for (let index = 0; index < 32; index += 1) {
            fibers.push(yield* Effect.forkScoped(Stream.runDrain(session.events(runId(`unknown-${index}`)))))
            yield* Effect.yieldNow
          }
          const overflow = yield* Stream.runDrain(session.events(runId('unknown-over-cap'))).pipe(Effect.flip)
          for (const fiber of fibers) yield* Fiber.interrupt(fiber)
          yield* connection.close(1000)
          return overflow
        }),
      ),
    )
    expect(result._tag).toBe('AgentDriverError')
  })

  it('closes an opened native session when the requested catalog selection is invalid', async () => {
    const fake = makeFakeAcp()
    const invalidContext = { ...context, modelId: 'missing-model' }
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-invalid-model' })
          const failed = yield* connection.openSession(invalidContext).pipe(Effect.flip)
          const reopened = yield* connection.openSession(context).pipe(Effect.flip)
          return { failed, reopened }
        }),
      ),
    )
    expect(result.failed._tag).toBe('UnsupportedAgentOperation')
    expect(result.reopened._tag).toBe('AgentDriverError')
    expect(fake.closeCalls).toHaveLength(1)
  })

  it('declares every access mode, applied through the permission callback', () => {
    expect(makeFakeAcp().driver.accessModes).toEqual(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])
  })

  it.each([
    { accessMode: 'approval-required' as const, kind: 'read', expected: 'allow-once' },
    { accessMode: 'approval-required' as const, kind: 'edit', expected: undefined },
    { accessMode: 'auto-accept-edits' as const, kind: 'edit', expected: 'allow-once' },
    { accessMode: 'auto-accept-edits' as const, kind: 'execute', expected: undefined },
    { accessMode: 'auto' as const, kind: 'edit', expected: 'allow-once' },
    { accessMode: 'auto' as const, kind: 'execute', expected: undefined },
    { accessMode: 'full-access' as const, kind: 'execute', expected: 'allow-once' },
  ])('answers a $kind request in $accessMode with $expected', ({ accessMode, kind, expected }) => {
    const options: PermissionOption[] = [
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ]
    const answer = automaticPermission(accessMode, { options, toolCall: { toolCallId: 't', kind: kind as never } })
    expect(answer?.outcome).toEqual(expected ? { outcome: 'selected', optionId: expected } : undefined)
  })

  it('asks instead of choosing a persistent approval for the user', () => {
    const options: PermissionOption[] = [{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' }]
    expect(automaticPermission('full-access', { options, toolCall: { toolCallId: 't', kind: 'execute' } })).toBe(
      undefined,
    )
  })

  it('keeps Copilot catalog choices representable for the inspection contract', async () => {
    const fake = makeFakeAcp()
    fake.copilotOptions = true
    const catalog = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-copilot' })
          if (!connection.probeCatalog) return yield* Effect.die(new Error('ACP must offer a catalog probe'))
          const probed = yield* connection.probeCatalog()
          yield* connection.close(1000)
          return probed
        }),
      ),
    )

    // Copilot repeats its "auto" alias and uses an empty value for the default persona.
    expect(catalog.models).toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
    ])
    const options = catalog.configOptions ?? []
    const agent = options.find(option => option.id === 'agent')
    expect(agent).toMatchObject({
      currentValue: '',
      options: [
        { id: '', label: 'Copilot', description: 'Default Copilot agent' },
        { id: 'munaciello', label: 'munaciello' },
      ],
    })
    expect(options.find(option => option.id === 'allow_all')).toMatchObject({
      label: 'Allow All',
      category: 'permissions',
      currentValue: 'off',
    })
    // The inspection RPC encodes this catalog, so an unrepresentable choice would fail the whole read.
    expect(() => Schema.decodeUnknownSync(Schema.Array(agentConfigOptionSchema))(options)).not.toThrow()
  })

  it('reselects the Copilot default persona on a loaded session', async () => {
    const fake = makeFakeAcp('events', true)
    fake.copilotOptions = true
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-copilot-reset' })
          const session = yield* connection.loadSession(
            { ...context, configValues: { agent: '' } },
            { nativeSessionId: 'native-copilot', generation: 3 },
          )
          const capabilities = session.capabilities
          yield* connection.close(1000)
          return capabilities
        }),
      ),
    )

    expect(fake.loadedSessionIds).toEqual(['native-copilot'])
    expect(fake.newSessionCalls).toHaveLength(0)
    expect(fake.configCalls).toEqual([{ configId: 'agent', value: '' }])
    expect(result.configOptions?.find(option => option.id === 'agent')).toMatchObject({
      currentValue: '',
      options: [
        { id: '', label: 'Copilot' },
        { id: 'munaciello', label: 'munaciello' },
      ],
    })
  })

  it('discovers reasoning efforts per model when the agent publishes them only for the session model', async () => {
    const fake = makeFakeAcp()
    fake.modelDependentEffort = true
    const catalog = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-model-efforts' })
          if (!connection.probeCatalog) return yield* Effect.die(new Error('ACP must offer a catalog probe'))
          const probed = yield* connection.probeCatalog()
          yield* connection.close(1000)
          return probed
        }),
      ),
    )

    expect(catalog.models).toEqual([
      {
        id: 'openai/gpt',
        label: 'OpenAI/GPT',
        modes: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' },
        ],
      },
      { id: 'plain/model', label: 'Plain/Model' },
    ])
    expect(catalog.modes).toEqual([
      { id: 'build', label: 'Build' },
      { id: 'plan', label: 'Plan' },
    ])
    // Every model was switched to on a disposable session to read its own effort set.
    expect(fake.configCalls).toEqual([
      { configId: 'model', value: 'openai/gpt' },
      { configId: 'model', value: 'plain/model' },
    ])
    expect(fake.newSessionCalls.length).toBeGreaterThan(1)
  })

  it('closes an opened native session when the requested mode is absent from the catalog', async () => {
    const fake = makeFakeAcp()
    const invalidContext = { ...context, modeId: 'missing-mode' }
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fake.driver.connect({ connectionId: 'acp-invalid-mode' })
          const failed = yield* connection.openSession(invalidContext).pipe(Effect.flip)
          const reopened = yield* connection.openSession(context).pipe(Effect.flip)
          return { failed, reopened }
        }),
      ),
    )
    expect(result.failed._tag).toBe('UnsupportedAgentOperation')
    expect(result.reopened._tag).toBe('AgentDriverError')
    expect(fake.closeCalls).toHaveLength(1)
  })
})
