import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import {
  type CanUseTool,
  type Options,
  type PermissionUpdate,
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
  type AgentCatalogProbe,
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
import { attachmentText } from '@/infrastructure/agent-harnesses/drivers/prompt-content.js'
import {
  discoverClaudePromptCatalog,
  normalizeAgentPromptCatalog,
} from '@/infrastructure/agent-harnesses/prompt-catalog.js'
import { executablePathEnv } from '@/infrastructure/process/executable.js'
import type {
  AgentAccessMode,
  AgentCapabilities,
  AgentDriverEvent,
  AgentPromptCatalog,
  AgentRequest,
  AgentRequestDecision,
  AgentToolMetadata,
} from '@/shared/schemas/execution.js'
import { DEFAULT_AGENT_ACCESS_MODE } from '@/shared/schemas/execution.js'
import type { AgentRunId } from '@/shared/schemas/workspace.js'

import { claudeSignIn } from './account.js'
import { resolveInstalledClaudeExecutable } from './executable.js'
import { type ClaudeEffortLevel, claudeModelChoices, isClaudeEffort } from './models.js'

const DRIVER_ID = 'claude-agent-sdk'
const EVENT_CAPACITY = 1024
const MAX_TOOL_TEXT_BYTES = 8192
const MAX_TOOL_CONTENT_BYTES = 128 * 1024
const TOOL_TEXT_CHUNK_SIZE = 1000
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
  // Where Claude Code keeps its sign-in, so a run uses the user's own login.
  'CLAUDE_CONFIG_DIR',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
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
  /** Installed Claude Code executable the SDK drives; the SDK's bundled CLI when absent. */
  readonly executablePath?: (() => string | undefined) | undefined
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
  promptContent: { images: true, files: true },
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
  modes: [],
}

/** Mode ID written before effort levels existed. It selects the SDK default and stays accepted for old intents. */
const LEGACY_DEFAULT_MODE = 'default'
const CATALOG_PROBE_TIMEOUT_MS = 10_000

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
  readonly suggestions?: ReadonlyArray<PermissionUpdate>
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

function boundedEventField(text: string, byteLimit: number): string {
  let bounded = boundedText(text, byteLimit)
  while (new TextEncoder().encode(JSON.stringify(bounded)).byteLength > byteLimit)
    bounded = `${bounded.slice(0, Math.floor(bounded.length * 0.8))}… [truncated]`
  return bounded
}

const encodeToolInput = (input: unknown, byteLimit = MAX_TOOL_TEXT_BYTES): string | undefined => {
  try {
    const encoded = JSON.stringify(input)
    return encoded === undefined ? undefined : boundedText(encoded, byteLimit)
  } catch {
    return undefined
  }
}

const toolInputDetailsSchema = Schema.Struct({
  command: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  file_path: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
})

const todoInputSchema = Schema.Struct({
  todos: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      status: Schema.Literals(['pending', 'in_progress', 'completed']),
    }),
  ),
})

const toolOutputDetailsSchema = Schema.Struct({
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number.check(Schema.isInt())),
  exit_code: Schema.optional(Schema.Number.check(Schema.isInt())),
  durationMs: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  duration_ms: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  filePath: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  staged: Schema.optional(Schema.Boolean),
  structuredPatch: Schema.optional(
    Schema.Array(
      Schema.Struct({
        oldStart: Schema.Number.check(Schema.isInt()),
        oldLines: Schema.Number.check(Schema.isInt()),
        newStart: Schema.Number.check(Schema.isInt()),
        newLines: Schema.Number.check(Schema.isInt()),
        lines: Schema.Array(Schema.String),
      }),
    ),
  ),
  gitDiff: Schema.optional(Schema.Struct({ filename: Schema.String, status: Schema.String, patch: Schema.String })),
})

