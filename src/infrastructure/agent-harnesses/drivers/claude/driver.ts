import { randomUUID } from 'node:crypto'

import {
  type CanUseTool,
  type Options,
  type Query,
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import {
  AgentDriver,
  type AgentDriverConnection,
  type AgentDriverConnectOptions,
  AgentDriverError,
  type AgentDriverSession,
  type AgentSessionContext,
  type AgentTurnInput,
  type NativeSessionReference,
  UnsupportedAgentOperation,
} from '@/core/ports/agent-driver.js'
import { executablePathEnv } from '@/infrastructure/process/executable.js'
import type {
  AgentCapabilities,
  AgentDriverEvent,
  AgentRequest,
  AgentRequestDecision,
} from '@/shared/schemas/execution.js'
import type { AgentRunId } from '@/shared/schemas/workspace.js'

const DRIVER_ID = 'claude-agent-sdk'
const EVENT_CAPACITY = 1024
const MAX_TOOL_TEXT_BYTES = 8192
const MAX_EVENT_TEXT_BYTES = 16_384
const MAX_QUEUED_EVENT_BYTES = 512 * 1024
const MAX_TRACKED_RUNS = 32
const RECENT_RUN_ID_LIMIT = 128
const CONTROL_TIMEOUT_MS = 30_000
const EXECUTION_ENVIRONMENT_KEYS = [
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
] as const

/** The small official SDK surface used by the driver, replaceable in protocol tests. */
export interface ClaudeAgentSdk {
  readonly query: (params: {
    readonly prompt: string | AsyncIterable<SDKUserMessage>
    readonly options?: Options
  }) => Query
}

export interface ClaudeDriverDependencies {
  readonly sdk?: ClaudeAgentSdk | undefined
  readonly apiKey?: (() => string | undefined) | undefined
  readonly makeId?: (() => string) | undefined
}

const defaultSdk: ClaudeAgentSdk = { query: sdkQuery }

const supported = (detail: string) => ({
  support: 'supported' as const,
  restrictions: [] as string[],
  evidence: [{ source: 'driver' as const, detail }],
})
const unsupported = (detail: string) => ({
  support: 'unsupported' as const,
  restrictions: [detail],
  evidence: [{ source: 'driver' as const, detail }],
})

const capabilities: AgentCapabilities = {
  openSession: supported('Creates a Claude Agent SDK streaming-input session.'),
  loadSession: supported(
    'Resumes the exact native session ID using the SDK resume option; there is no fresh-session fallback.',
  ),
  submit: supported(
    'Streams user messages into the native session and awaits the SDK echo before reporting acceptance.',
  ),
  interrupt: supported('Uses the SDK streaming query interrupt control request.'),
  steer: unsupported('The SDK has no in-turn steering API; submit is queued for a subsequent turn.'),
  respond: supported('Resolves the exact pending canUseTool callback while it is held by the SDK.'),
  reconcile: unsupported('The SDK query API does not expose a durable event replay cursor.'),
  models: [],
  modes: [{ id: 'default', label: 'Default permissions (every tool requires approval)' }],
}

interface RunQueue {
  readonly queue: Queue.Queue<AgentDriverEvent, AgentDriverError | Cause.Done>
  bufferedBytes: number
  streamClaimed: boolean
  terminal: boolean
  started: boolean
  submitted: boolean
  acceptance?: ReturnType<typeof deferred<NativeAcceptance>>
}

interface NativeAcceptance {
  readonly nativeSessionId: string
  readonly generation: number
}

interface PendingRequest {
  readonly runId: AgentRunId
  readonly generation: number
  readonly decision: ReturnType<typeof deferred<AgentRequestDecision>>
  readonly toolInput: Record<string, unknown>
}

const askUserQuestionSchema = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      header: Schema.optional(Schema.String),
      options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.optional(Schema.String) })).pipe(
        Schema.check(Schema.isMinLength(2), Schema.isMaxLength(4)),
      ),
      multiSelect: Schema.Boolean,
    }),
  ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4))),
})

