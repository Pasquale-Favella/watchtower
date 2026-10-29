import {
  type Agent,
  AgentSideConnection,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { AgentDriverError } from '../src/core/ports/agent-driver.js'
import { makeAcpDriver } from '../src/infrastructure/agent-harnesses/drivers/acp/driver.js'
import type { JsonRpcTransport } from '../src/infrastructure/agent-harnesses/drivers/json-rpc.js'
import type { AgentRunId } from '../src/shared/schemas/workspace.js'
import {
  agentRunIdSchema,
  agentSessionIdSchema,
  conversationIdSchema,
  projectIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '../src/shared/schemas/workspace.js'

type PromptMode = 'events' | 'permission' | 'cancel' | 'block' | 'overflow'

interface FakeAcpState {
  driver: ReturnType<typeof makeAcpDriver>
  readonly promptCalls: Array<{ readonly cwd: string; readonly prompt: string }>
  readonly newSessionCalls: number[]
  readonly loadedSessionIds: string[]
  readonly closeCalls: number[]
  readonly cancelCalls: number[]
  readonly permissionOutcomes: Array<{ readonly outcome: string; readonly optionId?: string }>
  permissionOptions?: PermissionOption[]
  blockCancelWrite: boolean
  finishPrompt?: () => void
  onPrompt?: () => void
  mode: PromptMode
  allowLoad: boolean
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
    blockCancelWrite: false,
    mode,
    allowLoad,
  }
  let peer: AgentSideConnection | undefined
  let cancelPrompt: (() => void) | undefined

  const agent: Agent = {
    authenticate: async () => ({}),
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: state.allowLoad },
      agentInfo: { name: 'fixture', version: '1' },
    }),
    newSession: async params => {
      state.newSessionCalls.push(state.newSessionCalls.length + 1)
      if (params.cwd !== 'C:/workspace/project') throw new Error('wrong workspace path')
      return {
        sessionId: `native-${state.newSessionCalls.length}`,
        configOptions: [
          {
            type: 'select',
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            currentValue: 'code',
            options: [
              { name: 'Code', value: 'code' },
              { name: 'Plan', value: 'plan' },
            ],
          },
        ],
      }
    },
    loadSession: async params => {
      state.loadedSessionIds.push(params.sessionId)
      await peer?.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } },
      })
      return {}
    },
    prompt: async params => {
      state.promptCalls.push({ cwd: 'C:/workspace/project', prompt: JSON.stringify(params.prompt) })
      state.onPrompt?.()
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

describe('generic ACP driver', () => {
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
      'nativeNotice',
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
              { id: 'allow-once', label: 'Allow once', scope: 'once', kind: 'allow' },
              { id: 'reject-once', label: 'Reject once', scope: 'once', kind: 'deny' },
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