function toolOutputDetails(value: unknown): { readonly metadata: AgentToolMetadata; readonly output?: string } {
  const decoded = Schema.decodeUnknownOption(toolOutputDetailsSchema)(value)
  if (decoded._tag !== 'Some') return { metadata: {} }
  const result = decoded.value
  const metadata: AgentToolMetadata = {
    ...(result.exitCode !== undefined || result.exit_code !== undefined
      ? { exitCode: result.exitCode ?? result.exit_code }
      : {}),
    ...(result.durationMs !== undefined || result.duration_ms !== undefined
      ? { durationMs: result.durationMs ?? result.duration_ms }
      : {}),
  }
  const path = result.filePath ?? result.gitDiff?.filename
  if (path && !result.staged) {
    let patch = result.gitDiff?.patch
    if (patch === undefined && result.structuredPatch?.length)
      patch = result.structuredPatch
        .map(
          part =>
            `@@ -${part.oldStart},${part.oldLines} +${part.newStart},${part.newLines} @@\n${part.lines.join('\n')}`,
        )
        .join('\n')
    if (patch !== undefined) {
      const displayPath = boundedEventField(path, 1024)
      const changes: NonNullable<AgentToolMetadata['changes']> = [
        {
          path: displayPath,
          kind: result.type === 'create' || result.gitDiff?.status === 'added' ? 'add' : 'update',
          diff: boundedEventField(patch, 6000),
        },
      ]
      return { metadata: { ...metadata, changes, paths: [displayPath] } }
    }
  }
  const output = [result.stdout, result.stderr]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('\n')
  return { metadata, ...(result.stdout !== undefined || result.stderr !== undefined ? { output } : {}) }
}

function toolMetadata(name: string, input: unknown): AgentToolMetadata {
  const decoded = Schema.decodeUnknownOption(toolInputDetailsSchema)(input)
  const details = decoded._tag === 'Some' ? decoded.value : undefined
  const categories: Readonly<Record<string, AgentToolMetadata['category']>> = {
    Bash: 'command',
    Read: 'fileRead',
    Edit: 'fileWrite',
    MultiEdit: 'fileWrite',
    Write: 'fileWrite',
    Glob: 'search',
    Grep: 'search',
    WebSearch: 'web',
    WebFetch: 'web',
    Task: 'subagent',
    Agent: 'subagent',
  }
  let result: AgentToolMetadata = { category: name.startsWith('mcp__') ? 'mcp' : (categories[name] ?? 'other') }
  function add(fields: AgentToolMetadata): void {
    const next = { ...result, ...fields }
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength <= 6000) result = next
  }
  if (details?.command) add({ command: boundedText(details.command, 2048) })
  if (details?.cwd) add({ cwd: boundedText(details.cwd, 1024) })
  const path = details?.file_path ?? details?.path
  if (path) add({ paths: [boundedText(path, 1024)] })
  if (details?.url) add({ url: boundedText(details.url, 2048) })
  const description = details?.description ?? details?.pattern ?? details?.query
  if (description) add({ description: boundedText(description, 2048) })
  return result
}