type ParsedAskUserQuestion = Schema.Schema.Type<typeof askUserQuestionSchema>

const deferred = <A>() => {
  let settled = false
  let resolve!: (value: A) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<A>((res, rej) => {
    resolve = value => {
      if (settled) return
      settled = true
      res(value)
    }
    reject = cause => {
      if (settled) return
      settled = true
      rej(cause)
    }
  })
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled
    },
  }
}

const sanitizedMessage = (error: unknown): string => {
  if (error instanceof Error)
    return error.name === 'Error' ? 'Claude Agent SDK operation failed.' : `Claude Agent SDK ${error.name}.`
  return 'Claude Agent SDK operation failed.'
}

const makeError = (code: ConstructorParameters<typeof AgentDriverError>[0]['code'], message: string) =>
  new AgentDriverError({ code, message })

const boundedText = (text: string, byteLimit = MAX_TOOL_TEXT_BYTES): string => {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= byteLimit) return text
  let end = Math.min(text.length, byteLimit)
  while (encoder.encode(text.slice(0, end)).byteLength > byteLimit - 32) end -= Math.max(1, Math.floor(end / 8))
  return `${text.slice(0, end)}… [truncated]`
}

const encodeToolInput = (input: unknown): string | undefined => {
  try {
    const encoded = JSON.stringify(input)
    return encoded === undefined ? undefined : boundedText(encoded)
  } catch {
    return undefined
  }
}

const questionRequest = (
  input: ParsedAskUserQuestion,
  requestId: string,
  runId: AgentRunId,
  sessionId: AgentSessionContext['sessionId'],
  generation: number,
  nativeRequestId: string,
): AgentRequest => {
  const questions = input.questions.map((question, questionIndex) => ({
    id: `q${questionIndex}`,
    prompt: question.question,
    multiSelect: question.multiSelect,
    options: question.options.map((option, optionIndex) => ({
      id: `q${questionIndex}-o${optionIndex}`,
      label: option.label,
    })),
  }))
  return {
    requestId,
    runId,
    sessionId,
    generation,
    kind: 'question',
    prompt: questions.map(({ prompt }) => prompt).join('\n'),
    questions,
    nativeRequestId,
  }
}

const makeAskRequest = (
  toolName: string,
  prompt: string,
  requestId: string,
  runId: AgentRunId,
  sessionId: AgentSessionContext['sessionId'],
  generation: number,
  nativeRequestId: string,
): AgentRequest => ({
  requestId,
  runId,
  sessionId,
  generation,
  kind: 'approval',
  prompt,
  options: [
    { id: 'allow-once', label: 'Allow once', scope: 'once', kind: 'allow' },
    { id: 'deny-once', label: 'Deny', scope: 'once', kind: 'deny' },
  ],
  questions: [],
  nativeRequestId,
})

const sdkMessageSessionId = (message: SDKMessage): string | undefined =>
  'session_id' in message && typeof message.session_id === 'string' ? message.session_id : undefined

const isOurApiKeyAuth = (message: SDKMessage): boolean =>
  message.type === 'system' && message.subtype === 'init' && message.apiKeySource === 'ANTHROPIC_API_KEY'

const claudeProcessEnvironment = (apiKey: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: apiKey }
  const path = executablePathEnv()
  if (path) env.PATH = path
  for (const name of EXECUTION_ENVIRONMENT_KEYS) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

const modeOptions = (
  context: AgentSessionContext,
  native: NativeSessionReference | undefined,
  nativeSessionId: string,
  apiKey: string,
): Options => {
  return {
    cwd: context.workspacePath,
    ...(context.modelId !== undefined ? { model: context.modelId } : {}),
    permissionMode: 'default',
    settingSources: ['user', 'project', 'local'],
    tools: { type: 'preset', preset: 'claude_code' },
    includePartialMessages: true,
    ...(native ? { resume: native.nativeSessionId } : { sessionId: nativeSessionId }),
    env: claudeProcessEnvironment(apiKey),
    hooks: {
      PreToolUse: [
        {
          hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })],
        },
      ],
    },
  }
}

