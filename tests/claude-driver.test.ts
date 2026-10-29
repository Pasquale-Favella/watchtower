import type {
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { Effect, Fiber, Schema, Stream } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { AgentDriver } from '@/core/ports/agent-driver.js'
import { type ClaudeAgentSdk, makeClaudeAgentDriver } from '@/infrastructure/agent-harnesses/drivers/claude/driver.js'
import type { AgentDriverEvent } from '@/shared/schemas/execution.js'
import {
  agentRunIdSchema,
  agentSessionIdSchema,
  conversationIdSchema,
  projectIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '@/shared/schemas/workspace.js'

interface FakeCall {
  readonly prompt: string | AsyncIterable<SDKUserMessage>
  readonly options: NonNullable<Parameters<ClaudeAgentSdk['query']>[0]['options']>
  readonly push: (message: SDKMessage) => void
  readonly close: () => void
  interrupted: number
  closed: boolean
}

const promptIterator = (call: FakeCall): AsyncIterator<SDKUserMessage> => {
  if (typeof call.prompt === 'string') throw new Error('Expected the driver to use streaming SDK input.')
  return call.prompt[Symbol.asyncIterator]()
}

const fakeCall = (fake: { readonly calls: ReadonlyArray<FakeCall> }, index = 0): FakeCall => {
  const call = fake.calls[index]
  if (!call) throw new Error(`Fake SDK call ${index} was not created.`)
  return call
}

const requiredRequestId = (requestId: string | undefined): string => {
  if (!requestId) throw new Error('The pending native request has no request ID.')
  return requestId
}

const fakeSdk = (init: (sessionId: string) => SDKMessage = initMessage) => {
  const calls: FakeCall[] = []
  const sdk: ClaudeAgentSdk = {
    query({ prompt, options = {} }) {
      if (typeof options.canUseTool !== 'function') {
        throw new Error('The driver must install canUseTool before calling query().')
      }
      const capturedOptions = { ...options }
      let waiting: ((message: SDKMessage | undefined) => void) | undefined
      const messages: Array<SDKMessage | undefined> = [init(String(options.sessionId ?? options.resume ?? 'native'))]
      let done = false
      const call: FakeCall = {
        prompt,
        options: capturedOptions,
        push(message) {
          if (waiting) {
            const resume = waiting
            waiting = undefined
            resume(message)
          } else messages.push(message)
        },
        close() {
          call.closed = true
          done = true
          if (waiting) {
            const resume = waiting
            waiting = undefined
            resume(undefined)
          }
        },
        interrupted: 0,
        closed: false,
      }
      async function* read(): AsyncGenerator<SDKMessage, void> {
        while (!done) {
          const message =
            messages.length > 0
              ? messages.shift()
              : await new Promise<SDKMessage | undefined>(resolve => {
                  waiting = resolve
                })
          if (message === undefined) return
          yield message
        }
      }
      const generator = read()
      const query = Object.assign(generator, {
        interrupt: async () => {
          call.interrupted += 1
          return undefined
        },
        close: call.close,
      }) as unknown as Query
      calls.push(call)
      return query
    },
  }
  return { sdk, calls }
}

const initMessage = (sessionId: string): SDKSystemMessage =>
  ({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: '2.1.270',
    cwd: 'C:\\work\\repo',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: '00000000-0000-4000-8000-000000000001',
  }) satisfies SDKSystemMessage

const resultMessage = (
  sessionId: string,
  uuid: SDKResultMessage['uuid'],
  stopReason: string | null = 'end_turn',
): SDKResultMessage => ({
  type: 'result',
  subtype: 'success',
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: 'hello',
  stop_reason: stopReason,
  total_cost_usd: 0.002,
  usage: {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    fallback_credit: { status: { type: 'not_applied', reason: 'not_enabled' } },
    inference_geo: 'us',
    input_tokens: 12,
    iterations: [],
    output_tokens: 4,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  },
  modelUsage: {},
  permission_denials: [],
  uuid,
  session_id: sessionId,
})

const context = {
  sessionId: Schema.decodeUnknownSync(agentSessionIdSchema)('managed-session'),
  projectId: Schema.decodeUnknownSync(projectIdSchema)('project'),
  taskId: Schema.decodeUnknownSync(taskIdSchema)('task'),
  conversationId: Schema.decodeUnknownSync(conversationIdSchema)('conversation'),
  checkoutId: Schema.decodeUnknownSync(workspaceCheckoutIdSchema)('checkout'),
  workspacePath: 'C:\\work\\repo',
  generation: 2,
} as const

const inputUuid = (message: SDKUserMessage): string => {
  if (message.uuid === undefined) throw new Error('The submitted SDK message must have a UUID.')
  return message.uuid
}

const runId = Schema.decodeUnknownSync(agentRunIdSchema)('run-1')
const turn = {
  runId,
  messages: [{ role: 'user' as const, content: 'Inspect this repository.' }],
  attachmentIds: [],
}

describe('Claude Agent SDK native driver', () => {
  it('passes only the selected API key instead of unrelated host secrets', async () => {
    vi.stubEnv('GH_TOKEN', 'host-gh-token')
    vi.stubEnv('OPENAI_API_KEY', 'host-openai-key')
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-anthropic-key')
    const fake = fakeSdk()
    const layer = makeClaudeAgentDriver({ sdk: fake.sdk, apiKey: () => 'selected-anthropic-key' })

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const driver = yield* AgentDriver
            const connection = yield* driver.connect({ connectionId: 'connection' })
            yield* connection.openSession(context)

            expect(fakeCall(fake).options.env).toMatchObject({ ANTHROPIC_API_KEY: 'selected-anthropic-key' })
            expect(fakeCall(fake).options.env).not.toHaveProperty('GH_TOKEN')
            expect(fakeCall(fake).options.env).not.toHaveProperty('OPENAI_API_KEY')
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('uses a scoped streaming query and reports accepted text, tool, and final usage events', async () => {
    const fake = fakeSdk()
    const layer = makeClaudeAgentDriver({ sdk: fake.sdk, apiKey: () => 'test-key', makeId: () => 'native-session' })
    const events: Array<{ kind: string }> = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const connection = yield* driver.connect({ connectionId: 'connection' })
          const session = yield* connection.openSession(context)
          expect(session.identity.nativeSessionId).toBe('native-session')
          expect(fake.calls[0]?.options.sessionId).toBe('native-session')
          expect(fake.calls[0]?.options.resume).toBeUndefined()
          expect(fake.calls[0]?.options.settingSources).toEqual(['user', 'project', 'local'])
          expect(fake.calls[0]?.options.permissionMode).toBe('default')
          expect(fake.calls[0]?.options.hooks?.PreToolUse?.length).toBe(1)
          expect(fake.calls[0]?.options.canUseTool).toBeTypeOf('function')

          const rejectedHistory = yield* Effect.exit(
            session.submit({ ...turn, messages: [{ role: 'assistant', content: 'Prior assistant text.' }] }),
          )
          expect(rejectedHistory._tag).toBe('Failure')
          const rejectedEmpty = yield* Effect.exit(
            session.submit({ ...turn, messages: [{ role: 'user', content: '  ' }] }),
          )
          expect(rejectedEmpty._tag).toBe('Failure')

          const submitted = yield* Effect.forkDetach(session.submit(turn))
          const input = yield* Effect.promise(() => promptIterator(fake.calls[0]!).next())
          expect(input.done).toBe(false)
          const messageUuid = inputUuid(input.value)
          fake.calls[0]!.push({
            type: 'stream_event',
            uuid: '00000000-0000-4000-8000-000000000002',
            session_id: 'native-session',
            parent_tool_use_id: null,
            user_message_uuid: messageUuid,
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
          } satisfies SDKMessage)
          const acceptance = yield* Fiber.join(submitted)
          expect(acceptance).toMatchObject({ nativeSessionId: 'native-session', generation: 2 })
          const eventCollection = yield* Effect.forkDetach(Stream.runCollect(session.events(runId)))
          fake.calls[0]!.push({
            type: 'stream_event',
            uuid: '00000000-0000-4000-8000-000000000003',
            session_id: 'native-session',
            parent_tool_use_id: null,
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
            },
          } satisfies SDKMessage)
          fake.calls[0]!.push({
            type: 'user',
            session_id: 'native-session',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }],
            },
          } satisfies SDKMessage)
          fake.calls[0]!.push(resultMessage('native-session', '00000000-0000-4000-8000-000000000004'))
          const received = yield* Fiber.join(eventCollection)
          events.push(...Array.from(received, event => ({ kind: event.kind })))
          expect(events.map(({ kind }) => kind)).toEqual([
            'turnStarted',
            'textDelta',
            'toolStarted',
            'toolUpdated',
            'toolCompleted',
            'usageReported',
            'turnCompleted',
          ])
          expect(received.find(event => event.kind === 'usageReported')).toMatchObject({
            semantics: 'final',
            scope: 'run',
            inputTokens: 12,
            outputTokens: 4,
          })
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(fake.calls[0]?.closed).toBe(true)
  })

  it('holds approvals and structured questions pending until an explicit scoped decision', async () => {
    const fake = fakeSdk()
    const layer = makeClaudeAgentDriver({
      sdk: fake.sdk,
      apiKey: () => 'test-key',
      makeId: (() => {
        let next = 0
        return () => `id-${++next}`
      })(),
    })
    type PendingEvent = Extract<AgentDriverEvent, { kind: 'requestPending' }>
    const events: AgentDriverEvent[] = []
    const pendingQueue: PendingEvent[] = []
    const pendingWaiters: Array<(event: PendingEvent) => void> = []
    const nextPending = () =>
      new Promise<PendingEvent>(resolve => {
        const event = pendingQueue.shift()
        if (event) resolve(event)
        else pendingWaiters.push(resolve)
      })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const connection = yield* driver.connect({ connectionId: 'connection' })
          const session = yield* connection.openSession(context)
          const nativeSessionId = session.identity.nativeSessionId
          const submitted = yield* Effect.forkDetach(session.submit(turn))
          const input = yield* Effect.promise(() => promptIterator(fake.calls[0]!).next())
          fake.calls[0]!.push({
            type: 'stream_event',
            uuid: '00000000-0000-4000-8000-000000000005',
            session_id: nativeSessionId,
            parent_tool_use_id: null,
            user_message_uuid: input.value.uuid,
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '', citations: null },
            },
          } satisfies SDKMessage)
          yield* Fiber.join(submitted)
          const eventCollection = yield* Effect.forkDetach(
            Stream.runForEach(session.events(runId), event =>
              Effect.sync(() => {
                events.push(event)
                if (event.kind === 'requestPending') {
                  const resolve = pendingWaiters.shift()
                  if (resolve) resolve(event)
                  else pendingQueue.push(event)
                }
              }),
            ),
          )

          const canUseTool = fake.calls[0]!.options.canUseTool
          if (typeof canUseTool !== 'function') throw new Error('Fake SDK did not capture canUseTool.')
          const signal = new AbortController().signal
          const approval = canUseTool(
            'Bash',
            { command: 'git status' },
            {
              signal,
              toolUseID: 'native-tool-approval',
              requestId: 'native-request-approval',
              defaultToNo: true,
              suppressAlwaysAllowRule: true,
            },
          )
          const approvalEvent = yield* Effect.promise(nextPending)
          expect(approvalEvent.request).toMatchObject({
            kind: 'approval',
            nativeRequestId: 'native-request-approval',
            options: [{ id: 'allow-once' }, { id: 'deny-once' }],
          })
          const approvalRequestId = approvalEvent.request.requestId
          expect(approvalRequestId).toBeDefined()
          yield* session.respond(runId, requiredRequestId(approvalRequestId), 2, {
            kind: 'approve',
            optionId: 'allow-once',
          })
          const approvalResult = yield* Effect.promise(() => approval)
          expect(approvalResult).toMatchObject({ behavior: 'allow', updatedInput: { command: 'git status' } })

          const ask = canUseTool(
            'AskUserQuestion',
            {
              questions: [
                {
                  question: 'Which format?',
                  header: 'Format',
                  multiSelect: false,
                  options: [{ label: 'JSON' }, { label: 'CSV' }],
                },
              ],
            },
            {
              signal,
              toolUseID: 'native-question-tool',
              requestId: 'native-question-request',
              defaultToNo: true,
              suppressAlwaysAllowRule: true,
            },
          )
          const questionEvent = yield* Effect.promise(nextPending)
          expect(questionEvent.request).toMatchObject({
            kind: 'question',
            questions: [
              {
                id: 'q0',
                prompt: 'Which format?',
                options: [
                  { id: 'q0-o0', label: 'JSON' },
                  { id: 'q0-o1', label: 'CSV' },
                ],
              },
            ],
          })
          const requestId = questionEvent.request?.requestId
          expect(requestId).toBeDefined()
          yield* session.respond(runId, requiredRequestId(requestId), 2, { kind: 'answers', answers: { q0: 'q0-o1' } })
          const answerResult = yield* Effect.promise(() => ask)
          expect(answerResult).toMatchObject({
            behavior: 'allow',
            updatedInput: { questions: [{ question: 'Which format?' }], answers: { 'Which format?': 'CSV' } },
          })

          const refused = canUseTool(
            'Write',
            { file_path: 'x.ts' },
            {
              signal,
              toolUseID: 'native-tool-refused',
              requestId: 'native-request-refused',
              defaultToNo: true,
              suppressAlwaysAllowRule: true,
            },
          )
          const refusalEvent = yield* Effect.promise(nextPending)
          expect(refusalEvent.request?.kind).toBe('approval')
          const refusalId = refusalEvent.request?.requestId
          yield* session.respond(runId, requiredRequestId(refusalId), 2, { kind: 'deny', reason: 'Not approved' })
          const refusalResult = yield* Effect.promise(() => refused)
          expect(refusalResult).toMatchObject({ behavior: 'deny', message: 'Not approved' })

          fake.calls[0]!.push(resultMessage(nativeSessionId, '00000000-0000-4000-8000-000000000006'))
          yield* Fiber.join(eventCollection)
          expect(events.filter(event => event.kind === 'requestResolved')).toHaveLength(3)
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(fake.calls[0]?.closed).toBe(true)
  })

  it('fails closed on oversized native text and rejects uncertain acceptance', async () => {
    const fake = fakeSdk()
    const layer = makeClaudeAgentDriver({ sdk: fake.sdk, apiKey: () => 'test-key' })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const connection = yield* driver.connect({ connectionId: 'connection' })
          const session = yield* connection.openSession(context)
          const submitted = yield* Effect.forkDetach(session.submit(turn))
          const eventCollection = yield* Effect.forkDetach(Stream.runCollect(session.events(runId)))
          const input = yield* Effect.promise(() => promptIterator(fake.calls[0]!).next())
          fake.calls[0]!.push({
            type: 'stream_event',
            uuid: '00000000-0000-4000-8000-000000000009',
            session_id: session.identity.nativeSessionId,
            parent_tool_use_id: null,
            user_message_uuid: inputUuid(input.value),
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(20_000) } },
          } satisfies SDKMessage)

          const acceptanceExit = yield* Fiber.await(submitted)
          expect(acceptanceExit._tag).toBe('Success')
          const streamExit = yield* Effect.exit(Fiber.join(eventCollection))
          expect(streamExit._tag).toBe('Failure')
          expect(fake.calls[0]?.closed).toBe(true)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  it('does not confirm prompt acceptance from an event belonging to another native session', async () => {
    const fake = fakeSdk()
    const layer = makeClaudeAgentDriver({ sdk: fake.sdk, apiKey: () => 'test-key' })

    const acceptance = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const connection = yield* driver.connect({ connectionId: 'connection' })
          const session = yield* connection.openSession(context)
          const call = fakeCall(fake)
          const submitted = yield* Effect.forkScoped(session.submit(turn))
          const input = yield* Effect.promise(() => promptIterator(call).next())
          call.push({
            type: 'stream_event',
            uuid: '00000000-0000-4000-8000-000000000012',
            session_id: 'different-native-session',
            parent_tool_use_id: null,
            user_message_uuid: inputUuid(input.value),
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'wrong session' } },
          } satisfies SDKMessage)

          return { acceptance: (yield* Fiber.await(submitted))._tag, closed: call.closed }
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(acceptance).toEqual({ acceptance: 'Failure', closed: true })
  })

  it('resumes only the named native session, interrupts, and closes its owned query', async () => {
    const fake = fakeSdk()
    const layer = makeClaudeAgentDriver({ sdk: fake.sdk, apiKey: () => 'test-key', makeId: () => 'new-session' })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const connection = yield* driver.connect({ connectionId: 'connection' })
          const session = yield* connection.loadSession(context, {
            nativeSessionId: 'prior-native-session',
            generation: 2,
          })
          expect(fake.calls[0]?.options.resume).toBe('prior-native-session')
          expect(fake.calls[0]?.options.sessionId).toBeUndefined()
          expect(session.identity.nativeSessionId).toBe('prior-native-session')
          const submitted = yield* Effect.forkDetach(session.submit(turn))
          const input = yield* Effect.promise(() => promptIterator(fake.calls[0]!).next())
          fake.calls[0]!.push({
            type: 'stream_event',
            uuid: '00000000-0000-4000-8000-000000000007',
            session_id: 'prior-native-session',
            parent_tool_use_id: null,
            user_message_uuid: inputUuid(input.value),
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '', citations: null },
            },
          } satisfies SDKMessage)
          yield* Fiber.join(submitted)
          const acknowledgement = yield* session.interrupt(runId)
          expect(acknowledgement).toEqual({ acknowledged: false, termination: 'unknown' })
          expect(fake.calls[0]?.interrupted).toBe(1)
          fake.calls[0]!.push(
            resultMessage('prior-native-session', '00000000-0000-4000-8000-000000000008', 'interrupt'),
          )
          const events = yield* Stream.runCollect(session.events(runId))
          expect(events.map(event => event.kind)).toContain('turnInterrupted')

          const followingRunId = Schema.decodeUnknownSync(agentRunIdSchema)('run-after-interrupt')
          const followingRun = { ...turn, runId: followingRunId }
          const followingSubmit = yield* Effect.forkDetach(session.submit(followingRun))
          const followingInput = yield* Effect.promise(() => promptIterator(fake.calls[0]!).next())
          fake.calls[0]!.push({
            type: 'stream_event',
            uuid: '00000000-0000-4000-8000-000000000010',
            session_id: 'prior-native-session',
            parent_tool_use_id: null,
            user_message_uuid: inputUuid(followingInput.value),
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '', citations: null },
            },
          } satisfies SDKMessage)
          yield* Fiber.join(followingSubmit)
          const successfulAfterInterrupt = yield* Effect.forkDetach(Stream.runCollect(session.events(followingRunId)))
          fake.calls[0]!.push(resultMessage('prior-native-session', '00000000-0000-4000-8000-000000000011', 'end_turn'))
          const followingEvents = yield* Fiber.join(successfulAfterInterrupt)
          expect(followingEvents.map(event => event.kind)).toContain('turnCompleted')
          expect(followingEvents.map(event => event.kind)).not.toContain('turnInterrupted')
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(fake.calls[0]?.closed).toBe(true)
  })

  it('rejects absent API credentials and refuses a non-API-key SDK auth route', async () => {
    const absent = makeClaudeAgentDriver({ apiKey: () => undefined })
    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const driver = yield* AgentDriver
            yield* driver.connect({ connectionId: 'connection' })
          }).pipe(Effect.provide(absent)),
        ),
      ),
    ).rejects.toMatchObject({ code: 'authentication-required' })

    const fake = fakeSdk(sessionId => ({ ...initMessage(sessionId), apiKeySource: 'none' as const }))
    const layer = makeClaudeAgentDriver({ sdk: fake.sdk, apiKey: () => 'test-key' })
    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const driver = yield* AgentDriver
            const connection = yield* driver.connect({ connectionId: 'connection' })
            const session = yield* connection.openSession(context)
            yield* session.submit(turn)
          }).pipe(Effect.provide(layer)),
        ),
      ),
    ).rejects.toMatchObject({ code: 'authentication-required' })
    expect(fake.calls[0]?.closed).toBe(true)
  })
})