const questionRequest = (
  input: ParsedAskUserQuestion,
  requestId: string,
  runId: AgentRunId,
  sessionId: AgentSessionContext['sessionId'],
  generation: number,
  nativeRequestId: string,
  toolCallId: string,
  toolInput: unknown,
): AgentRequest => {
  const questions = input.questions.map((question, questionIndex) => ({
    id: `q${questionIndex}`,
    prompt: question.question,
    ...(question.header ? { header: question.header } : {}),
    allowCustomAnswer: true,
    multiSelect: question.multiSelect,
    options: question.options.map((option, optionIndex) => ({
      id: `q${questionIndex}-o${optionIndex}`,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
  }))
  return {
    requestId,
    runId,
    sessionId,
    generation,
    kind: 'question',
    cancelDecision: { kind: 'cancel' },
    prompt: questions.map(({ prompt }) => prompt).join('\n'),
    questions,
    toolCallId,
    tool: toolMetadata('AskUserQuestion', toolInput),
    nativeRequestId,
  }
}

/**
 * Approval choices as the Claude Code client presents them: Approve and Decline primary, the session-wide
 * grant and Cancel behind the extra-options menu. Claude withholds a standing grant for some requests
 * (`suppressAlwaysAllowRule`), and then the only choices are Approve and Decline.
 */
const makeAskRequest = (
  toolName: string,
  prompt: string,
  requestId: string,
  runId: AgentRunId,
  sessionId: AgentSessionContext['sessionId'],
  generation: number,
  nativeRequestId: string,
  toolCallId: string,
  toolInput: unknown,
  allowSession: boolean,
): AgentRequest => ({
  requestId,
  runId,
  sessionId,
  generation,
  kind: 'approval',
  prompt,
  toolCallId,
  tool: toolMetadata(toolName, toolInput),
  options: [
    {
      id: 'allow-once',
      label: 'Approve',
      scope: 'once',
      kind: 'allow',
      decision: { kind: 'approve', optionId: 'allow-once' },
    },
    ...(allowSession
      ? [
          {
            id: 'allow-session',
            label: 'Always allow this session',
            scope: 'session' as const,
            kind: 'allowAlways' as const,
            decision: { kind: 'approve' as const, optionId: 'allow-session' },
          },
        ]
      : []),
    { id: 'deny-once', label: 'Decline', scope: 'once', kind: 'deny', decision: { kind: 'deny' } },
    { id: 'cancel', label: 'Cancel', scope: 'once', kind: 'other', decision: { kind: 'cancel' } },
  ],
  questions: [],
  nativeRequestId,
})

const sdkMessageSessionId = (message: SDKMessage): string | undefined =>
  'session_id' in message && typeof message.session_id === 'string' ? message.session_id : undefined

const isOurApiKeyAuth = (message: SDKMessage): boolean =>
  message.type === 'system' && message.subtype === 'init' && message.apiKeySource === 'ANTHROPIC_API_KEY'

/** A given API key is passed alone; without one, the bundled CLI signs in with the user's Claude Code login. */
const claudeProcessEnvironment = (apiKey: string | undefined): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = apiKey === undefined ? {} : { ANTHROPIC_API_KEY: apiKey }
  const path = executablePathEnv()
  if (path) env.PATH = path
  for (const name of EXECUTION_ENVIRONMENT_KEYS) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** Defers each tool call to the held permission callback, optionally only for tools with the given name. */
const askBeforeTool = (matcher?: string): NonNullable<Options['hooks']> => ({
  PreToolUse: [
    {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })],
    },
  ],
})

/** Native SDK policy for an access mode. Only approval-required asks before every tool. The other modes keep
 * AskUserQuestion on the held callback so a question is never answered without the user. */
const claudePermissionOptions = (
  accessMode: AgentAccessMode,
): Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions' | 'hooks'> => {
  switch (accessMode) {
    case 'approval-required':
      return { permissionMode: 'default', hooks: askBeforeTool() }
    case 'auto-accept-edits':
      return { permissionMode: 'acceptEdits', hooks: askBeforeTool('AskUserQuestion') }
    case 'auto':
      return { permissionMode: 'auto', hooks: askBeforeTool('AskUserQuestion') }
    case 'full-access':
      return {
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        hooks: askBeforeTool('AskUserQuestion'),
      }
  }
}

/** A streaming prompt that sends nothing, so a probe query never starts a turn. It ends when the probe aborts. */
const idlePrompt = (signal: AbortSignal): AsyncIterable<SDKUserMessage> => ({
  [Symbol.asyncIterator]: () => ({
    next: async (): Promise<IteratorResult<SDKUserMessage>> => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()))
      return { done: true, value: undefined }
    },
  }),
})

/** Reads the models Claude Code offers, with each model's effort levels, from a query that never sends a turn. */
const probeClaudeCatalog = (
  sdk: ClaudeAgentSdk,
  apiKey: string | undefined,
  executablePath: string | undefined,
): Effect.Effect<AgentCatalogProbe, AgentDriverError> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const abortController = new AbortController()
        const probe = sdk.query({
          prompt: idlePrompt(abortController.signal),
          options: {
            cwd: tmpdir(),
            abortController,
            ...(executablePath === undefined ? {} : { pathToClaudeCodeExecutable: executablePath }),
            settingSources: [],
            permissionMode: 'default',
            canUseTool: async () => ({ behavior: 'deny', message: 'Catalog probes never run tools.' }),
            env: claudeProcessEnvironment(apiKey),
          },
        })
        return { probe, abortController }
      },
      catch: () => makeError('driver-unavailable', 'Claude models could not be read.'),
    }),
    ({ probe }) =>
      Effect.all(
        [
          Effect.tryPromise({
            try: () => probe.supportedModels(),
            catch: () => makeError('protocol-error', 'Claude models could not be read.'),
          }),
          // The account is extra: models still list when the CLI cannot report it.
          Effect.tryPromise({
            try: () => probe.accountInfo(),
            catch: () => makeError('protocol-error', 'Claude account could not be read.'),
          }).pipe(Effect.option),
        ],
        { concurrency: 'unbounded' },
      ).pipe(
        Effect.timeoutOption(`${CATALOG_PROBE_TIMEOUT_MS} millis`),
        Effect.flatMap(result =>
          result._tag === 'Some'
            ? Effect.succeed(result.value)
            : Effect.fail(makeError('timeout', 'Claude models could not be read in time.')),
        ),
        Effect.map(([models, account]) => ({
          models: claudeModelChoices(models, 240),
          modes: [],
          ...(account._tag === 'Some' ? { signIn: claudeSignIn(account.value) } : {}),
        })),
      ),
    ({ probe, abortController }) =>
      Effect.sync(() => {
        abortController.abort()
        try {
          probe.close()
        } catch {
          /* The probe process is already gone. */
        }
      }),
  )

