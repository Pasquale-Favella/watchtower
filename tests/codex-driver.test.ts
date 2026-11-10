import { Deferred, Effect, Fiber, Queue, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import type { AgentSessionContext } from '@/core/ports/agent-driver.js'
import {
  codexAgentDriverConnect,
  codexAgentDriverFromTransport,
} from '@/infrastructure/agent-harnesses/drivers/codex/driver.js'
import type { JsonRpcTransport } from '@/infrastructure/agent-harnesses/drivers/json-rpc.js'
import { projectConversationView } from '@/renderer/features/workspace/conversation-view.js'
import type { WorkspaceConversationPageItem } from '@/shared/schemas/workspace-store.js'

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
  it.each([context.workspacePath, `${context.workspacePath}/.`])(
    'discovers workspace skills and native slash commands for cwd %s',
    async returnedCwd => {
      const server = fakeServer()
      const catalog = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(server)
            if (!connection.discoverPromptCatalog)
              return yield* Effect.die(new Error('Codex must expose prompt catalog discovery'))
            const discovering = yield* Effect.forkScoped(connection.discoverPromptCatalog(context.workspacePath))
            const request = yield* server.read
            expect(request.method).toBe('skills/list')
            expect(request.params).toEqual({ cwds: [context.workspacePath] })
            yield* server.send({
              id: request.id,
              result: {
                data: [
                  {
                    cwd: returnedCwd,
                    skills: [
                      {
                        name: 'review',
                        scope: 'repo',
                        enabled: true,
                        description: 'Review the current changes',
                        shortDescription: 'Review changes',
                        interface: { shortDescription: 'Review changes', userInvocable: true },
                      },
                      { name: 'app-skill', scope: 'app', enabled: true },
                      { name: 'system-skill', scope: 'system', enabled: true },
                      { name: 'internal', enabled: false, description: null, shortDescription: null, interface: null },
                    ],
                  },
                ],
              },
            })
            return yield* Fiber.join(discovering)
          }),
        ),
      )

      expect(catalog.skills).toEqual([
        {
          name: 'review',
          scope: 'repo',
          enabled: true,
          description: 'Review the current changes',
          userInvocable: true,
        },
        { name: 'app-skill', scope: 'app', enabled: true },
        { name: 'system-skill', scope: 'system', enabled: true },
        { name: 'internal', enabled: false },
      ])
      expect(catalog.skillsComplete).toBe(true)
      expect(catalog.commands).toEqual([
        { name: 'compact', description: 'Compact this conversation to free up context.' },
      ])
    },
  )

  it('does not use skills returned for another checkout when the requested cwd is absent', async () => {
    const server = fakeServer()
    const catalog = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          if (!connection.discoverPromptCatalog)
            return yield* Effect.die(new Error('Codex must expose prompt catalog discovery'))
          const discovering = yield* Effect.forkScoped(connection.discoverPromptCatalog(context.workspacePath))
          const request = yield* server.read
          yield* server.send({
            id: request.id,
            result: {
              data: [{ cwd: 'C:\\another-checkout', skills: [{ name: 'foreign-skill', enabled: true }] }],
            },
          })
          return yield* Fiber.join(discovering)
        }),
      ),
    )

    expect(catalog.skills).toEqual([])
    expect(catalog.skillsComplete).toBe(true)
  })

  it('owns a native goal across announced turns and pauses it before interrupting', async () => {
    const server = fakeServer()
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const thread = yield* server.read
          yield* server.send({ id: thread.id, result: { thread: { id: 'thread-goal' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-goal' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({
              runId,
              messages: [{ role: 'user', content: '/goal Finish the migration' }],
              attachmentIds: [],
            }),
          )
          const setting = yield* server.read
          expect(setting.method).toBe('thread/goal/set')
          expect(setting.params).toEqual({
            threadId: 'thread-goal',
            objective: 'Finish the migration',
            status: 'active',
          })
          const initialGoal = {
            objective: 'Finish the migration',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          yield* server.send({ id: setting.id, result: { goal: initialGoal } })
          const initialRead = yield* server.read
          expect(initialRead.method).toBe('thread/goal/get')
          yield* server.send({ id: initialRead.id, result: { goal: initialGoal } })
          const accepted = yield* Fiber.join(submitting)
          expect(accepted.nativeTurnId).toBeUndefined()
          expect(accepted.nativeSessionId).toBe('thread-goal')
          expect(server.output).toBeDefined()

          const secondTurnStarted = yield* Deferred.make<void>()
          const collecting = yield* Effect.forkScoped(
            session.events(runId).pipe(
              Stream.tap(event =>
                event.kind === 'goalTurnStarted' && event.nativeTurnId === 'goal-turn-2'
                  ? Deferred.succeed(secondTurnStarted, undefined)
                  : Effect.void,
              ),
              Stream.runCollect,
            ),
          )
          yield* server.send({
            method: 'turn/started',
            params: { threadId: 'thread-goal', turn: { id: 'goal-turn-1' } },
          })
          yield* server.send({
            method: 'turn/completed',
            params: { threadId: 'thread-goal', turn: { id: 'goal-turn-1', status: 'completed' } },
          })
          const nextGoalRead = yield* server.read
          expect(nextGoalRead.method).toBe('thread/goal/get')
          yield* server.send({ id: nextGoalRead.id, result: { goal: initialGoal } })
          yield* server.send({
            method: 'turn/started',
            params: { threadId: 'thread-goal', turn: { id: 'goal-turn-2' } },
          })

          yield* Deferred.await(secondTurnStarted)
          const pausing = yield* Effect.forkScoped(session.steer(runId, 'goal-turn-2', '/goal pause'))
          const pause = yield* server.read
          expect(pause.method).toBe('thread/goal/set')
          expect(pause.params).toEqual({ threadId: 'thread-goal', status: 'paused' })
          yield* server.send({ id: pause.id, result: { goal: { ...initialGoal, status: 'paused' } } })
          const pauseRead = yield* server.read
          expect(pauseRead.method).toBe('thread/goal/get')
          yield* server.send({ id: pauseRead.id, result: { goal: { ...initialGoal, status: 'paused' } } })
          const interrupt = yield* server.read
          expect(interrupt.method).toBe('turn/interrupt')
          expect(interrupt.params).toEqual({ threadId: 'thread-goal', turnId: 'goal-turn-2' })
          yield* server.send({ id: interrupt.id, result: {} })
          expect(yield* Fiber.join(pausing)).toEqual({ outcome: 'accepted' })
          yield* server.send({
            method: 'turn/interrupted',
            params: { threadId: 'thread-goal', turnId: 'goal-turn-2' },
          })
          const finalGoalRead = yield* server.read
          expect(finalGoalRead.method).toBe('thread/goal/get')
          yield* server.send({ id: finalGoalRead.id, result: { goal: { ...initialGoal, status: 'paused' } } })
          return yield* Fiber.join(collecting)
        }),
      ),
    )

    expect(events.map(event => event.kind)).toEqual([
      'goalUpdated',
      'goalTurnStarted',
      'goalTurnCompleted',
      'goalUpdated',
      'goalTurnStarted',
      'goalUpdated',
      'goalTurnCompleted',
      'goalUpdated',
      'turnInterrupted',
    ])
    expect(events.filter(event => event.kind === 'goalTurnStarted').map(event => event.nativeTurnId)).toEqual([
      'goal-turn-1',
      'goal-turn-2',
    ])
  })

  it('runs /compact through the native method and binds only the native turn ID', async () => {
    const server = fakeServer()
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const thread = yield* server.read
          yield* server.send({ id: thread.id, result: { thread: { id: 'thread-compact' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-compact' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: '/compact' }], attachmentIds: [] }),
          )
          const request = yield* server.read
          expect(request.method).toBe('thread/compact/start')
          expect(request.params).toEqual({ threadId: 'thread-compact' })
          const reading = yield* Effect.forkScoped(Stream.runCollect(session.events(runId)))
          yield* server.send({
            method: 'turn/started',
            params: { threadId: 'thread-compact', turn: { id: 'native-compact-turn' } },
          })
          yield* server.send({ id: request.id, result: {} })
          const accepted = yield* Fiber.join(submitting)
          expect(accepted).toEqual({
            nativeTurnId: 'native-compact-turn',
            nativeSessionId: 'thread-compact',
            generation: context.generation,
          })
          yield* server.send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-compact',
              turnId: 'native-compact-turn',
              itemId: 'compact-message',
              delta: 'Context compacted.',
            },
          })
          yield* server.send({
            method: 'turn/completed',
            params: { threadId: 'thread-compact', turn: { id: 'native-compact-turn', status: 'completed' } },
          })
          return yield* Fiber.join(reading)
        }),
      ),
    )

    expect(events.map(event => event.kind)).toEqual(['turnStarted', 'textDelta', 'turnCompleted'])
    expect(events.every(event => !('nativeTurnId' in event) || event.nativeTurnId === 'native-compact-turn')).toBe(true)
  })

  it('leaves the native turn ID absent until Codex announces it', async () => {
    const server = fakeServer()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const thread = yield* server.read
          yield* server.send({ id: thread.id, result: { thread: { id: 'thread-compact-late-id' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-compact-late-id' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: '/compact' }], attachmentIds: [] }),
          )
          const request = yield* server.read
          expect(request.method).toBe('thread/compact/start')
          yield* server.send({ id: request.id, result: {} })
          const accepted = yield* Fiber.join(submitting)
          expect(accepted).toEqual({ nativeSessionId: 'thread-compact-late-id', generation: context.generation })
          const reading = yield* Effect.forkScoped(Stream.runCollect(session.events(runId)))
          yield* server.send({
            method: 'turn/started',
            params: { threadId: 'thread-compact-late-id', turn: { id: 'native-late-turn' } },
          })
          yield* server.send({
            method: 'turn/completed',
            params: { threadId: 'thread-compact-late-id', turn: { id: 'native-late-turn', status: 'completed' } },
          })
          return yield* Fiber.join(reading)
        }),
      ),
    )

    expect(result).toEqual([
      { kind: 'turnStarted', nativeTurnId: 'native-late-turn' },
      { kind: 'turnCompleted', nativeTurnId: 'native-late-turn' },
    ])
  })

  it('surfaces an unsupported /compact RPC as a typed driver failure', async () => {
    const server = fakeServer()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const thread = yield* server.read
          yield* server.send({ id: thread.id, result: { thread: { id: 'thread-no-compact' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-no-compact' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            Effect.match(
              session.submit({ runId, messages: [{ role: 'user', content: '/compact' }], attachmentIds: [] }),
              {
                onFailure: left => ({ _tag: 'Left' as const, left }),
                onSuccess: right => ({ _tag: 'Right' as const, right }),
              },
            ),
          )
          const request = yield* server.read
          expect(request.method).toBe('thread/compact/start')
          yield* server.send({ id: request.id, error: { code: -32601, message: 'Method not found' } })
          return yield* Fiber.join(submitting)
        }),
      ),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left).toMatchObject({ _tag: 'AgentDriverError', code: 'protocol-error' })
  })

  it.each([
    { size: 40000, control: false },
    { size: 40000, control: true },
    { size: 200000, control: false },
  ])(
    'preserves the final native command snapshot within its output limit, size $size, controls $control',
    async ({ size, control }) => {
      const server = fakeServer()
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(server)
            const opening = yield* Effect.forkScoped(connection.openSession(context))
            const thread = yield* server.read
            yield* server.send({ id: thread.id, result: { thread: { id: 'thread-output' } } })
            const session = yield* Fiber.join(opening)
            const runId = 'run-output' as Parameters<typeof session.submit>[0]['runId']
            const submitting = yield* Effect.forkScoped(
              session.submit({ runId, messages: [{ role: 'user', content: 'Print output' }], attachmentIds: [] }),
            )
            const start = yield* server.read
            yield* server.send({ id: start.id, result: { turn: { id: 'turn-output', status: 'inProgress' } } })
            yield* Fiber.join(submitting)
            const reading = yield* Effect.forkScoped(session.events(runId).pipe(Stream.runCollect))
            const notify = (method: string, extra: Record<string, unknown>) =>
              server.send({ method, params: { threadId: 'thread-output', turnId: 'turn-output', ...extra } })
            const output = `head\n${(control ? '\0' : 'x').repeat(size)}\ntail`
            yield* notify('item/started', { item: { id: 'shell', type: 'commandExecution', command: 'print' } })
            for (let offset = 0; offset < output.length; offset += 8192)
              yield* notify('item/commandExecution/outputDelta', {
                itemId: 'shell',
                delta: output.slice(offset, offset + 8192),
              })
            yield* notify('item/completed', {
              item: {
                id: 'shell',
                type: 'commandExecution',
                aggregatedOutput: output,
                exitCode: 0,
                status: 'completed',
              },
            })
            yield* notify('turn/completed', { turn: { id: 'turn-output', status: 'completed' } })
            const events = yield* Fiber.join(reading)
            const items: WorkspaceConversationPageItem[] = events.map((event, index) => ({
              event: {
                schemaVersion: 1,
                sequence: index + 1,
                kind: 'driverEvent',
                runId,
                taskId: context.taskId,
                generation: context.generation,
                occurredAt: new Date(Date.UTC(2026, 10, 4, 12, 0, index)).toISOString(),
                data: { event },
              },
            }))
            const tool = projectConversationView(items)
              .entries.flatMap(entry => (entry.kind === 'assistant' ? entry.blocks : []))
              .find(block => block.kind === 'tool')
            expect(tool).toMatchObject({ kind: 'tool', status: 'completed' })
            if (tool?.kind !== 'tool') throw new Error('Expected projected tool output')
            if (size < 128 * 1024) expect(tool.output).toBe(output)
            else {
              expect(tool.output).toContain('… [truncated]')
              expect(new TextEncoder().encode(tool.output ?? '').byteLength).toBeLessThanOrEqual(128 * 1024)
            }
            expect(events.every(event => new TextEncoder().encode(JSON.stringify(event)).byteLength <= 64 * 1024)).toBe(
              true,
            )
            expect(events.filter(event => event.kind === 'toolCompleted')).toEqual([
              expect.not.objectContaining({ output: expect.any(String) }),
            ])
          }),
        ),
      )
    },
  )

  it('preserves native plans, streamed command output and file changes with failed exit status', async () => {
    const server = fakeServer()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const thread = yield* server.read
          yield* server.send({ id: thread.id, result: { thread: { id: 'thread-rich' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-rich' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: 'Check files' }], attachmentIds: [] }),
          )
          const start = yield* server.read
          yield* server.send({ id: start.id, result: { turn: { id: 'turn-rich', status: 'inProgress' } } })
          yield* Fiber.join(submitting)
          const reading = yield* Effect.forkScoped(session.events(runId).pipe(Stream.runCollect))
          const notify = (method: string, extra: Record<string, unknown>) =>
            server.send({ method, params: { threadId: 'thread-rich', turnId: 'turn-rich', ...extra } })
          yield* notify('turn/plan/updated', {
            explanation: 'Check before editing',
            plan: [
              { step: 'Inspect', status: 'completed' },
              { step: 'Fix', status: 'inProgress' },
            ],
          })
          yield* notify('item/started', {
            item: { id: 'shell', type: 'commandExecution', command: ['npm', 'test'], cwd: context.workspacePath },
          })
          yield* notify('item/commandExecution/outputDelta', { itemId: 'shell', delta: '\u001b[31mFailed\u001b[0m\n' })
          yield* notify('item/completed', {
            item: {
              id: 'shell',
              type: 'commandExecution',
              command: 'npm test',
              status: 'completed',
              aggregatedOutput: 'Failed\n',
              exitCode: 1,
              durationMs: 42,
            },
          })
          yield* notify('item/completed', {
            item: {
              id: 'patch',
              type: 'fileChange',
              status: 'completed',
              changes: [{ path: 'src/app.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' }],
            },
          })
          yield* notify('item/completed', {
            item: {
              id: 'image',
              type: 'imageGeneration',
              status: 'completed',
              result: '',
              savedPath: 'C:\\workspace\\result.png',
            },
          })
          yield* notify('item/completed', { item: { id: 'compact', type: 'contextCompaction' } })
          yield* notify('turn/completed', { turn: { id: 'turn-rich', status: 'completed' } })
          const events = yield* Fiber.join(reading)
          expect(events).toContainEqual({
            kind: 'media',
            itemId: 'image',
            mediaType: 'image/png',
            url: 'C:\\workspace\\result.png',
            alt: 'Generated image',
          })
          expect(events).toContainEqual({ kind: 'nativeNotice', message: 'Agent context compacted.' })
          expect(events).toContainEqual({
            kind: 'planUpdated',
            explanation: 'Check before editing',
            entries: [
              { content: 'Inspect', status: 'completed' },
              { content: 'Fix', status: 'inProgress' },
            ],
          })
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'toolStarted',
              toolCallId: 'shell',
              category: 'command',
              command: 'npm test',
              cwd: context.workspacePath,
            }),
          )
          expect(events).toContainEqual({
            kind: 'toolUpdated',
            toolCallId: 'shell',
            output: '\u001b[31mFailed\u001b[0m\n',
            append: true,
          })
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'toolCompleted',
              toolCallId: 'shell',
              output: 'Failed\n',
              exitCode: 1,
              durationMs: 42,
              error: 'Tool execution failed.',
            }),
          )
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'toolCompleted',
              toolCallId: 'patch',
              category: 'fileWrite',
              changes: [{ path: 'src/app.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }],
            }),
          )
        }),
      ),
    )
  })

  it('discovers native models and effort without opening a thread and sends resolved image and file context', async () => {
    const server = fakeServer()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const inspecting = yield* Effect.forkScoped(connection.discover())
          const catalog = yield* server.read
          expect(catalog.method).toBe('model/list')
          yield* server.send({
            id: catalog.id,
            result: {
              data: [
                {
                  id: 'catalog-model',
                  model: 'native-model',
                  displayName: 'Native model',
                  isDefault: true,
                  supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'More reasoning' }],
                },
              ],
              nextCursor: null,
            },
          })
          const capabilities = yield* Fiber.join(inspecting)
          expect(capabilities.models).toEqual([
            { id: 'native-model', label: 'Native model', modes: [{ id: 'high', label: 'High' }] },
          ])
          expect(capabilities.promptContent).toEqual({ images: true, files: true })
          expect(yield* Queue.size(server.output)).toBe(0)
          const opening = yield* Effect.forkScoped(
            connection.openSession({ ...context, modelId: 'native-model', modeId: 'high' }),
          )
          const thread = yield* server.read
          yield* server.send({ id: thread.id, result: { thread: { id: 'thread-content' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-content' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({
              runId,
              messages: [{ role: 'user', content: 'Inspect this image and file' }],
              attachmentIds: [],
              attachments: [
                {
                  id: 'a'.repeat(64),
                  name: 'image.png',
                  size: 3,
                  source: 'file',
                  mediaType: 'image/png',
                  content: 'YWJj',
                },
                {
                  id: 'b'.repeat(64),
                  name: 'notes.md',
                  size: 5,
                  source: 'reference',
                  mediaType: 'text/plain',
                  content: 'Notes',
                },
              ],
            }),
          )
          const start = yield* server.read
          expect(start.params).toMatchObject({
            model: 'native-model',
            effort: 'high',
            input: [
              { type: 'text', text: 'Inspect this image and file' },
              { type: 'image', url: 'data:image/png;base64,YWJj' },
              { type: 'text', text: expect.stringContaining('Notes') },
            ],
          })
          yield* server.send({ id: start.id, result: { turn: { id: 'turn-content', status: 'inProgress' } } })
          yield* Fiber.join(submitting)
          yield* server.send({
            method: 'turn/completed',
            params: { threadId: 'thread-content', turn: { id: 'turn-content', status: 'completed' } },
          })
          yield* Stream.runCollect(session.events(runId))
          yield* connection.close(100)
        }),
      ),
    )
  })

  it.each([
    {
      accessMode: 'approval-required' as const,
      thread: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
      turn: { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } },
    },
    {
      accessMode: 'auto-accept-edits' as const,
      thread: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
      turn: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } },
    },
    {
      accessMode: 'full-access' as const,
      thread: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
      turn: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
    },
  ])('sends $accessMode natively on thread start and on the turn', async ({ accessMode, thread, turn }) => {
    const server = fakeServer()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession({ ...context, accessMode }))
          const start = yield* server.read
          expect(start.method).toBe('thread/start')
          expect(start.params).toMatchObject(thread)
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-policy' } } })
          const session = yield* Fiber.join(opening)
          const runId = 'run-policy' as Parameters<typeof session.submit>[0]['runId']
          const submitting = yield* Effect.forkScoped(
            session.submit({ runId, messages: [{ role: 'user', content: 'Apply the policy' }], attachmentIds: [] }),
          )
          const turnStart = yield* server.read
          expect(turnStart.method).toBe('turn/start')
          expect(turnStart.params).toMatchObject(turn)
          yield* server.send({ id: turnStart.id, result: { turn: { id: 'turn-policy', status: 'inProgress' } } })
          yield* Fiber.join(submitting)
          yield* server.send({
            method: 'turn/completed',
            params: { threadId: 'thread-policy', turn: { id: 'turn-policy', status: 'completed' } },
          })
          yield* Stream.runCollect(session.events(runId))
          yield* connection.close(100)
        }),
      ),
    )
  })

  it('applies the fail-safe approval-required policy when a context has no access mode', async () => {
    const server = fakeServer()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const opening = yield* Effect.forkScoped(connection.openSession(context))
          const start = yield* server.read
          expect(start.params).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'read-only' })
          yield* server.send({ id: start.id, result: { thread: { id: 'thread-default-policy' } } })
          yield* Fiber.join(opening)
          yield* connection.close(100)
        }),
      ),
    )
  })

  it('applies the access mode to the exact native thread when a session is resumed', async () => {
    const server = fakeServer()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(server)
          const loading = yield* Effect.forkScoped(
            connection.loadSession(
              { ...context, accessMode: 'auto-accept-edits' },
              { nativeSessionId: 'thread-policy-resume', generation: context.generation },
            ),
          )
          const resume = yield* server.read
          expect(resume.method).toBe('thread/resume')
          expect(resume.params).toMatchObject({
            threadId: 'thread-policy-resume',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
          })
          yield* server.send({
            id: resume.id,
            result: { cwd: context.workspacePath, thread: { id: 'thread-policy-resume', turns: [] } },
          })
          const goalRead = yield* server.read
          expect(goalRead.method).toBe('thread/goal/get')
          yield* server.send({ id: goalRead.id, result: { goal: null } })
          yield* Fiber.join(loading)
          yield* connection.close(100)
        }),
      ),
    )
  })

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
            params: {
              threadId: 'thread-native-1',
              turnId: accepted.nativeTurnId,
              itemId: 'item-command-1',
              cwd: 'C:\\workspace',
              command: 'git status',
            },
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
              toolCallId: 'item-command-1',
              tool: { category: 'command', command: 'git status', cwd: 'C:\\workspace' },
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
              optionId: 'allow-project',
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
            id: 'native-session-approval-1',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-native-1',
              turnId: accepted.nativeTurnId,
              itemId: 'item-session-approval-1',
              command: 'git status --short',
            },
          })
          const sessionApprovalEvent = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })
          if (sessionApprovalEvent.done) throw new Error('Expected a pending session approval')
          const sessionApproval =
            sessionApprovalEvent.value.kind === 'requestPending' ? sessionApprovalEvent.value.request : undefined
          expect(sessionApproval?.options?.map(option => option.id)).toEqual([
            'allow-once',
            'allow-session',
            'decline',
            'cancel',
          ])
          if (!sessionApproval) throw new Error('Expected a pending session approval')
          yield* session.respond(runId, sessionApproval.requestId, context.generation, {
            kind: 'approve',
            optionId: 'allow-session',
          })
          expect(yield* server.read).toEqual({
            id: 'native-session-approval-1',
            result: { decision: 'acceptForSession' },
          })
          yield* Effect.tryPromise({ try: () => iterator.next(), catch: () => new Error('event stream failed') })

          const permissions = {
            fileSystem: {
              read: ['C:\\workspace\\src'],
              write: ['C:\\workspace\\output'],
              entries: [{ type: 'glob_pattern', pattern: 'C:\\workspace\\**', access: 'write' }],
            },
            network: { enabled: true },
          }
          yield* server.send({
            id: 'native-permissions-1',
            method: 'item/permissions/requestApproval',
            params: {
              threadId: 'thread-native-1',
              turnId: accepted.nativeTurnId,
              itemId: 'item-permissions-1',
              cwd: 'C:\\workspace',
              reason: 'The task needs to write generated files.',
              permissions,
            },
          })
          const permissionEvent = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })
          const permissionRequest =
            permissionEvent.value?.kind === 'requestPending' ? permissionEvent.value.request : undefined
          expect(permissionRequest).toMatchObject({
            kind: 'approval',
            prompt: 'The task needs to write generated files.',
            toolCallId: 'item-permissions-1',
            tool: {
              category: 'fileWrite',
              cwd: 'C:\\workspace',
              paths: ['C:\\workspace\\src', 'C:\\workspace\\output', 'C:\\workspace\\**'],
            },
          })
          if (!permissionRequest) throw new Error('Expected a pending permissions request')
          yield* session.respond(runId, permissionRequest.requestId, context.generation, {
            kind: 'approve',
            optionId: 'allow-session',
          })
          expect(yield* server.read).toEqual({
            id: 'native-permissions-1',
            result: { permissions, scope: 'session' },
          })
          yield* Effect.tryPromise({ try: () => iterator.next(), catch: () => new Error('event stream failed') })

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
            id: 'native-question-custom',
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thread-native-1',
              turnId: accepted.nativeTurnId,
              questions: [
                {
                  id: 'checks',
                  header: 'Checks',
                  question: 'What should run?',
                  isOther: true,
                  isSecret: true,
                  multiSelect: true,
                  options: [{ label: 'Lint', description: 'Check source style' }],
                },
              ],
            },
          })
          const customEvent = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('event stream failed'),
          })
          const custom = customEvent.value?.kind === 'requestPending' ? customEvent.value.request : undefined
          expect(custom?.questions[0]).toMatchObject({
            header: 'Checks',
            allowCustomAnswer: true,
            isSecret: true,
            multiSelect: true,
            options: [{ label: 'Lint', description: 'Check source style' }],
          })
          if (!custom) throw new Error('Expected custom question')
          yield* session.respond(runId, custom.requestId, context.generation, {
            kind: 'answers',
            answers: { checks: ['Lint', 'Build Windows'] },
          })
          expect(yield* server.read).toEqual({
            id: 'native-question-custom',
            result: { answers: { checks: { answers: ['Lint', 'Build Windows'] } } },
          })
          yield* Effect.tryPromise({ try: () => iterator.next(), catch: () => new Error('event stream failed') })

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
          const goalRead = yield* server.read
          expect(goalRead.method).toBe('thread/goal/get')
          yield* server.send({ id: goalRead.id, result: { goal: null } })
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
