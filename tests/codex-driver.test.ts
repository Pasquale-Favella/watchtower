import { Effect, Fiber, Queue, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import type { AgentSessionContext } from '@/core/ports/agent-driver.js'
import {
  codexAgentDriverConnect,
  codexAgentDriverFromTransport,
} from '@/infrastructure/agent-harnesses/drivers/codex/driver.js'
import type { JsonRpcTransport } from '@/infrastructure/agent-harnesses/drivers/json-rpc.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const connectionOptions = { connectionId: 'connection-1' }
const context: AgentSessionContext = {
  sessionId: 'session-1' as AgentSessionContext['sessionId'],
  projectId: 'project-1' as AgentSessionContext['projectId'],
  taskId: 'task-1' as AgentSessionContext['taskId'],
  conversationId: 'conversation-1' as AgentSessionContext['conversationId'],
  checkoutId: 'checkout-1' as AgentSessionContext['checkoutId'],
  workspacePath: 'C:\\workspace',
  generation: 4,
}

function fakeServer() {
  const input = Effect.runSync(Queue.unbounded<Uint8Array>())
  const output = Effect.runSync(Queue.unbounded<Uint8Array>())
  let closed = false
  const transport: JsonRpcTransport = {
    input: Stream.fromQueue(input),
    write: bytes => Queue.offer(output, bytes).pipe(Effect.asVoid),
    close: () =>
      Effect.sync(() => {
        closed = true
      }),
  }
  return {
    transport,
    input,
    output,
    closed: () => closed,
    send: (message: unknown) => Queue.offer(input, encoder.encode(`${JSON.stringify(message)}\n`)),
    read: Effect.map(Queue.take(output), bytes => JSON.parse(decoder.decode(bytes)) as Record<string, unknown>),
  }
}

function* connect(server: ReturnType<typeof fakeServer>) {
  const connecting = yield* Effect.forkScoped(codexAgentDriverFromTransport(connectionOptions, server.transport))
  const initialize = yield* server.read
  yield* server.send({
    id: initialize.id,
    result: {
      codexHome: 'C:\\codex-home',
      platformFamily: 'windows',
      platformOs: 'windows',
      userAgent: 'codex-cli/test',
    },
  })
  const initialized = yield* server.read
  expect(initialized.method).toBe('initialized')
  return yield* Fiber.join(connecting)
}

describe('Codex native App Server driver', () => {
  it('completes initialize before opening a thread, holds approval until a user decision, and rejects stale steering', async () => {
    const server = fakeServer()
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          expect(start.method).toBe('thread/start')
          expect(start.params).toMatchObject({ cwd: context.workspacePath })
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-native-1' } } })
          const session = yield* Fiber.join(opening)

          const runId = 'run-1' as Parameters<typeof session.submit>[0]['runId']
          const unsupportedAttachment = yield* Effect.exit(
            session.submit({
              runId: 'run-attachment' as typeof runId,
              messages: [{ role: 'user', content: 'Inspect' }],
              attachmentIds: ['attachment-1'],
            }),
          )
          expect(unsupportedAttachment._tag).toBe('Failure')
          expect(yield* Queue.size(server.output)).toBe(0)
          const iterable = yield* Stream.toAsyncIterableEffect(session.events(runId))
          const iterator = iterable[Symbol.asyncIterator]()
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: 'Inspect the project' }], attachmentIds: [] }),
          )
          const turnStart = yield* server.read
          expect(turnStart.method).toBe('turn/start')
          expect(turnStart.params).toMatchObject({
            threadId: 'thread-native-1',
            input: [{ type: 'text', text: 'Inspect the project' }],
          })
          yield* server.send({
            method: 'turn/completed',
            params: { threadId: 'thread-native-1', turn: { id: 'turn-from-previous-run', status: 'completed' } },
          })
          yield* server.send({ id: turnStart.id, result: { turn: { id: 'turn-native-1', status: 'inProgress' } } })
          const accepted = yield* Fiber.join(submitting)
          const concurrent = yield* Effect.exit(
            session.submit({
              runId: 'run-concurrent' as typeof runId,
              messages: [{ role: 'user', content: 'Another turn' }],
              attachmentIds: [],
            }),
          )
          expect(concurrent._tag).toBe('Failure')
          expect(yield* Queue.size(server.output)).toBe(0)

          const stale = yield* Effect.exit(session.steer(runId, 'old-turn', 'follow up'))
          expect(stale._tag).toBe('Failure')
          const noStaleWrite = yield* Queue.size(server.output)
          expect(noStaleWrite).toBe(0)

          yield* server.send({
            id: 'native-approval-1',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-native-1', turnId: accepted.nativeTurnId, command: 'git status' },
          })
          const pending = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })
          expect(pending.value).toMatchObject({
            kind: 'requestPending',
            request: {
              kind: 'approval',
              sessionId: context.sessionId,
              generation: context.generation,
              prompt: 'git status',
            },
          })
          const noAutomaticDecision = yield* Queue.size(server.output)
          expect(noAutomaticDecision).toBe(0)

          const request = pending.value?.kind === 'requestPending' ? pending.value.request : undefined
          if (!request) throw new Error('Expected a pending approval event')
          const staleDecision = yield* Effect.exit(
            session.respond(runId, request.requestId, context.generation - 1, { kind: 'approve' }),
          )
          expect(staleDecision._tag).toBe('Failure')
          const noStaleDecision = yield* Queue.size(server.output)
          expect(noStaleDecision).toBe(0)
          const unavailableChoice = yield* Effect.exit(
            session.respond(runId, request.requestId, context.generation, {
              kind: 'approve',
              optionId: 'allow-session',
            }),
          )
          expect(unavailableChoice._tag).toBe('Failure')
          expect(yield* Queue.size(server.output)).toBe(0)

          const decision = yield* session.respond(runId, request.requestId, context.generation, { kind: 'deny' })
          expect(decision.outcome).toBe('accepted')
          expect(decision.nativeConfirmation).toBe('unconfirmed')
          const response = yield* server.read
          expect(response).toEqual({ id: 'native-approval-1', result: { decision: 'decline' } })
          const approvalResolved = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })
          expect(approvalResolved.value).toMatchObject({ kind: 'requestResolved', requestId: request.requestId })

          yield* server.send({
            id: 'native-question-1',
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thread-native-1',
              turnId: accepted.nativeTurnId,
              itemId: 'item-question-1',
              isBlocking: true,
              questions: [
                {
                  id: 'language',
                  header: 'Language',
                  question: 'Which language?',
                  options: [{ label: 'Rust', description: 'Fast and safe' }],
                },
              ],
            },
          })
          const questionEvent = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })
          expect(questionEvent.value).toMatchObject({
            kind: 'requestPending',
            request: {
              kind: 'question',
              questions: [
                { id: 'language', prompt: 'Which language?', multiSelect: false, options: [{ label: 'Rust' }] },
              ],
            },
          })
          const question = questionEvent.value?.kind === 'requestPending' ? questionEvent.value.request : undefined
          if (!question) throw new Error('Expected a pending question event')
          const invalidAnswer = yield* Effect.exit(
            session.respond(runId, question.requestId, context.generation, {
              kind: 'answers',
              answers: { language: 'Go' },
            }),
          )
          expect(invalidAnswer._tag).toBe('Failure')
          expect(yield* Queue.size(server.output)).toBe(0)
          yield* session.respond(runId, question.requestId, context.generation, {
            kind: 'answers',
            answers: { language: 'Rust' },
          })
          expect(yield* server.read).toEqual({
            id: 'native-question-1',
            result: { answers: { language: { answers: ['Rust'] } } },
          })
          const questionResolved = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })

          yield* server.send({
            method: 'turn/completed',
            params: { threadId: 'thread-native-1', turn: { id: 'turn-native-1', status: 'completed' } },
          })
          const completed = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })
          expect(questionResolved.value).toMatchObject({ kind: 'requestResolved', requestId: question.requestId })
          expect(completed.value).toMatchObject({ kind: 'turnCompleted', nativeTurnId: 'turn-native-1' })
          expect((yield* Effect.exit(session.steer(runId, accepted.nativeTurnId, 'too late')))._tag).toBe('Failure')
          expect(
            (yield* Effect.exit(
              session.submit({ runId, messages: [{ role: 'user', content: 'duplicate' }], attachmentIds: [] }),
            ))._tag,
          ).toBe('Failure')
          yield* connection.close(100)
          return { nativeTurnId: accepted.nativeTurnId, closed: server.closed() }
        }),
      ),
    )

    expect(outcome).toEqual({ nativeTurnId: 'turn-native-1', closed: true })
  })

  it('resumes the exact native thread and replays historical assistant text as replay facts', async () => {
    const server = fakeServer()
    const replay = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(
            connection.loadSession(context, { nativeSessionId: 'thread-existing', generation: context.generation }),
          )
          const resume = yield* server.read
          expect(resume.method).toBe('thread/resume')
          expect(resume.params).toMatchObject({ threadId: 'thread-existing', cwd: context.workspacePath })
          yield* server.send({
            id: resume.id,
            result: {
              cwd: context.workspacePath,
              thread: {
                id: 'thread-existing',
                turns: [
                  {
                    id: 'turn-previous',
                    items: [{ type: 'agentMessage', id: 'item-previous', text: 'Earlier result' }],
                  },
                ],
              },
            },
          })
          const session = yield* Fiber.join(opening)
          return yield* Stream.runCollect(session.reconcile())
        }),
      ),
    )

    expect(Array.from(replay)).toEqual([
      {
        cursor: 'turn-previous:item-previous',
        replay: true,
        event: { kind: 'textDelta', text: 'Earlier result', itemId: 'item-previous' },
      },
    ])
  })

  it('replays bounded early events only after matching the returned native turn ID', async () => {
    const server = fakeServer()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-early-events' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-early-events' as Parameters<typeof session.submit>[0]['runId']
          const iterable = yield* Stream.toAsyncIterableEffect(session.events(runId))
          const iterator = iterable[Symbol.asyncIterator]()
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: 'Start' }], attachmentIds: [] }),
          )
          const turnStart = yield* server.read
          yield* server.send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-early-events',
              turnId: 'native-previous',
              itemId: 'stale-text',
              delta: 'stale',
            },
          })
          yield* server.send({
            method: 'turn/completed',
            params: {
              threadId: 'thread-early-events',
              turn: { id: 'native-previous', status: 'completed' },
            },
          })
          yield* server.send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-early-events',
              turnId: 'native-current',
              itemId: 'early-text',
              delta: 'accepted early',
            },
          })
          yield* server.send({
            id: 'early-approval',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-early-events', turnId: 'native-current', command: 'git status' },
          })
          yield* server.send({
            method: 'turn/completed',
            params: {
              threadId: 'thread-early-events',
              turn: { id: 'native-current', status: 'completed' },
            },
          })
          yield* server.send({ id: turnStart.id, result: { turn: { id: 'native-current', status: 'completed' } } })
          const accepted = yield* Fiber.join(submitting)
          expect(accepted.nativeTurnId).toBe('native-current')

          const earlyText = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })
          expect(earlyText.value).toMatchObject({ kind: 'textDelta', text: 'accepted early', itemId: 'early-text' })
          const approval = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })
          expect(approval.value).toMatchObject({ kind: 'requestPending', request: { prompt: 'git status' } })
          const pending = approval.value?.kind === 'requestPending' ? approval.value.request : undefined
          if (!pending) throw new Error('Expected early approval request to be retained')
          expect(yield* Queue.size(server.output)).toBe(0)
          const terminal = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })
          expect(terminal.value).toMatchObject({ kind: 'turnCompleted', nativeTurnId: 'native-current' })
          yield* connection.close(100)
          return [earlyText.value?.kind, approval.value?.kind, terminal.value?.kind]
        }),
      ),
    )

    expect(result).toEqual(['textDelta', 'requestPending', 'turnCompleted'])
  })

  it('uses the native tool type when an item-started event has an empty name', async () => {
    const server = fakeServer()
    const event = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-empty-tool-name' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-empty-tool-name' as Parameters<typeof session.submit>[0]['runId']
          const iterable = yield* Stream.toAsyncIterableEffect(session.events(runId))
          const iterator = iterable[Symbol.asyncIterator]()
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: 'Start a tool' }], attachmentIds: [] }),
          )
          const turnStart = yield* server.read
          yield* server.send({
            id: turnStart.id,
            result: { turn: { id: 'native-empty-tool-name', status: 'inProgress' } },
          })
          yield* Fiber.join(submitting)
          yield* server.send({
            method: 'item/started',
            params: {
              threadId: 'thread-empty-tool-name',
              turnId: 'native-empty-tool-name',
              item: { id: 'item-empty-tool-name', type: 'commandExecution', name: '' },
            },
          })
          const next = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('tool event stream failed'),
          })
          yield* connection.close(100)
          return next.value
        }),
      ),
    )

    expect(event).toMatchObject({
      kind: 'toolStarted',
      toolCallId: 'item-empty-tool-name',
      name: 'commandExecution',
    })
  })

  it('marks a turn delivery uncertain when the peer disconnects after receiving the mutation', async () => {
    const server = fakeServer()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-disconnect' } } })
          const session = yield* Fiber.join(opening)
          const submit = yield* Effect.forkScoped(
            session.submit({
              runId: 'run-disconnect' as Parameters<typeof session.submit>[0]['runId'],
              messages: [{ role: 'user', content: 'Do work' }],
              attachmentIds: [],
            }),
          )
          const mutation = yield* server.read
          expect(mutation.method).toBe('turn/start')
          yield* Queue.shutdown(server.input)
          const exit = yield* Fiber.await(submit)
          return exit._tag
        }),
      ),
    )

    expect(result).toBe('Failure')
  })

  it.each(['interrupt', 'steer'] as const)(
    'reports an uncertain outcome when a transmitted %s loses its connection',
    async operationName => {
      const server = fakeServer()
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(server)
            const opening = yield* Effect.forkScoped(connection.openSession(context))
            const start = yield* server.read
            yield* server.send({ id: start.id, result: { thread: { id: `thread-${operationName}-disconnect` } } })
            const session = yield* Fiber.join(opening)
            const runId = `run-${operationName}-disconnect` as Parameters<typeof session.submit>[0]['runId']
            const submitting = yield* Effect.forkScoped(
              session.submit({ runId, messages: [{ role: 'user', content: 'Start a turn' }], attachmentIds: [] }),
            )
            const turnStart = yield* server.read
            yield* server.send({
              id: turnStart.id,
              result: { turn: { id: `native-${operationName}-disconnect`, status: 'inProgress' } },
            })
            yield* Fiber.join(submitting)

            const nativeTurnId = `native-${operationName}-disconnect`
            const operation =
              operationName === 'interrupt'
                ? session.interrupt(runId, nativeTurnId).pipe(
                    Effect.map(() => 'success'),
                    Effect.catch(error => Effect.succeed(error._tag === 'AgentDriverError' ? error.code : error._tag)),
                  )
                : session.steer(runId, nativeTurnId, 'Continue').pipe(
                    Effect.map(() => 'success'),
                    Effect.catch(error => Effect.succeed(error._tag === 'AgentDriverError' ? error.code : error._tag)),
                  )
            const mutating = yield* Effect.forkScoped(operation)
            const request = yield* server.read
            expect(request.method).toBe(`turn/${operationName}`)
            yield* Queue.shutdown(server.input)
            return yield* Fiber.join(mutating)
          }),
        ),
      )

      expect(outcome).toBe('outcome-uncertain')
    },
  )

  it('fails active run event streams when the connection is explicitly closed', async () => {
    const server = fakeServer()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-close-active' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-close-active' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: 'Keep running' }], attachmentIds: [] }),
          )
          const turnStart = yield* server.read
          yield* server.send({
            id: turnStart.id,
            result: { turn: { id: 'native-close-active', status: 'inProgress' } },
          })
          yield* Fiber.join(submitting)

          const consuming = yield* Effect.forkScoped(Stream.runCollect(session.events(runId)))
          yield* connection.close(100)
          return yield* Effect.timeoutOption(Fiber.await(consuming), '100 millis')
        }),
      ),
    )

    expect(result._tag).toBe('Some')
    if (result._tag === 'Some') expect(result.value._tag).toBe('Failure')
  })

  it('keeps a malformed turn response fenced because native execution may still be active', async () => {
    const server = fakeServer()
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-malformed-turn' } } })
          const session = yield* Fiber.join(opening)
          const first = yield* Effect.forkScoped(
            session.submit({
              runId: 'run-malformed-turn' as Parameters<typeof session.submit>[0]['runId'],
              messages: [{ role: 'user', content: 'Start a turn' }],
              attachmentIds: [],
            }),
          )
          const turnStart = yield* server.read
          expect(turnStart.method).toBe('turn/start')
          yield* server.send({ id: turnStart.id, result: { turn: { id: 'native-malformed', status: 'unknown' } } })
          expect((yield* Fiber.await(first))._tag).toBe('Failure')
          const retry = yield* Effect.exit(
            session.submit({
              runId: 'run-after-malformed' as Parameters<typeof session.submit>[0]['runId'],
              messages: [{ role: 'user', content: 'Must remain fenced' }],
              attachmentIds: [],
            }),
          )
          expect(retry._tag).toBe('Failure')
          expect(yield* Queue.size(server.output)).toBe(0)
          yield* connection.close(100)
          return 'fenced'
        }),
      ),
    )

    expect(status).toBe('fenced')
  })

  it('rejects buffered native requests after malformed turn acceptance without releasing the active fence', async () => {
    const server = fakeServer()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-malformed-early-request' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-malformed-early-request' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: 'Start a turn' }], attachmentIds: [] }),
          )
          const turnStart = yield* server.read
          yield* server.send({
            id: 'buffered-approval',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-malformed-early-request',
              turnId: 'native-malformed-early-request',
              command: 'git status',
            },
          })
          yield* server.send({
            id: turnStart.id,
            result: { turn: { id: 'native-malformed-early-request', status: 'unknown' } },
          })
          expect((yield* Fiber.await(submitting))._tag).toBe('Failure')

          const response = yield* Effect.timeoutOption(server.read, '100 millis')
          const retry = yield* Effect.exit(
            session.submit({
              runId: 'run-after-malformed-early-request' as typeof runId,
              messages: [{ role: 'user', content: 'Must remain fenced' }],
              attachmentIds: [],
            }),
          )
          yield* connection.close(100)
          return { response: response._tag === 'Some' ? response.value : undefined, retry: retry._tag }
        }),
      ),
    )

    expect(result.response).toMatchObject({ id: 'buffered-approval', error: { code: -32600 } })
    expect(result.retry).toBe('Failure')
  })

  it('tracks a cancelled submit through turn acceptance and interrupts only its native turn', async () => {
    const server = fakeServer()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-cancelled-submit' } } })
          const session = yield* Fiber.join(opening)
          const cancelledRunId = 'run-cancelled-submit' as Parameters<typeof session.submit>[0]['runId']
          const cancelledEvents = yield* Stream.toAsyncIterableEffect(session.events(cancelledRunId))
          const cancelledIterator = cancelledEvents[Symbol.asyncIterator]()
          const submitting = yield* Effect.forkScoped(
            session.submit({
              runId: cancelledRunId,
              messages: [{ role: 'user', content: 'May be cancelled by the caller' }],
              attachmentIds: [],
            }),
          )
          const turnStart = yield* server.read
          yield* Fiber.interrupt(submitting)
          const cancelled = yield* Fiber.await(submitting)
          expect(cancelled._tag).toBe('Failure')

          yield* server.send({
            id: turnStart.id,
            result: { turn: { id: 'native-cancelled-submit', status: 'inProgress' } },
          })
          const interrupt = yield* server.read
          expect(interrupt.method).toBe('turn/interrupt')
          expect(interrupt.params).toMatchObject({
            threadId: 'thread-cancelled-submit',
            turnId: 'native-cancelled-submit',
          })
          const overlapping = yield* Effect.exit(
            session.submit({
              runId: 'run-before-cancel-terminal' as typeof cancelledRunId,
              messages: [{ role: 'user', content: 'Must wait for terminal status' }],
              attachmentIds: [],
            }),
          )
          expect(overlapping._tag).toBe('Failure')
          expect(yield* Queue.size(server.output)).toBe(0)
          yield* server.send({ id: interrupt.id, result: {} })
          yield* server.send({
            method: 'turn/interrupted',
            params: { threadId: 'thread-cancelled-submit', turnId: 'native-cancelled-submit' },
          })
          const interrupted = yield* Effect.tryPromise({
            try: () => cancelledIterator.next(),
            catch: () => new Error('cancelled run stream failed'),
          })
          expect(interrupted.value).toMatchObject({ kind: 'turnInterrupted', nativeTurnId: 'native-cancelled-submit' })
          yield* server.send({
            id: 'probe-after-cancel-terminal',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-cancelled-submit', turnId: 'native-cancelled-submit', command: 'git status' },
          })
          expect((yield* server.read).error).toBeDefined()

          const nextRunId = 'run-after-cancel-terminal' as typeof cancelledRunId
          const nextEvents = yield* Stream.toAsyncIterableEffect(session.events(nextRunId))
          const nextIterator = nextEvents[Symbol.asyncIterator]()
          const nextSubmit = yield* Effect.forkScoped(
            session.submit({
              runId: nextRunId,
              messages: [{ role: 'user', content: 'Start after confirmed terminal status' }],
              attachmentIds: [],
            }),
          )
          const nextStart = yield* server.read
          yield* server.send({
            method: 'turn/completed',
            params: {
              threadId: 'thread-cancelled-submit',
              turn: { id: 'native-cancelled-submit', status: 'completed' },
            },
          })
          yield* server.send({ id: nextStart.id, result: { turn: { id: 'native-next', status: 'inProgress' } } })
          yield* Fiber.join(nextSubmit)
          yield* server.send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-cancelled-submit',
              turnId: 'native-cancelled-submit',
              itemId: 'old-late-text',
              delta: 'must not leak',
            },
          })
          yield* server.send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-cancelled-submit',
              turnId: 'native-next',
              itemId: 'new-text',
              delta: 'new run',
            },
          })
          yield* server.send({
            method: 'turn/completed',
            params: { threadId: 'thread-cancelled-submit', turn: { id: 'native-next', status: 'completed' } },
          })
          const newRunText = yield* Effect.tryPromise({
            try: () => nextIterator.next(),
            catch: () => new Error('new run stream failed'),
          })
          const newRunTerminal = yield* Effect.tryPromise({
            try: () => nextIterator.next(),
            catch: () => new Error('new run stream failed'),
          })
          yield* connection.close(100)
          return [newRunText.value?.kind, newRunTerminal.value?.kind]
        }),
      ),
    )

    expect(result).toEqual(['textDelta', 'turnCompleted'])
  })

  it('remembers an explicit interrupt until turn/start returns native identity', async () => {
    const server = fakeServer()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-interrupt-before-acceptance' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-interrupt-before-acceptance' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: 'Start and interrupt' }], attachmentIds: [] }),
          )
          const turnStart = yield* server.read
          const acknowledgement = yield* session.interrupt(runId)
          yield* server.send({
            id: turnStart.id,
            result: { turn: { id: 'native-interrupt-before-acceptance', status: 'inProgress' } },
          })
          const interruptRequest = yield* Effect.timeoutOption(server.read, '500 millis')
          if (interruptRequest._tag === 'None') return { acknowledgement, method: undefined, overlap: undefined }

          yield* server.send({ id: interruptRequest.value.id, result: {} })
          yield* Fiber.join(submitting)
          const overlap = yield* Effect.exit(
            session.submit({
              runId: 'run-before-interrupt-terminal' as typeof runId,
              messages: [{ role: 'user', content: 'Wait for native terminal evidence' }],
              attachmentIds: [],
            }),
          )
          yield* server.send({
            method: 'turn/interrupted',
            params: { threadId: 'thread-interrupt-before-acceptance', turnId: 'native-interrupt-before-acceptance' },
          })
          yield* server.send({
            id: 'probe-after-interrupted-terminal',
            method: 'unsupported/native/request',
            params: { threadId: 'thread-interrupt-before-acceptance' },
          })
          yield* server.read
          const next = yield* Effect.forkScoped(
            session.submit({
              runId: 'run-after-interrupt-terminal' as typeof runId,
              messages: [{ role: 'user', content: 'Start after terminal evidence' }],
              attachmentIds: [],
            }),
          )
          const nextStart = yield* server.read
          yield* server.send({
            id: nextStart.id,
            result: { turn: { id: 'native-after-interrupt', status: 'inProgress' } },
          })
          yield* Fiber.join(next)
          yield* connection.close(100)
          return { acknowledgement, method: interruptRequest.value.method, overlap: overlap._tag }
        }),
      ),
    )

    expect(result.acknowledgement).toEqual({ acknowledged: false, termination: 'unknown' })
    expect(result.method).toBe('turn/interrupt')
    expect(result.overlap).toBe('Failure')
  })

  it('does not apply an early interrupt to a different native turn than the expected ID', async () => {
    const server = fakeServer()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-stale-early-interrupt' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-stale-early-interrupt' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: 'Start and interrupt' }], attachmentIds: [] }),
          )
          const turnStart = yield* server.read
          const acknowledgement = yield* session.interrupt(runId, 'native-expected-but-stale')
          yield* server.send({
            id: turnStart.id,
            result: { turn: { id: 'native-actual-turn', status: 'inProgress' } },
          })
          const interruptRequest = yield* Effect.timeoutOption(server.read, '100 millis')
          if (interruptRequest._tag === 'Some') yield* server.send({ id: interruptRequest.value.id, result: {} })
          yield* Fiber.join(submitting)
          yield* connection.close(100)
          return { acknowledgement, interruptRequest: interruptRequest._tag }
        }),
      ),
    )

    expect(result.acknowledgement).toEqual({ acknowledged: false, termination: 'unknown' })
    expect(result.interruptRequest).toBe('None')
  })

  it('releases drained completed event buffers and accepts more than eight sequential turns', async () => {
    const server = fakeServer()
    const count = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-many-turns' } } })
          const session = yield* Fiber.join(opening)

          for (let index = 0; index < 10; index += 1) {
            const runId = `run-many-${index}` as Parameters<typeof session.submit>[0]['runId']
            const submitting = yield* Effect.forkScoped(
              session.submit({ runId, messages: [{ role: 'user', content: `Turn ${index}` }], attachmentIds: [] }),
            )
            const mutation = yield* server.read
            yield* server.send({
              id: mutation.id,
              result: { turn: { id: `native-many-${index}`, status: 'inProgress' } },
            })
            yield* Fiber.join(submitting)
            yield* server.send({
              method: 'turn/completed',
              params: {
                threadId: 'thread-many-turns',
                turn: { id: `native-many-${index}`, status: 'completed' },
              },
            })
            yield* Stream.runCollect(session.events(runId))
            const duplicateRead = yield* Effect.exit(Stream.runCollect(session.events(runId)))
            expect(duplicateRead._tag).toBe('Failure')
          }
          yield* connection.close(100)
          return 10
        }),
      ),
    )

    expect(count).toBe(10)
  })

  it('keeps a session fenced after event overflow until native terminal reconciliation', async () => {
    const server = fakeServer()
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-overflow' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-overflow' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: 'Produce events' }], attachmentIds: [] }),
          )
          const turnStart = yield* server.read
          yield* server.send({ id: turnStart.id, result: { turn: { id: 'native-overflow', status: 'inProgress' } } })
          yield* Fiber.join(submitting)
          for (let index = 0; index < 65; index += 1) {
            yield* server.send({
              method: 'item/agentMessage/delta',
              params: {
                threadId: 'thread-overflow',
                turnId: 'native-overflow',
                itemId: `item-${index}`,
                delta: 'x',
              },
            })
          }
          yield* server.send({
            id: 'probe-before-terminal',
            method: 'unsupported/native/request',
            params: { threadId: 'thread-overflow', turnId: 'native-overflow' },
          })
          const probeBefore = yield* server.read
          expect(probeBefore.id).toBe('probe-before-terminal')
          expect(probeBefore.error).toBeDefined()
          const streamExit = yield* Effect.exit(Stream.runCollect(session.events(runId)))
          expect(streamExit._tag).toBe('Failure')
          const nextRun = yield* Effect.exit(
            session.submit({
              runId: 'run-after-overflow' as typeof runId,
              messages: [{ role: 'user', content: 'Must wait' }],
              attachmentIds: [],
            }),
          )
          expect(nextRun._tag).toBe('Failure')
          expect(yield* Queue.size(server.output)).toBe(0)

          const interrupting = yield* Effect.forkScoped(session.interrupt(runId, 'native-overflow'))
          const interrupt = yield* server.read
          expect(interrupt.method).toBe('turn/interrupt')
          yield* server.send({ id: interrupt.id, result: {} })
          expect((yield* Fiber.join(interrupting)).termination).toBe('unknown')

          yield* server.send({
            method: 'turn/completed',
            params: {
              threadId: 'thread-overflow',
              turn: { id: 'native-overflow', status: 'completed' },
            },
          })
          yield* server.send({
            id: 'probe-after-terminal',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-overflow', turnId: 'native-overflow', command: 'git status' },
          })
          const probeResponse = yield* server.read
          expect(probeResponse.id).toBe('probe-after-terminal')
          expect(probeResponse.error).toBeDefined()
          const retry = yield* Effect.forkScoped(
            session.submit({
              runId: 'run-after-terminal' as typeof runId,
              messages: [{ role: 'user', content: 'Now allowed' }],
              attachmentIds: [],
            }),
          )
          const retryStart = yield* server.read
          expect(retryStart.method).toBe('turn/start')
          yield* server.send({ id: retryStart.id, result: { turn: { id: 'native-retry', status: 'inProgress' } } })
          yield* Fiber.join(retry)
          yield* server.send({
            method: 'turn/completed',
            params: { threadId: 'thread-overflow', turn: { id: 'native-retry', status: 'completed' } },
          })
          yield* Stream.runCollect(session.events('run-after-terminal' as typeof runId))
          yield* connection.close(100)
          return 'recovered'
        }),
      ),
    )

    expect(status).toBe('recovered')
  })
})

it.skipIf(process.env.CODEX_APP_SERVER_SMOKE !== '1')(
  'performs an installed Codex App Server handshake without starting inference',
  async () => {
    const { NodeServices } = await import('@effect/platform-node')
    const identity = await Effect.runPromise(
      Effect.scoped(
        codexAgentDriverConnect({ connectionId: 'codex-installed-smoke' }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.timeout('15 seconds'),
          Effect.flatMap(connection =>
            Effect.gen(function* () {
              const result = connection.identity
              yield* connection.close(1000)
              return result
            }),
          ),
        ),
      ),
    )
    expect(identity.driverId).toBe('codex-app-server')
  },
)