const probeClaudePromptCommands = (
  sdk: ClaudeAgentSdk,
  apiKey: string | undefined,
  workspacePath: string,
  executablePath: string | undefined,
): Effect.Effect<AgentPromptCatalog['commands'], AgentDriverError> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const abortController = new AbortController()
        const probe = sdk.query({
          prompt: idlePrompt(abortController.signal),
          options: {
            cwd: workspacePath,
            abortController,
            ...(executablePath === undefined ? {} : { pathToClaudeCodeExecutable: executablePath }),
            settingSources: ['user', 'project', 'local'],
            settings: { disableAllHooks: true },
            allowedTools: [],
            mcpServers: {},
            permissionMode: 'default',
            canUseTool: async () => ({ behavior: 'deny', message: 'Prompt catalog probes never run tools.' }),
            env: claudeProcessEnvironment(apiKey),
          },
        })
        return { probe, abortController }
      },
      catch: () => makeError('driver-unavailable', 'Claude slash commands could not be read.'),
    }),
    ({ probe }) =>
      Effect.tryPromise({
        try: () => probe.initializationResult(),
        catch: () => makeError('protocol-error', 'Claude slash commands could not be read.'),
      }).pipe(
        Effect.timeoutOption(`${CATALOG_PROBE_TIMEOUT_MS} millis`),
        Effect.flatMap(result =>
          result._tag === 'Some'
            ? Effect.succeed(result.value.commands)
            : Effect.fail(makeError('timeout', 'Claude slash command discovery timed out.')),
        ),
        Effect.map(commands => [
          { name: 'compact', description: 'Compact this conversation to free up context.' },
          ...commands.flatMap(command => {
            const name = command.name.trim()
            if (!name) return []
            const description = command.description?.trim() ?? ''
            const inputHint = command.argumentHint?.trim()
            return [{ name, description, ...(inputHint ? { inputHint } : {}) }]
          }),
        ]),
      ),
    ({ probe, abortController }) =>
      Effect.sync(() => {
        abortController.abort()
        try {
          probe.close()
        } catch {
          /* The probe process is already gone. */
        }
      }),
  )