const makeSession = (
  scope: Scope.Scope,
  context: AgentSessionContext,
  native: NativeSessionReference | undefined,
  freshNativeSessionId: string | undefined,
  generation: number,
  sdk: ClaudeAgentSdk,
  id: () => string,
  apiKey: string,
): Effect.Effect<AgentDriverSession, AgentDriverError> =>
  Effect.gen(function* () {
    const nativeSessionId = native?.nativeSessionId ?? freshNativeSessionId ?? id()
    if (context.modeId !== undefined && context.modeId !== 'default') {
      return yield* makeError('invalid-state', 'The requested Claude permission mode is not supported by this driver.')
    }
    const runtimeContext = yield* Effect.context()
    const runPromise = Effect.runPromiseWith(runtimeContext)
    const inputQueue = yield* Queue.bounded<SDKUserMessage>(64)
    const runs = new Map<AgentRunId, RunQueue>()
    const recentRunIds = new Set<AgentRunId>()
    const recentRunOrder: AgentRunId[] = []
    const pending = new Map<string, PendingRequest>()
    const messagesByUuid = new Map<string, AgentRunId>()
    const activeTools = new Map<string, AgentRunId>()
    const closed = { value: false }
    const currentRunId = { value: undefined as AgentRunId | undefined }
    const pumpFailure = { value: undefined as AgentDriverError | undefined }
    const queryOptions = modeOptions(context, native, nativeSessionId, apiKey)

    const prompt: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<SDKUserMessage>> => {
            try {
              const message = await runPromise(Queue.take(inputQueue))
              if (typeof message.uuid === 'string') currentRunId.value = messagesByUuid.get(message.uuid)
              return { done: false, value: message }
            } catch {
              return { done: true, value: undefined }
            }
          },
        }
      },
    }

    const emit = (runId: AgentRunId | undefined, event: AgentDriverEvent): Effect.Effect<void, AgentDriverError> =>
      Effect.gen(function* () {
        if (!runId) return
        const run = runs.get(runId)
        if (!run || run.terminal) return
        const byteLength = new TextEncoder().encode(JSON.stringify(event)).byteLength
        if (byteLength > MAX_EVENT_TEXT_BYTES || run.bufferedBytes + byteLength > MAX_QUEUED_EVENT_BYTES) {
          return yield* makeError('disconnected', 'Claude event buffering limit was reached; the session was stopped.')
        }
        if (!Queue.offerUnsafe(run.queue, event)) {
          return yield* makeError('disconnected', 'Claude event count limit was reached; the session was stopped.')
        }
        run.bufferedBytes += byteLength
      })

    const startRun = (runId: AgentRunId): Effect.Effect<RunQueue, AgentDriverError> =>
      Effect.gen(function* () {
        const existing = runs.get(runId)
        if (existing) return existing
        if (runs.size >= MAX_TRACKED_RUNS) {
          return yield* makeError('invalid-state', 'Too many undrained Claude event streams are open.')
        }
        const queue = yield* Queue.bounded<AgentDriverEvent, AgentDriverError | Cause.Done>(EVENT_CAPACITY)
        const run: RunQueue = {
          queue,
          bufferedBytes: 0,
          streamClaimed: false,
          terminal: false,
          started: false,
          submitted: false,
        }
        runs.set(runId, run)
        return run
      })

    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const runId = currentRunId.value
      if (!runId || closed.value || options.signal.aborted) {
        return {
          behavior: 'deny',
          message: 'This run is no longer active. Do not retry this tool unless the user asks.',
        }
      }
      const requestId = id()
      const wait = deferred<AgentRequestDecision>()
      const request: PendingRequest = { runId, generation, decision: wait, toolInput }
      pending.set(requestId, request)
      let parsedQuestions: ParsedAskUserQuestion | undefined
      if (toolName === 'AskUserQuestion') {
        try {
          parsedQuestions = Schema.decodeUnknownSync(askUserQuestionSchema)(toolInput)
        } catch {
          pending.delete(requestId)
          return { behavior: 'deny', message: 'The question request was malformed and was not shown to the user.' }
        }
      }
      const title = boundedText(
        options.title ??
          `${toolName} requires your approval.\n${encodeToolInput(toolInput) ?? '[Tool input could not be rendered]'}`,
      )
      const event = parsedQuestions
        ? questionRequest(parsedQuestions, requestId, runId, context.sessionId, generation, options.requestId)
        : makeAskRequest(toolName, title, requestId, runId, context.sessionId, generation, options.requestId)
      try {
        await runPromise(emit(runId, { kind: 'requestPending', request: event }))
        const decision = await Promise.race([
          wait.promise,
          new Promise<never>((_, reject) =>
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          ),
        ])
        await runPromise(emit(runId, { kind: 'requestResolved', requestId, decision }))
        if (decision.kind === 'approve') {
          if (decision.optionId !== undefined && decision.optionId !== 'allow-once') {
            return { behavior: 'deny', message: 'The selected approval option does not grant this action.' }
          }
          return { behavior: 'allow', updatedInput: toolInput }
        }
        if (decision.kind === 'answers' && toolName === 'AskUserQuestion') {
          if (!parsedQuestions) return { behavior: 'deny', message: 'No valid question request is pending.' }
          const nativeAnswers: Record<string, string | string[]> = {}
          let valid = true
          const answerIds = Object.keys(decision.answers)
          if (
            answerIds.length !== parsedQuestions.questions.length ||
            answerIds.some(key => !parsedQuestions.questions.some((_, index) => key === `q${index}`))
          ) {
            return { behavior: 'deny', message: 'The supplied answers do not match the pending questions.' }
          }
          for (const [questionIndex, question] of parsedQuestions.questions.entries()) {
            const answer = decision.answers[`q${questionIndex}`]
            if (answer === undefined) {
              valid = false
              continue
            }
            const selections = Array.isArray(answer) ? answer : [answer]
            if (question.multiSelect !== Array.isArray(answer) || selections.length === 0) valid = false
            const labels = selections.flatMap(selection => {
              const prefix = `q${questionIndex}-o`
              if (!selection.startsWith(prefix)) return []
              const option = question.options[Number(selection.slice(prefix.length))]
              return option ? [option.label] : []
            })
            if (labels.length !== selections.length) valid = false
            nativeAnswers[question.question] = Array.isArray(answer) ? labels : (labels[0] ?? '')
          }
          if (!valid || Object.keys(nativeAnswers).length === 0) {
            return { behavior: 'deny', message: 'The supplied answers do not cover the pending questions.' }
          }
          return { behavior: 'allow', updatedInput: { questions: toolInput.questions, answers: nativeAnswers } }
        }
        return {
          behavior: 'deny',
          message:
            decision.kind === 'deny'
              ? (decision.reason ?? 'The user denied this action.')
              : 'The user cancelled this request.',
          interrupt: decision.kind === 'cancel',
        }
      } catch {
        return {
          behavior: 'deny',
          message: 'The request could not be delivered to the user. Do not retry without explicit approval.',
          interrupt: true,
        }
      } finally {
        pending.delete(requestId)
      }
    }

    queryOptions.canUseTool = canUseTool

    const query = yield* Effect.try({
      try: () => sdk.query({ prompt, options: queryOptions }),
      catch: () => makeError('driver-unavailable', 'Claude Agent SDK could not start a session.'),
    })

    const processMessage = (message: SDKMessage): Effect.Effect<void, AgentDriverError> =>
      Effect.gen(function* () {
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.session_id !== nativeSessionId) {
            const error = makeError('protocol-error', 'Claude resumed an unexpected native session.')
            return yield* error
          }
          if (!isOurApiKeyAuth(message)) {
            const error = makeError(
              'authentication-required',
              'Claude Agent SDK did not authenticate with ANTHROPIC_API_KEY.',
            )
            return yield* error
          }
          return
        }

        const sessionIdFromMessage = sdkMessageSessionId(message)
        if (sessionIdFromMessage && sessionIdFromMessage !== nativeSessionId) {
          return yield* makeError('protocol-error', 'Claude Agent SDK emitted an event for a different native session.')
        }

        const echoedUuid =
          'user_message_uuid' in message && typeof message.user_message_uuid === 'string'
            ? message.user_message_uuid
            : undefined
        if (echoedUuid) {
          const acceptedRunId = messagesByUuid.get(echoedUuid)
          if (acceptedRunId) {
            const run = runs.get(acceptedRunId)
            run?.acceptance?.resolve({ nativeSessionId, generation })
            currentRunId.value = acceptedRunId
            messagesByUuid.delete(echoedUuid)
          }
        }

        if (message.type === 'stream_event') {
          if (message.parent_tool_use_id !== null) return
          const event = message.event
          const runId = (echoedUuid ? messagesByUuid.get(echoedUuid) : undefined) ?? currentRunId.value
          const run = runId ? runs.get(runId) : undefined
          if (run && !run.started) {
            run.started = true
            yield* emit(runId, { kind: 'turnStarted' })
          }
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use' && runId) {
            activeTools.set(event.content_block.id, runId)
            yield* emit(runId, {
              kind: 'toolStarted',
              toolCallId: event.content_block.id,
              name: event.content_block.name,
              input: encodeToolInput(event.content_block.input),
            })
          } else if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta' &&
            event.delta.text.length > 0
          ) {
            yield* emit(runId, { kind: 'textDelta', text: event.delta.text, itemId: message.uuid })
          } else if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'thinking_delta' &&
            event.delta.thinking.length > 0
          ) {
            yield* emit(runId, { kind: 'reasoningDelta', text: event.delta.thinking, itemId: message.uuid })
          }
          return
        }

        if (message.type === 'user') {
          const content = Array.isArray(message.message.content) ? message.message.content : []
          for (const block of content) {
            if (block.type === 'tool_result') {
              const runId = activeTools.get(block.tool_use_id) ?? currentRunId.value
              const output =
                typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
                    : undefined
              if (output !== undefined)
                yield* emit(runId, { kind: 'toolUpdated', toolCallId: block.tool_use_id, output })
              yield* emit(runId, {
                kind: 'toolCompleted',
                toolCallId: block.tool_use_id,
                error: block.is_error ? 'Tool execution failed.' : undefined,
              })
              activeTools.delete(block.tool_use_id)
            }
          }
          return
        }

        if (message.type === 'tool_progress') {
          if (message.parent_tool_use_id !== null) return
          const runId = activeTools.get(message.tool_use_id) ?? currentRunId.value
          yield* emit(runId, {
            kind: 'toolUpdated',
            toolCallId: message.tool_use_id,
            output: `Running for ${message.elapsed_time_seconds} seconds.`,
          })
          return
        }

        if (message.type === 'tool_use_summary') {
          for (const toolCallId of message.preceding_tool_use_ids) {
            yield* emit(activeTools.get(toolCallId) ?? currentRunId.value, {
              kind: 'toolUpdated',
              toolCallId,
              output: message.summary,
            })
          }
          return
        }

        if (message.type === 'assistant') {
          if (message.parent_tool_use_id !== null) return
          if (message.error === 'authentication_failed')
            return yield* makeError('authentication-required', 'Claude Agent SDK rejected ANTHROPIC_API_KEY.')
          const runId = currentRunId.value
          const run = runId ? runs.get(runId) : undefined
          if (run && !run.started) {
            run.started = true
            yield* emit(runId, { kind: 'turnStarted' })
          }
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && !activeTools.has(block.id)) {
              activeTools.set(block.id, runId as AgentRunId)
              yield* emit(runId, {
                kind: 'toolStarted',
                toolCallId: block.id,
                name: block.name,
                input: encodeToolInput(block.input),
              })
            }
          }
          return
        }

        if (message.type === 'result') {
          const runId = currentRunId.value
          if (!runId) return
          const usage = message.usage
          yield* emit(runId, {
            kind: 'usageReported',
            semantics: 'final',
            scope: 'run',
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
          })
          if (message.stop_reason === 'interrupt') {
            yield* emit(runId, { kind: 'turnInterrupted' })
          } else if (message.subtype === 'success' && !message.is_error) {
            yield* emit(runId, { kind: 'turnCompleted' })
          } else {
            yield* emit(runId, { kind: 'turnFailed', message: 'Claude Agent SDK turn failed.' })
          }
          const run = runs.get(runId)
          if (run?.acceptance && !run.acceptance.settled)
            run.acceptance.reject(new Error('Turn ended before the SDK confirmed prompt acceptance.'))
          if (run) {
            for (const [toolCallId, toolRunId] of activeTools) {
              if (toolRunId === runId) activeTools.delete(toolCallId)
            }
            for (const [uuid, uuidRunId] of messagesByUuid) {
              if (uuidRunId === runId) messagesByUuid.delete(uuid)
            }
            for (const [requestId, request] of pending) {
              if (request.runId === runId) {
                request.decision.reject(new Error('Claude turn ended before the pending tool request was resolved.'))
                pending.delete(requestId)
              }
            }
            run.terminal = true
            yield* Queue.end(run.queue)
          }
          if (currentRunId.value === runId) currentRunId.value = undefined
        }
      })

    const pump = Effect.gen(function* () {
      while (!closed.value) {
        const next = yield* Effect.tryPromise({
          try: () => query.next(),
          catch: () => makeError('disconnected', 'Claude Agent SDK stream disconnected.'),
        })
        if (next.done) {
          closed.value = true
          yield* Queue.shutdown(inputQueue)
          const failure = makeError('disconnected', 'Claude Agent SDK stream ended before a terminal result.')
          for (const request of pending.values()) request.decision.reject(failure)
          pending.clear()
          for (const run of runs.values()) {
            if (!run.terminal) {
              if (run.acceptance && !run.acceptance.settled) {
                run.acceptance.reject(
                  makeError('outcome-uncertain', 'Claude stream ended before delivery was confirmed.'),
                )
              }
              run.terminal = true
              yield* Queue.fail(run.queue, failure)
            }
          }
          messagesByUuid.clear()
          activeTools.clear()
          currentRunId.value = undefined
          query.close()
          return
        }
        yield* processMessage(next.value)
      }
    }).pipe(
      Effect.catch(error =>
        Effect.gen(function* () {
          const failure = error instanceof AgentDriverError ? error : makeError('disconnected', sanitizedMessage(error))
          pumpFailure.value = failure
          closed.value = true
          yield* Queue.shutdown(inputQueue)
          for (const request of pending.values()) request.decision.reject(failure)
          pending.clear()
          for (const run of runs.values()) {
            if (!run.terminal) {
              if (run.acceptance && !run.acceptance.settled) {
                run.acceptance.reject(
                  failure.code === 'authentication-required'
                    ? failure
                    : makeError('outcome-uncertain', 'Claude stream failed before delivery was confirmed.'),
                )
              }
              run.terminal = true
              yield* Queue.fail(run.queue, failure)
            }
          }
          messagesByUuid.clear()
          activeTools.clear()
          currentRunId.value = undefined
          query.close()
        }),
      ),
    )

    yield* Scope.provide(scope)(Effect.forkScoped(pump))
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        closed.value = true
        yield* Queue.shutdown(inputQueue)
        for (const request of pending.values()) request.decision.reject(new Error('Session closed'))
        pending.clear()
        for (const run of runs.values()) run.acceptance?.reject(new Error('Session closed'))
        messagesByUuid.clear()
        activeTools.clear()
        currentRunId.value = undefined
        for (const runId of runs.keys()) yield* queueFailure(runId)
        query.close()
      }),
    )

    const queueFailure = (runId: AgentRunId): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const run = runs.get(runId)
        if (run && !run.terminal) {
          run.terminal = true
          yield* Queue.shutdown(run.queue)
        }
      })

    const activeSession = {
      identity: { nativeSessionId, generation },
      capabilities,
      events: (runId: AgentRunId, afterCursor?: string) => {
        if (afterCursor !== undefined)
          return Stream.fail(makeError('protocol-error', 'Claude Agent SDK does not expose replay cursors.'))
        if (recentRunIds.has(runId) && !runs.has(runId)) {
          return Stream.fail(makeError('invalid-state', 'The event stream for this completed run was already drained.'))
        }
        return Stream.unwrap(
          startRun(runId).pipe(
            Effect.flatMap(run => {
              if (run.streamClaimed) {
                return Effect.fail(makeError('invalid-state', 'A Claude run event stream can only be consumed once.'))
              }
              run.streamClaimed = true
              return Effect.succeed(
                Stream.fromQueue(run.queue).pipe(
                  Stream.tap(event =>
                    Effect.sync(() => {
                      run.bufferedBytes = Math.max(
                        0,
                        run.bufferedBytes - new TextEncoder().encode(JSON.stringify(event)).byteLength,
                      )
                    }),
                  ),
                  Stream.ensuring(
                    Effect.gen(function* () {
                      if (run.terminal || !run.submitted) {
                        runs.delete(runId)
                        if (!run.terminal) yield* Queue.shutdown(run.queue)
                      }
                    }),
                  ),
                ),
              )
            }),
          ),
        )
      },
      submit: (input: AgentTurnInput) =>
        Effect.gen(function* () {
          if (closed.value) return yield* pumpFailure.value ?? makeError('disconnected', 'Claude session is closed.')
          const previousActive = [...runs.entries()].some(
            ([activeRunId, run]) => activeRunId !== input.runId && !run.terminal,
          )
          if (previousActive) return yield* makeError('invalid-state', 'Claude session already has an active run.')
          if (input.attachmentIds.length > 0)
            return yield* new UnsupportedAgentOperation({
              operation: 'submit',
              message: 'Claude SDK attachment transport is not implemented in this driver.',
            })
          if (input.messages.length === 0 || input.messages.some(message => message.role !== 'user')) {
            return yield* makeError('invalid-state', 'Claude SDK only accepts non-empty user-only turn content.')
          }
          const text = input.messages.map(message => message.content).join('\n')
          if (!text.trim()) return yield* makeError('invalid-state', 'Claude SDK requires a non-empty user message.')
          if (recentRunIds.has(input.runId))
            return yield* makeError('invalid-state', 'A recently completed run ID cannot be reused.')
          const run = runs.get(input.runId) ?? (yield* startRun(input.runId))
          if (run.submitted)
            return yield* makeError('invalid-state', 'A run ID can only be submitted once per native session.')
          const acceptance = deferred<NativeAcceptance>()
          run.acceptance = acceptance
          const uuid = randomUUID()
          messagesByUuid.set(uuid, input.runId)
          const nativeMessage: SDKUserMessage = {
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            uuid,
          }
          const offered = yield* Queue.offer(inputQueue, nativeMessage)
          if (!offered)
            return yield* pumpFailure.value ?? makeError('disconnected', 'Claude SDK input queue is closed.')
          run.submitted = true
          recentRunIds.add(input.runId)
          recentRunOrder.push(input.runId)
          if (recentRunOrder.length > RECENT_RUN_ID_LIMIT) {
            const expired = recentRunOrder.shift()
            if (expired !== undefined) recentRunIds.delete(expired)
          }
          const accepted = yield* Effect.tryPromise({
            try: () =>
              new Promise<NativeAcceptance>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('acceptance timeout')), CONTROL_TIMEOUT_MS)
                acceptance.promise.then(resolve, reject).finally(() => clearTimeout(timer))
              }),
            catch: error =>
              error instanceof AgentDriverError
                ? error
                : makeError('outcome-uncertain', 'Claude SDK did not confirm whether the prompt was accepted.'),
          })
          return { ...accepted }
        }),
      interrupt: (runId: AgentRunId, expectedNativeTurnId?: string) =>
        Effect.gen(function* () {
          if (expectedNativeTurnId !== undefined)
            return yield* makeError('invalid-state', 'Claude SDK does not expose a native turn ID for this run.')
          const run = runs.get(runId)
          if (!run || run.terminal) return { acknowledged: false, termination: 'unknown' as const }
          const receipt = yield* Effect.tryPromise({
            try: () => query.interrupt(),
            catch: () => makeError('disconnected', 'Claude SDK interrupt request failed.'),
          })
          return { acknowledged: receipt !== undefined, termination: 'unknown' as const }
        }),
      steer: () =>
        Effect.fail(
          new UnsupportedAgentOperation({
            operation: 'steer',
            message: 'Claude Agent SDK does not support steering an in-progress turn.',
          }),
        ),
      respond: (runId: AgentRunId, requestId: string, requestGeneration: number, decision: AgentRequestDecision) =>
        Effect.sync(() => {
          if (requestGeneration !== generation) return { outcome: 'failed' as const }
          const request = pending.get(requestId)
          if (!request || request.runId !== runId || request.generation !== generation)
            return { outcome: 'failed' as const }
          if (request.decision.settled) return { outcome: 'failed' as const }
          request.decision.resolve(decision)
          return { outcome: 'accepted' as const, nativeConfirmation: 'unconfirmed' as const }
        }),
      reconcile: () =>
        Stream.fail(
          new UnsupportedAgentOperation({
            operation: 'reconcile',
            message: 'Claude Agent SDK query does not expose native event replay.',
          }),
        ),
    } satisfies AgentDriverSession

    return activeSession
  })

