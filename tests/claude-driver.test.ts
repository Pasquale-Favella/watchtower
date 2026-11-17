import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { Effect, Fiber, Schema, Stream } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { AgentDriver } from '@/core/ports/agent-driver.js'
import { type ClaudeAgentSdk, makeClaudeAgentDriver } from '@/infrastructure/agent-harnesses/drivers/claude/driver.js'
import { resolveInstalledClaudeExecutable } from '@/infrastructure/agent-harnesses/drivers/claude/executable.js'
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

function assistantMessage(sessionId: string, content: SDKAssistantMessage['message']['content']): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000091',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: 'message-rich',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content,
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: resultMessage(sessionId, '00000000-0000-4000-8000-000000000092').usage,
    },
  }
}

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
  it.each([false, true])(
    'marks oversized tool content as truncated without ending the native session, streamed input %s',
    async streaming => {
      const fake = fakeSdk()
      const layer = makeClaudeAgentDriver({ sdk: fake.sdk, apiKey: () => 'test-key' })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const driver = yield* AgentDriver
            const connection = yield* driver.connect({ connectionId: 'connection' })
            const session = yield* connection.openSession(context)
            const call = fakeCall(fake)
            const submitting = yield* Effect.forkScoped(session.submit(turn))
            const sent = yield* Effect.promise(() => promptIterator(call).next())
            const sessionId = session.identity.nativeSessionId
            call.push({
              type: 'stream_event',
              uuid: '00000000-0000-4000-8000-000000000096',
              session_id: sessionId,
              parent_tool_use_id: null,
              user_message_uuid: inputUuid(sent.value),
              event: {
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'tool_use',
                  id: 'large',
                  name: 'Write',
                  input: streaming ? {} : { file_path: 'large.txt', content: 'x'.repeat(200000) },
                },
              },
            })
            yield* Fiber.join(submitting)
            const collection = yield* Effect.forkScoped(session.events(runId).pipe(Stream.runCollect))
            if (streaming) {
              call.push({
                type: 'stream_event',
                uuid: '00000000-0000-4000-8000-000000000098',
                session_id: sessionId,
                parent_tool_use_id: null,
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'input_json_delta', partial_json: 'x'.repeat(128 * 1024 - 32) },
                },
              })
              call.push({
                type: 'stream_event',
                uuid: '00000000-0000-4000-8000-000000000099',
                session_id: sessionId,
                parent_tool_use_id: null,
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'input_json_delta', partial_json: 'x' },
                },
              })
            }
            call.push({
              type: 'user',
              session_id: sessionId,
              parent_tool_use_id: null,
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'large', content: 'y'.repeat(200000) }],
              },
            })
            call.push(resultMessage(sessionId, '00000000-0000-4000-8000-000000000097'))
            const events = yield* Fiber.join(collection)
            const updates = events.filter(
              (event): event is Extract<AgentDriverEvent, { kind: 'toolUpdated' }> => event.kind === 'toolUpdated',
            )
            for (const field of ['input', 'output'] as const) {
              const content = updates.map(event => event[field] ?? '').join('')
              expect(content).toContain('… [truncated]')
              expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(128 * 1024)
            }
            expect(events.at(-1)?.kind).toBe('turnCompleted')
            expect(call.closed).toBe(false)
          }).pipe(Effect.provide(layer)),
        ),
      )
    },
  )

  it('preserves native streamed input, stable text blocks, long output, plans and explicit file patches', async () => {
    const fake = fakeSdk()
    const layer = makeClaudeAgentDriver({ sdk: fake.sdk, apiKey: () => 'test-key' })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const connection = yield* driver.connect({ connectionId: 'connection' })
          const session = yield* connection.openSession(context)
          const call = fakeCall(fake)
          const submitting = yield* Effect.forkScoped(session.submit(turn))
          const sent = yield* Effect.promise(() => promptIterator(call).next())
          const sessionId = session.identity.nativeSessionId
          let sequence = 100
          function stream(event: Extract<SDKMessage, { type: 'stream_event' }>['event'], echo?: string): void {
            call.push({
              type: 'stream_event',
              uuid: `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
              session_id: sessionId,
              parent_tool_use_id: null,
              ...(echo ? { user_message_uuid: echo } : {}),
              event,
            })
          }
          stream({ type: 'message_start', message: assistantMessage(sessionId, []).message }, inputUuid(sent.value))
          yield* Fiber.join(submitting)
          const collection = yield* Effect.forkScoped(session.events(runId).pipe(Stream.runCollect))
          stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } })
          stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } })
          stream({
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'shell', name: 'Bash', input: {} },
          })
          stream({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"command":"npm ' },
          })
          stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'test"}' } })
          call.push(
            assistantMessage(sessionId, [
              {
                type: 'tool_use',
                id: 'shell',
                name: 'Bash',
                input: { command: 'npm test', description: 'Run checks' },
              },
            ]),
          )
          call.push({
            type: 'tool_progress',
            uuid: '00000000-0000-4000-8000-000000000093',
            session_id: sessionId,
            parent_tool_use_id: null,
            tool_use_id: 'shell',
            tool_name: 'Bash',
            elapsed_time_seconds: 2,
          })
          const output = `first\n${'🌍'.repeat(10000)}\nlast`
          call.push({
            type: 'user',
            session_id: sessionId,
            parent_tool_use_id: null,
            tool_use_result: { stdout: output, stderr: 'failed', exit_code: 1 },
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'shell', content: 'Compact model output', is_error: true }],
            },
          })
          call.push({
            type: 'tool_use_summary',
            uuid: '00000000-0000-4000-8000-000000000094',
            session_id: sessionId,
            preceding_tool_use_ids: ['shell'],
            summary: 'Tests failed',
          })
          call.push(
            assistantMessage(sessionId, [
              {
                type: 'tool_use',
                id: 'plan',
                name: 'TodoWrite',
                input: {
                  todos: [
                    { content: 'Inspect', status: 'completed' },
                    { content: 'Fix', status: 'in_progress' },
                  ],
                },
              },
            ]),
          )
          call.push(
            assistantMessage(sessionId, [
              {
                type: 'tool_use',
                id: 'edit',
                name: 'Edit',
                input: { file_path: 'src/app.ts', old_string: 'old', new_string: 'new' },
              },
            ]),
          )
          call.push({
            type: 'user',
            session_id: sessionId,
            parent_tool_use_id: null,
            tool_use_result: {
              filePath: 'src/app.ts',
              structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
            },
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'Updated file' }] },
          })
          call.push(resultMessage(sessionId, '00000000-0000-4000-8000-000000000095'))
          const events = yield* Fiber.join(collection)
          expect(events.filter(event => event.kind === 'textDelta')).toEqual([
            { kind: 'textDelta', itemId: 'message-rich:0', text: 'Hello ' },
            { kind: 'textDelta', itemId: 'message-rich:0', text: 'world' },
          ])
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'toolUpdated',
              toolCallId: 'shell',
              input: '{"command":"npm ',
              append: true,
            }),
          )
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'toolUpdated',
              toolCallId: 'shell',
              input: JSON.stringify({ command: 'npm test', description: 'Run checks' }),
              append: false,
            }),
          )
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'toolUpdated',
              toolCallId: 'shell',
              category: 'command',
              command: 'npm test',
              description: 'Run checks',
            }),
          )
          expect(events).toContainEqual({ kind: 'toolUpdated', toolCallId: 'shell', durationMs: 2000 })
          const chunks = events.filter(
            (event): event is Extract<AgentDriverEvent, { kind: 'toolUpdated' }> =>
              event.kind === 'toolUpdated' && event.toolCallId === 'shell' && event.output !== undefined,
          )
          expect(chunks.map(event => event.output).join('')).toBe(`${output}\nfailed`)
          expect(chunks[0]?.append).toBe(false)
          expect(chunks.slice(1).every(event => event.append)).toBe(true)
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'toolCompleted',
              toolCallId: 'shell',
              exitCode: 1,
              error: 'Tool execution failed.',
            }),
          )
          expect(events).toContainEqual({
            kind: 'planUpdated',
            entries: [
              { content: 'Inspect', status: 'completed' },
              { content: 'Fix', status: 'inProgress' },
            ],
          })
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: 'toolCompleted',
              toolCallId: 'edit',
              changes: [{ path: 'src/app.ts', kind: 'update', diff: '@@ -1,1 +1,1 @@\n-old\n+new' }],
            }),
          )
          expect(events.every(event => new TextEncoder().encode(JSON.stringify(event)).byteLength <= 16384)).toBe(true)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

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

  it('sends the chosen effort level and keeps the agent default when none is chosen', async () => {
    const fake = fakeSdk()
    const layer = makeClaudeAgentDriver({ sdk: fake.sdk, apiKey: () => 'test-key', makeId: () => 'native-session' })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const first = yield* driver.connect({ connectionId: 'connection' })
          yield* first.openSession({ ...context, modeId: 'xhigh' })
          expect(fakeCall(fake).options.effort).toBe('xhigh')
          const second = yield* driver.connect({ connectionId: 'connection' })
          yield* second.openSession({ ...context, modeId: 'default' })
          expect(fakeCall(fake, 1).options).not.toHaveProperty('effort')
          const third = yield* driver.connect({ connectionId: 'connection' })
          const rejected = yield* third.openSession({ ...context, modeId: 'plan' }).pipe(Effect.flip)
          expect(rejected).toMatchObject({ code: 'invalid-state' })
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  it('probes models and their effort levels without sending a turn, then closes the probe', async () => {
    let closed = false
    let prompted = false
    const sdk: ClaudeAgentSdk = {
      query: ({ prompt, options }) => {
        expect(options?.canUseTool).toBeTypeOf('function')
        if (typeof prompt !== 'string') {
          void (async () => {
            const iterator = prompt[Symbol.asyncIterator]()
            if (!(await iterator.next()).done) prompted = true
          })()
        }
        return Object.assign((async function* () {})(), {
          supportedModels: async () => [
            {
              value: 'default',
              displayName: 'Default (recommended)',
              description: '',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'high', 'xhigh'],
            },
            {
              value: 'opus',
              displayName: 'Opus 5.5',
              description: '',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'high', 'xhigh'],
            },
            { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false },
          ],
          close: () => {
            closed = true
          },
        }) as unknown as Query
      },
    }
    const layer = makeClaudeAgentDriver({ sdk, apiKey: () => 'test-key' })
    const catalog = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const connection = yield* driver.connect({ connectionId: 'connection' })
          expect((yield* connection.discover()).modes).toEqual([])
          if (!connection.probeCatalog) return yield* Effect.die(new Error('Claude must offer a catalog probe'))
          const catalog = yield* connection.probeCatalog()
          const unsupportedEffort = yield* connection
            .openSession({ ...context, modelId: 'haiku', modeId: 'high' })
            .pipe(Effect.flip)
          expect(unsupportedEffort).toMatchObject({ code: 'invalid-state' })
          return catalog
        }).pipe(Effect.provide(layer)),
      ),
    )
    // The CLI's `default` row points at its own default model, not a model; the picker's blank Default sends none.
    expect(catalog).toEqual({
      models: [
        {
          id: 'opus',
          label: 'Opus 5.5',
          modes: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' },
            { id: 'xhigh', label: 'Extra high' },
          ],
        },
        { id: 'haiku', label: 'Haiku', modes: [] },
      ],
      modes: [],
    })
    expect(closed).toBe(true)
    expect(prompted).toBe(false)
  })

  it('drives the installed Claude Code executable, resolving npm launcher shims on Windows', async () => {
    const shim = 'C:\\Program Files\\nodejs\\claude.cmd'
    const npmShim = '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
    expect(
      resolveInstalledClaudeExecutable(
        'win32',
        () => shim,
        path => path.toLowerCase().endsWith('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'.toLowerCase()),
        () => npmShim,
      ),
    ).toBe('C:\\Program Files\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
    const pnpmShim = 'C:\\Users\\dev\\AppData\\Local\\pnpm\\claude.cmd'
    const pnpmEntry =
      'C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
    expect(
      resolveInstalledClaudeExecutable(
        'win32',
        () => pnpmShim,
        path => path === pnpmEntry,
        () => '"%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
      ),
    ).toBe(pnpmEntry)
    // A shim that cannot be read leaves the SDK on its bundled CLI instead of a spawn that always fails.
    expect(
      resolveInstalledClaudeExecutable(
        'win32',
        () => shim,
        () => false,
        () => undefined,
      ),
    ).toBeUndefined()
    expect(
      resolveInstalledClaudeExecutable(
        'linux',
        () => '/usr/local/bin/claude',
        () => false,
      ),
    ).toBe('/usr/local/bin/claude')
    expect(
      resolveInstalledClaudeExecutable(
        'linux',
        () => null,
        () => false,
      ),
    ).toBeUndefined()

    const fake = fakeSdk()
    const layer = makeClaudeAgentDriver({
      sdk: fake.sdk,
      apiKey: () => 'test-key',
      executablePath: () => '/usr/local/bin/claude',
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const connection = yield* driver.connect({ connectionId: 'connection' })
          yield* connection.openSession(context)
          yield* connection.close(1000)
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(fakeCall(fake).options.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
  })

  it.each([
    { accessMode: 'approval-required' as const, permissionMode: 'default', askMatcher: undefined },
    { accessMode: 'auto-accept-edits' as const, permissionMode: 'acceptEdits', askMatcher: 'AskUserQuestion' },
    { accessMode: 'full-access' as const, permissionMode: 'bypassPermissions', askMatcher: 'AskUserQuestion' },
  ])(
    'sends $accessMode as the native $permissionMode permission policy',
    async ({ accessMode, permissionMode, askMatcher }) => {
      const fake = fakeSdk()
      const layer = makeClaudeAgentDriver({ sdk: fake.sdk, apiKey: () => 'test-key', makeId: () => 'native-session' })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const driver = yield* AgentDriver
            const connection = yield* driver.connect({ connectionId: 'connection' })
            yield* connection.openSession({ ...context, accessMode })

            const options = fakeCall(fake).options
            expect(options.permissionMode).toBe(permissionMode)
            expect(options.allowDangerouslySkipPermissions).toBe(accessMode === 'full-access' ? true : undefined)
            expect(options.hooks?.PreToolUse?.map(hook => hook.matcher)).toEqual([askMatcher])
            const askHook = options.hooks?.PreToolUse?.[0]?.hooks[0]
            const decision = yield* Effect.promise(async () => askHook?.({} as never, undefined, {} as never))
            expect(decision).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })
            expect(options.canUseTool).toBeTypeOf('function')
          }).pipe(Effect.provide(layer)),
        ),
      )
    },
  )

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
          expect(fake.calls[0]?.options.mcpServers).toBeUndefined()
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

          const submitted = yield* Effect.forkDetach(
            session.submit({
              ...turn,
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
                  name: 'document.pdf',
                  size: 3,
                  source: 'file',
                  mediaType: 'application/pdf',
                  content: 'ZGVm',
                },
                {
                  id: 'c'.repeat(64),
                  name: 'notes.txt',
                  size: 5,
                  source: 'reference',
                  mediaType: 'text/plain',
                  content: 'Notes',
                },
              ],
            }),
          )
          const input = yield* Effect.promise(() => promptIterator(fake.calls[0]!).next())
          expect(input.done).toBe(false)
          expect(input.value.message.content).toEqual([
            { type: 'text', text: turn.messages[0].content },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'ZGVm' } },
            { type: 'text', text: expect.stringContaining('Notes') },
          ])
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

  it('injects the task browser HTTP MCP on fresh and resumed Claude sessions', async () => {
    const browserContext = {
      ...context,
      browserMcp: { url: 'http://127.0.0.1:43123/mcp', token: 'run-token' },
    }
    const fresh = fakeSdk()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver.pipe(Effect.provide(makeClaudeAgentDriver({ sdk: fresh.sdk })))
          const connection = yield* driver.connect({ connectionId: 'claude-browser-fresh' })
          yield* connection.openSession(browserContext)
          yield* connection.close(1000)
        }),
      ),
    )
    expect(fakeCall(fresh).options.mcpServers).toMatchObject({
      'watchtower-browser': {
        type: 'http',
        url: 'http://127.0.0.1:43123/mcp',
        headers: { Authorization: 'Bearer run-token' },
      },
    })

    const resumed = fakeSdk()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver.pipe(Effect.provide(makeClaudeAgentDriver({ sdk: resumed.sdk })))
          const connection = yield* driver.connect({ connectionId: 'claude-browser-resume' })
          yield* connection.loadSession(browserContext, { nativeSessionId: 'native-existing', generation: 2 })
          yield* connection.close(1000)
        }),
      ),
    )
    expect(fakeCall(resumed).options.mcpServers).toEqual(fakeCall(fresh).options.mcpServers)
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
            toolCallId: 'native-tool-approval',
            tool: { category: 'command', command: 'git status' },
            options: [{ id: 'allow-once' }, { id: 'deny-once' }, { id: 'cancel' }],
          })
          const approvalRequestId = approvalEvent.request.requestId
          expect(approvalRequestId).toBeDefined()
          yield* session.respond(runId, requiredRequestId(approvalRequestId), 2, {
            kind: 'approve',
            optionId: 'allow-once',
          })
          const approvalResult = yield* Effect.promise(() => approval)
          expect(approvalResult).toMatchObject({ behavior: 'allow', updatedInput: { command: 'git status' } })

          const sessionApproval = canUseTool(
            'Bash',
            { command: 'git status --short' },
            {
              signal,
              toolUseID: 'native-tool-session-approval',
              requestId: 'native-request-session-approval',
              suggestions: [
                {
                  type: 'addRules',
                  rules: [{ toolName: 'Bash', ruleContent: 'git status --short' }],
                  behavior: 'allow',
                  destination: 'projectSettings',
                },
              ],
              defaultToNo: true,
              suppressAlwaysAllowRule: false,
            },
          )
          const sessionApprovalEvent = yield* Effect.promise(nextPending)
          expect(sessionApprovalEvent.request?.options?.map(option => option.id)).toEqual([
            'allow-once',
            'allow-session',
            'deny-once',
            'cancel',
          ])
          const sessionApprovalRequestId = sessionApprovalEvent.request?.requestId
          yield* session.respond(runId, requiredRequestId(sessionApprovalRequestId), 2, {
            kind: 'approve',
            optionId: 'allow-session',
          })
          const sessionApprovalResult = yield* Effect.promise(() => sessionApproval)
          expect(sessionApprovalResult).toMatchObject({
            behavior: 'allow',
            decisionClassification: 'user_permanent',
            updatedPermissions: [
              {
                type: 'addRules',
                rules: [{ toolName: 'Bash', ruleContent: 'git status --short' }],
                behavior: 'allow',
                destination: 'session',
              },
            ],
          })

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
            toolCallId: 'native-question-tool',
            tool: { category: 'other' },
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
          expect(events.filter(event => event.kind === 'requestResolved')).toHaveLength(4)
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

  it('signs in with the Claude Code login when no API key is set, and refuses another route when a key is given', async () => {
    const login = fakeSdk(sessionId => ({ ...initMessage(sessionId), apiKeySource: 'none' as const }))
    const signedIn = makeClaudeAgentDriver({ sdk: login.sdk, apiKey: () => undefined })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const connection = yield* driver.connect({ connectionId: 'connection' })
          yield* connection.openSession(context)
        }).pipe(Effect.provide(signedIn)),
      ),
    )
    expect(fakeCall(login).options.env).not.toHaveProperty('ANTHROPIC_API_KEY')

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

it('uses the workspace Claude initialization result for provider slash commands', async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'watchtower-claude-catalog-'))
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR
  const previousPluginDirectory = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  process.env.CLAUDE_CONFIG_DIR = configDirectory
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(configDirectory, 'plugins')
  await mkdir(join(configDirectory, 'skills', 'review'), { recursive: true })
  await writeFile(
    join(configDirectory, 'skills', 'review', 'SKILL.md'),
    '---\nname: alias\ndescription: Review changes\n---\nReview the current changes.',
  )
  await mkdir(join(configDirectory, 'skills', 'internal'), { recursive: true })
  await writeFile(
    join(configDirectory, 'skills', 'internal', 'SKILL.md'),
    '---\nuser-invocable: false\n---\nInternal-only skill.',
  )
  const pluginId = 'quality-tools@1.0.0'
  const pluginInstall = join(configDirectory, 'plugins', 'cache', 'quality-tools')
  await mkdir(join(pluginInstall, 'custom-skills', 'deploy'), { recursive: true })
  await mkdir(join(pluginInstall, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(pluginInstall, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'quality-tools', skills: 'custom-skills' }),
  )
  await writeFile(
    join(pluginInstall, 'custom-skills', 'deploy', 'SKILL.md'),
    '---\ndescription: Deploy safely\n---\nDeploy the current changes.',
  )
  await writeFile(
    join(configDirectory, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { [pluginId]: [{ scope: 'user', installPath: pluginInstall }] } }),
  )
  await writeFile(
    join(configDirectory, 'settings.json'),
    `{
      // Claude accepts comments and trailing commas in settings files.
      "enabledPlugins": { "${pluginId}": true, },
    }`,
  )
  const commands = [{ name: 'deploy', description: 'Native deploy command', argumentHint: 'target' }]
  const sdk: ClaudeAgentSdk = {
    query: ({ options }) => {
      expect(options?.cwd).toBe(context.workspacePath)
      expect(options?.settingSources).toEqual(['user', 'project', 'local'])
      return Object.assign((async function* () {})(), {
        initializationResult: async () =>
          ({ commands }) as unknown as Awaited<ReturnType<Query['initializationResult']>>,
        close: () => undefined,
      }) as unknown as Query
    },
  }

  try {
    const layer = makeClaudeAgentDriver({ sdk, apiKey: () => 'test-key' })
    const catalog = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* AgentDriver
          const connection = yield* driver.connect({ connectionId: 'connection' })
          if (!connection.discoverPromptCatalog)
            return yield* Effect.die(new Error('Claude must expose prompt catalog discovery'))
          return yield* connection.discoverPromptCatalog(context.workspacePath)
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(catalog.skills).toEqual([
      { name: 'review', enabled: true, description: 'Review changes' },
      { name: 'quality-tools:deploy', enabled: true, description: 'Deploy safely' },
    ])
    expect(catalog.commands).toContainEqual({
      name: 'deploy',
      description: 'Native deploy command',
      inputHint: 'target',
    })
    expect(catalog.commands.some(command => command.name === 'compact')).toBe(true)
  } finally {
    if (previousConfigDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory
    if (previousPluginDirectory === undefined) delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    else process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = previousPluginDirectory
    await rm(configDirectory, { recursive: true, force: true })
  }
})