const modeOptions = (
  context: AgentSessionContext,
  native: NativeSessionReference | undefined,
  nativeSessionId: string,
  apiKey: string | undefined,
  executablePath: string | undefined,
): Options => {
  return {
    cwd: context.workspacePath,
    ...(context.modelId !== undefined ? { model: context.modelId } : {}),
    ...(context.modeId !== undefined && isClaudeEffort(context.modeId) ? { effort: context.modeId } : {}),
    ...(executablePath === undefined ? {} : { pathToClaudeCodeExecutable: executablePath }),
    ...claudePermissionOptions(context.accessMode ?? DEFAULT_AGENT_ACCESS_MODE),
    settingSources: ['user', 'project', 'local'],
    tools: { type: 'preset', preset: 'claude_code' },
    includePartialMessages: true,
    ...(context.browserMcp
      ? {
          mcpServers: {
            'watchtower-browser': {
              type: 'http' as const,
              url: context.browserMcp.url,
              headers: { Authorization: `Bearer ${context.browserMcp.token}` },
            },
          },
        }
      : {}),
    ...(native ? { resume: native.nativeSessionId } : { sessionId: nativeSessionId }),
    env: claudeProcessEnvironment(apiKey),
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
  apiKey: string | undefined,
  executablePath: string | undefined,
  catalogEfforts?: ReadonlyMap<string, ReadonlySet<ClaudeEffortLevel>>,
): Effect.Effect<AgentDriverSession, AgentDriverError> =>
  Effect.gen(function* () {
    const nativeSessionId = native?.nativeSessionId ?? freshNativeSessionId ?? id()
    if (context.modeId !== undefined && context.modeId !== LEGACY_DEFAULT_MODE && !isClaudeEffort(context.modeId)) {
      return yield* makeError('invalid-state', 'The requested Claude effort level is not supported by this driver.')
    }
    const supportedEfforts = context.modelId ? catalogEfforts?.get(context.modelId) : undefined
    if (
      context.modeId !== undefined &&
      context.modeId !== LEGACY_DEFAULT_MODE &&
      supportedEfforts !== undefined &&
      !supportedEfforts.has(context.modeId)
    ) {
      return yield* makeError('invalid-state', 'The selected Claude model does not support this effort level.')
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
    const streamedTools = new Map<number, { readonly id: string; bytes: number; truncated: boolean }>()
    let streamMessageId: string | undefined
    const closed = { value: false }
    const currentRunId = { value: undefined as AgentRunId | undefined }
    const pumpFailure = { value: undefined as AgentDriverError | undefined }
    const queryOptions = modeOptions(context, native, nativeSessionId, apiKey, executablePath)

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

    const emitToolText = Effect.fnUntraced(function* (
      runId: AgentRunId | undefined,
      toolCallId: string,
      field: 'input' | 'output',
      text: string,
      append = false,
    ): Effect.fn.Return<void, AgentDriverError> {
      const content = boundedText(text, MAX_TOOL_CONTENT_BYTES)
      for (let offset = 0; offset < Math.max(1, content.length); offset += TOOL_TEXT_CHUNK_SIZE) {
        yield* emit(runId, {
          kind: 'toolUpdated',
          toolCallId,
          [field]: content.slice(offset, offset + TOOL_TEXT_CHUNK_SIZE),
          append: append || offset > 0,
        })
      }
    })

    const emitToolInput = Effect.fnUntraced(function* (
      runId: AgentRunId | undefined,
      toolCallId: string,
      name: string,
      input: unknown,
    ): Effect.fn.Return<void, AgentDriverError> {
      const encoded = encodeToolInput(input, MAX_TOOL_CONTENT_BYTES)
      if (encoded !== undefined) yield* emitToolText(runId, toolCallId, 'input', encoded)
      if (name !== 'TodoWrite') return
      const decoded = Schema.decodeUnknownOption(todoInputSchema)(input)
      if (decoded._tag !== 'Some') return
      const entries: Extract<AgentDriverEvent, { kind: 'planUpdated' }>['entries'][number][] = []
      for (const entry of decoded.value.todos) {
        const next = {
          content: boundedText(entry.content, 2048),
          status: entry.status === 'in_progress' ? ('inProgress' as const) : entry.status,
        }
        if (new TextEncoder().encode(JSON.stringify([...entries, next])).byteLength > 8000) break
        entries.push(next)
      }
      yield* emit(runId, { kind: 'planUpdated', entries })
      if (entries.length < decoded.value.todos.length)
        yield* emit(runId, {
          kind: 'nativeNotice',
          message: 'The plan display was truncated because it exceeded the display limit.',
        })
    })

    const emitToolStart = Effect.fnUntraced(function* (
      runId: AgentRunId | undefined,
      toolCallId: string,
      name: string,
      input: unknown,
      streaming: boolean,
    ): Effect.fn.Return<void, AgentDriverError> {
      if (!runId) return
      activeTools.set(toolCallId, runId)
      const encoded = encodeToolInput(input, MAX_TOOL_CONTENT_BYTES)
      const initialInput = streaming && encoded === '{}' ? '' : encoded
      const inline = initialInput === undefined || JSON.stringify(initialInput).length <= 6000
      yield* emit(runId, {
        kind: 'toolStarted',
        toolCallId,
        name,
        ...toolMetadata(name, input),
        input: inline ? initialInput : '',
      })
      if (!inline || name === 'TodoWrite') yield* emitToolInput(runId, toolCallId, name, input)
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
      const request: PendingRequest = {
        runId,
        generation,
        decision: wait,
        toolInput,
        ...(options.suggestions?.length ? { suggestions: options.suggestions } : {}),
      }
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
        ? questionRequest(
            parsedQuestions,
            requestId,
            runId,
            context.sessionId,
            generation,
            options.requestId,
            options.toolUseID,
            toolInput,
          )
        : makeAskRequest(
            toolName,
            title,
            requestId,
            runId,
            context.sessionId,
            generation,
            options.requestId,
            options.toolUseID,
            toolInput,
            options.suppressAlwaysAllowRule !== true,
          )
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
          if (decision.optionId === 'allow-session') {
            const updates: PermissionUpdate[] = request.suggestions?.length
              ? request.suggestions.map(suggestion => ({ ...suggestion, destination: 'session' as const }))
              : [
                  {
                    type: 'addRules',
                    rules: [{ toolName }],
                    behavior: 'allow',
                    destination: 'session' as const,
                  },
                ]
            return {
              behavior: 'allow',
              updatedInput: toolInput,
              toolUseID: options.toolUseID,
              decisionClassification: 'user_permanent',
              updatedPermissions: updates,
            }
          }
          if (decision.optionId !== undefined && decision.optionId !== 'allow-once') {
            return { behavior: 'deny', message: 'The selected approval option does not grant this action.' }
          }
          return {
            behavior: 'allow',
            updatedInput: toolInput,
            toolUseID: options.toolUseID,
            decisionClassification: 'user_temporary',
          }
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
              if (!selection.startsWith(prefix)) return selection.trim() ? [selection] : []
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
          if (apiKey !== undefined && !isOurApiKeyAuth(message)) {
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
          if (event.type === 'message_start') {
            streamMessageId = event.message.id
            streamedTools.clear()
          }
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use' && runId) {
            yield* emitToolStart(
              runId,
              event.content_block.id,
              event.content_block.name,
              event.content_block.input,
              true,
            )
            streamedTools.set(event.index, { id: event.content_block.id, bytes: 0, truncated: false })
          } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
            const tool = streamedTools.get(event.index)
            if (tool && !tool.truncated) {
              const partial = event.delta.partial_json
              const remaining = MAX_TOOL_CONTENT_BYTES - tool.bytes - 32
              let next = partial
              if (new TextEncoder().encode(partial).byteLength > remaining) {
                next = remaining >= 64 ? boundedText(partial, remaining) : '… [truncated]'
                tool.truncated = true
              }
              tool.bytes += new TextEncoder().encode(next).byteLength
              yield* emitToolText(runId, tool.id, 'input', next, true)
            }
          } else if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta' &&
            event.delta.text.length > 0
          ) {
            yield* emit(runId, {
              kind: 'textDelta',
              text: event.delta.text,
              itemId: `${streamMessageId ?? runId}:${event.index}`,
            })
          } else if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'thinking_delta' &&
            event.delta.thinking.length > 0
          ) {
            yield* emit(runId, {
              kind: 'reasoningDelta',
              text: event.delta.thinking,
              itemId: `${streamMessageId ?? runId}:${event.index}`,
            })
          }
          if (event.type === 'content_block_stop') streamedTools.delete(event.index)
          return
        }

        if (message.type === 'user') {
          const content = Array.isArray(message.message.content) ? message.message.content : []
          const structured = toolOutputDetails(
            content.filter(block => block.type === 'tool_result').length === 1 ? message.tool_use_result : undefined,
          )
          for (const block of content) {
            if (block.type === 'tool_result') {
              const runId = activeTools.get(block.tool_use_id) ?? currentRunId.value
              const output =
                structured.output ??
                (typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
                    : undefined)
              if (output !== undefined) yield* emitToolText(runId, block.tool_use_id, 'output', output)
              yield* emit(runId, {
                kind: 'toolCompleted',
                toolCallId: block.tool_use_id,
                ...structured.metadata,
                error:
                  block.is_error || (structured.metadata.exitCode !== undefined && structured.metadata.exitCode !== 0)
                    ? 'Tool execution failed.'
                    : undefined,
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
            durationMs: Math.max(0, message.elapsed_time_seconds * 1000),
          })
          return
        }

        if (message.type === 'tool_use_summary') {
          for (const toolCallId of message.preceding_tool_use_ids) {
            yield* emit(activeTools.get(toolCallId) ?? currentRunId.value, {
              kind: 'toolUpdated',
              toolCallId,
              description: boundedText(message.summary, 2048),
            })
          }
          return
        }

        if (message.type === 'assistant') {
          if (message.parent_tool_use_id !== null) return
          if (message.error === 'authentication_failed')
            return yield* makeError(
              'authentication-required',
              apiKey === undefined
                ? 'Claude Code is not signed in. Run `claude auth login`, or set ANTHROPIC_API_KEY.'
                : 'Claude Agent SDK rejected ANTHROPIC_API_KEY.',
            )
          const runId = currentRunId.value
          const run = runId ? runs.get(runId) : undefined
          if (run && !run.started) {
            run.started = true
            yield* emit(runId, { kind: 'turnStarted' })
          }
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              if (activeTools.has(block.id)) {
                yield* emit(runId, {
                  kind: 'toolUpdated',
                  toolCallId: block.id,
                  name: block.name,
                  ...toolMetadata(block.name, block.input),
                })
                yield* emitToolInput(runId, block.id, block.name, block.input)
              } else {
                yield* emitToolStart(runId, block.id, block.name, block.input, false)
              }
            }
          }
          return
        }

        if (message.type === 'result') {
          const runId = currentRunId.value
          if (!runId) return
          streamedTools.clear()
          streamMessageId = undefined
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
            message: {
              role: 'user',
              content: input.attachments?.length
                ? [
                    { type: 'text', text },
                    ...input.attachments.map(attachment => {
                      if (attachment.mediaType.startsWith('image/'))
                        return {
                          type: 'image' as const,
                          source: {
                            type: 'base64' as const,
                            media_type: attachment.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                            data: attachment.content,
                          },
                        }
                      if (attachment.mediaType === 'application/pdf')
                        return {
                          type: 'document' as const,
                          source: {
                            type: 'base64' as const,
                            media_type: 'application/pdf' as const,
                            data: attachment.content,
                          },
                        }
                      return { type: 'text' as const, text: attachmentText(attachment) }
                    }),
                  ]
                : text,
            },
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
  const resolveExecutable = dependencies.executablePath ?? resolveInstalledClaudeExecutable

  return Layer.succeed(
    AgentDriver,
    AgentDriver.of({
      driverId: DRIVER_ID,
      accessModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'],
      connect: (options: AgentDriverConnectOptions) =>
        Effect.gen(function* () {
          const key = apiKey() || undefined
          const executablePath = resolveExecutable()
          const childScope = yield* Scope.make()
          let connectionClosed = false
          let catalogEfforts: ReadonlyMap<string, ReadonlySet<ClaudeEffortLevel>> | undefined

          const connection: AgentDriverConnection = {
            identity: {
              id: options.connectionId,
              driverId: DRIVER_ID,
              protocolVersion: 'claude-agent-sdk/0.3.270',
              authentication: 'unknown',
            },
            discover: () => Effect.succeed(capabilities),
            discoverPromptCatalog: workspacePath =>
              Effect.gen(function* () {
                const catalog = yield* Effect.tryPromise({
                  try: () => discoverClaudePromptCatalog(workspacePath),
                  catch: () => makeError('protocol-error', 'Claude skill catalog could not be read.'),
                })
                const commands = yield* probeClaudePromptCommands(sdk, key, workspacePath, executablePath)
                return normalizeAgentPromptCatalog({ ...catalog, commands: [...commands, ...catalog.commands] })
              }),
            probeCatalog: () =>
              probeClaudeCatalog(sdk, key, executablePath).pipe(
                Effect.tap(catalog =>
                  Effect.sync(() => {
                    catalogEfforts = new Map(
                      catalog.models.map(model => [
                        model.id,
                        new Set((model.modes ?? []).map(mode => mode.id).filter(isClaudeEffort)),
                      ]),
                    )
                  }),
                ),
              ),
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
                  executablePath,
                  catalogEfforts,
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
                return yield* makeSession(
                  childScope,
                  context,
                  native,
                  undefined,
                  native.generation,
                  sdk,
                  id,
                  key,
                  executablePath,
                  catalogEfforts,
                )
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