export const makeClaudeAgentDriver = (dependencies: ClaudeDriverDependencies = {}) => {
  const sdk = dependencies.sdk ?? defaultSdk
  const apiKey = dependencies.apiKey ?? (() => process.env.ANTHROPIC_API_KEY)
  const id: () => string = dependencies.makeId ?? randomUUID

  return Layer.succeed(
    AgentDriver,
    AgentDriver.of({
      driverId: DRIVER_ID,
      connect: (options: AgentDriverConnectOptions) =>
        Effect.gen(function* () {
          const key = apiKey()
          if (!key) return yield* makeError('authentication-required', 'Set ANTHROPIC_API_KEY to use Claude Agent SDK.')
          const childScope = yield* Scope.make()
          let connectionClosed = false

          const connection: AgentDriverConnection = {
            identity: {
              id: options.connectionId,
              driverId: DRIVER_ID,
              protocolVersion: 'claude-agent-sdk/0.3.270',
              authentication: 'unknown',
            },
            discover: () => Effect.succeed(capabilities),
            openSession: context =>
              Effect.gen(function* () {
                if (connectionClosed) return yield* makeError('disconnected', 'Claude connection is closed.')
                if (context.generation < 1)
                  return yield* makeError('invalid-state', 'Session generation must be positive.')
                const nativeSessionId = id()
                return yield* makeSession(
                  childScope,
                  context,
                  undefined,
                  nativeSessionId,
                  context.generation,
                  sdk,
                  id,
                  key,
                )
              }),
            loadSession: (context, native) =>
              Effect.gen(function* () {
                if (connectionClosed) return yield* makeError('disconnected', 'Claude connection is closed.')
                if (!native.nativeSessionId || native.generation !== context.generation) {
                  return yield* makeError(
                    'invalid-state',
                    'Claude resume requires the exact native session ID and matching generation.',
                  )
                }
                return yield* makeSession(childScope, context, native, undefined, native.generation, sdk, id, key)
              }),
            close: deadlineMs =>
              Effect.gen(function* () {
                connectionClosed = true
                const close = Scope.close(childScope, Exit.succeed(undefined))
                const completed = yield* Effect.timeoutOption(close, `${Math.max(0, deadlineMs)} millis`)
                if (completed._tag === 'None')
                  return yield* makeError('timeout', 'Claude sessions did not close before the connection deadline.')
              }),
          }

          yield* Effect.addFinalizer(() => connection.close(5000).pipe(Effect.ignore))
          return connection
        }),
    }),
  )
}

export const ClaudeAgentDriverLive = makeClaudeAgentDriver()
