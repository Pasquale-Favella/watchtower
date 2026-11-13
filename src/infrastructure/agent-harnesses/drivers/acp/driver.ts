import { tmpdir } from 'node:os'

import {
  type Agent,
  type AvailableCommand,
  type Client,
  ClientSideConnection,
  type ContentBlock,
  type InitializeResponse,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { ChildProcessSpawner } from 'effect/process'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import {
  AgentDriver,
  type AgentDriverConnection,
  type AgentDriverConnectOptions,
  AgentDriverError,
  type AgentDriverSession,
  type AgentSessionContext,
  type AgentTurnInput,
  type DeliveryOutcome,
  type InterruptAcknowledgement,
  type NativeSessionReference,
  UnsupportedAgentOperation,
} from '@/core/ports/agent-driver.js'
import { type JsonRpcTransport, spawnJsonRpcStdio } from '@/infrastructure/agent-harnesses/drivers/json-rpc.js'
import { attachmentText } from '@/infrastructure/agent-harnesses/drivers/prompt-content.js'
import type {
  AgentAccessMode,
  AgentCapabilities,
  AgentDriverEvent,
  AgentPromptCatalog,
  AgentReconcileEvent,
  AgentRequestDecision,
  AgentSessionIdentity,
  AgentToolMetadata,
} from '@/shared/schemas/execution.js'
import type { AcpMcpServer } from '@/infrastructure/agent-harnesses/harnesses/types.js'
import { DEFAULT_AGENT_ACCESS_MODE, MAX_AGENT_CATALOG_CHOICES } from '@/shared/schemas/execution.js'
import type { AgentRunId } from '@/shared/schemas/workspace.js'

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_CATALOG_CHOICES = MAX_AGENT_CATALOG_CHOICES
const MAX_EVENTS = 128
const MAX_EVENT_BYTES = 2 * 1024 * 1024
const MAX_REPLAY_EVENTS = 128
const MAX_REPLAY_BYTES = 2 * 1024 * 1024
const MAX_COMPLETED_CHANNELS = 32
const MAX_PREPARED_CHANNELS = 32
const MAX_TOOL_TEXT = 64 * 1024
const MAX_TOOL_ITEMS = 64
const MAX_IMAGE_DATA = 512 * 1024
const REPLAY_CURSOR_PREFIX = 'acp-replay:'

function sessionMcpServers(context: AgentSessionContext, httpMcpSupported: boolean): AcpMcpServer[] {
  if (!context.browserMcp) return []
  if (!httpMcpSupported && context.browserMcp.stdio) {
    return [
      {
        name: 'watchtower-browser',
        command: context.browserMcp.stdio.command,
        args: [...context.browserMcp.stdio.args],
        env: context.browserMcp.stdio.env.map(({ name, value }) => ({ name, value })),
      },
    ]
  }
  if (!httpMcpSupported) return []
  return [
    {
      type: 'http',
      name: 'watchtower-browser',
      url: context.browserMcp.url,
      headers: [{ name: 'Authorization', value: `Bearer ${context.browserMcp.token}` }],
    },
  ]
}

const defaultScrubbedEnvironment = Object.freeze([
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
  'ELECTRON_RUN_AS_NODE',
])

const nonBlank = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
const parsedJson = Schema.String.pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.parseJson(),
    encode: SchemaGetter.stringifyJson(),
  }),
)
const jsonStringArray = Schema.decodeTo(Schema.Array(Schema.String))(parsedJson)
const driverConfigurationSchema = Schema.Struct({
  command: nonBlank,
  argsJson: Schema.optional(jsonStringArray),
  nodeRuntime: Schema.optional(Schema.Literal('electron')),
})

export interface AcpDriverFactoryOptions {
  /** Trusted Electron executable for bundled ACP entries; Node mode is rejected when absent. */
  readonly runtimeExecutable?: string
  /** Immutable variable-name policy. Values are inherited from the parent process, never copied here. */
  readonly scrubEnvironment?: ReadonlyArray<string>
  /** Explicitly retain named inherited API-key variables that are scrubbed by default. */
  readonly preserveEnvironment?: ReadonlyArray<string>
}

export type AcpTransportFactory = (
  options: AgentDriverConnectOptions,
) => Effect.Effect<JsonRpcTransport, AgentDriverError, Scope.Scope>

export interface AcpDriverDependencies {
  readonly transportFactory: AcpTransportFactory
  readonly clientVersion?: string
}

interface RunChannel {
  readonly runId: AgentRunId
  readonly events: Queue.Queue<AgentDriverEvent, AgentDriverError | import('effect/Cause').Done<void>>
  pendingEvents: number
  pendingBytes: number
  failure?: AgentDriverError | undefined
  ended: boolean
  submitted: boolean
  consumerAttached: boolean
}

interface ActiveRun {
  readonly id: AgentRunId
  readonly channel: RunChannel
  readonly completion: Promise<void>
  readonly complete: () => void
  nativeTurnId?: string | undefined
  cancelRequested: boolean
}

interface PendingPermission {
  readonly kind: 'permission'
  readonly id: string
  readonly runId: AgentRunId
  readonly generation: number
  readonly nativeSessionId: string
  readonly options: ReadonlyArray<PermissionOption>
  readonly resolve: (response: RequestPermissionResponse) => void
  answered: boolean
}

interface PendingQuestion extends Omit<PendingPermission, 'kind' | 'options' | 'resolve'> {
  readonly kind: 'question'
  readonly questions: NonNullable<ReturnType<typeof questionFields>>
  readonly form: Schema.Schema.Type<typeof elicitationFormSchema>
  readonly resolve: (response: CreateElicitationResponse) => void
}

type PendingRequest = PendingPermission | PendingQuestion

interface ReplayRecord {
  readonly cursor: string
  readonly event: AgentDriverEvent
  readonly bytes: number
}

interface AcpSessionState {
  readonly context: AgentSessionContext
  readonly nativeSessionId: string
  readonly identity: AgentSessionIdentity
  readonly browserMcpUnavailable: boolean
  readonly queues: Map<AgentRunId, RunChannel>
  readonly completedRuns: Array<AgentRunId>
  readonly permissions: Map<string, PendingRequest>
  readonly replay: Array<ReplayRecord>
  replayBytes: number
  replaying: boolean
  activeRun?: ActiveRun | undefined
  requestSequence: number
  eventSequence: number
  liveCapabilities: AgentCapabilities
  configOptions: ReadonlyArray<SessionConfigOption>
  modeState?: AcpSessionModeState | undefined
  modelState?: AcpSessionModelState | undefined
  acceptRequests: boolean
  closed: boolean
  poison: (error: AgentDriverError) => void
}

interface AcpStateRef {
  current?: AcpSessionState
  /** Native IDs of disposable catalog probe sessions. */
  probes?: Set<string>
  promptCatalogProbe?: {
    readonly earlyCommands: Map<string, AgentPromptCatalog['commands']>
    readonly waiters: Map<string, (commands: AgentPromptCatalog['commands']) => void>
  }
}

interface AcpConnectionState {
  readonly identity: AgentDriverConnection['identity']
  readonly connection: ClientSideConnection
  readonly transport: JsonRpcTransport
  readonly loadSessionSupported: boolean
  readonly browserMcpHttpSupported: boolean
  readonly initializeModels?: AcpSessionModelState | undefined
  readonly initializeModes?: AcpSessionModeState | undefined
  session?: AcpSessionState | undefined
  closed: boolean
  transportClosed: boolean
}

const capability = (
  support: AgentCapabilities['submit']['support'],
  source: AgentCapabilities['submit']['evidence'][number]['source'],
  detail: string,
  restrictions: ReadonlyArray<string> = [],
): AgentCapabilities['submit'] => ({
  support,
  restrictions: [...restrictions],
  evidence: [{ source, detail }],
})

function connectionCapabilities(loadSessionSupported: boolean, images = false): AgentCapabilities {
  return {
    openSession: capability('supported', 'protocol', 'ACP session/new', [
      'One native session per scoped driver connection.',
    ]),
    loadSession: capability(
      loadSessionSupported ? 'supported' : 'unsupported',
      'protocol',
      loadSessionSupported ? 'Agent advertised session/load' : 'Agent did not advertise session/load',
    ),
    submit: capability('supported', 'protocol', 'ACP session/prompt'),
    interrupt: capability('supported', 'protocol', 'ACP session/cancel acknowledges request, not termination'),
    steer: capability('unsupported', 'driver', 'ACP has no standard turn-steering operation'),
    respond: capability('supported', 'protocol', 'ACP tool permission decisions and elicitation form responses', [
      'Persistent permission choices require an explicit user decision.',
    ]),
    reconcile: capability(
      loadSessionSupported ? 'supported' : 'unsupported',
      'protocol',
      loadSessionSupported ? 'session/load replays history during load' : 'History replay requires session/load',
    ),
    models: [],
    modes: [],
    promptContent: { images, files: true },
  }
}

function toDriverError(
  error: unknown,
  fallback: ConstructorParameters<typeof AgentDriverError>[0]['code'] = 'protocol-error',
): AgentDriverError {
  if (error instanceof AgentDriverError) return error
  if (error instanceof RequestError && error.code === -32000) {
    return new AgentDriverError({ code: 'authentication-required', message: 'ACP agent requires authentication.' })
  }
  if (error instanceof RequestError && error.code === -32800) {
    return new AgentDriverError({
      code: 'disconnected',
      message: 'ACP request was cancelled or the connection closed.',
    })
  }
  return new AgentDriverError({ code: fallback, message: 'ACP operation failed before its outcome was confirmed.' })
}

function unsupported(
  operation: ConstructorParameters<typeof UnsupportedAgentOperation>[0]['operation'],
  message: string,
) {
  return new UnsupportedAgentOperation({ operation, message })
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function boundedToolText(value: string): string {
  if (value.length <= MAX_TOOL_TEXT) return value
  const marker = '\n… [truncated]'
  return `${value.slice(0, MAX_TOOL_TEXT - marker.length)}${marker}`
}

function displayValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return boundedToolText(value)
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? undefined : boundedToolText(encoded)
  } catch {
    return '[unserializable native value]'
  }
}

const toolHintsSchema = Schema.Struct({
  command: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  cmd: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  file_path: Schema.optional(Schema.String),
  paths: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number.check(Schema.isInt())),
  exit_code: Schema.optional(Schema.Number.check(Schema.isInt())),
  durationMs: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  duration_ms: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
})

const elicitationPropertySchema = Schema.Struct({
  type: Schema.optional(Schema.Literals(['string', 'number', 'integer', 'boolean', 'array'])),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  enum: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  format: Schema.optional(Schema.String),
  items: Schema.optional(Schema.Struct({ enum: Schema.optional(Schema.Array(Schema.String)) })),
})
const elicitationFormSchema = Schema.Struct({
  properties: Schema.optional(Schema.Record(Schema.String, elicitationPropertySchema)),
  required: Schema.optional(Schema.Array(Schema.String)),
})
const elicitationRequestSchema = Schema.Struct({
  mode: Schema.String,
  message: Schema.String,
  sessionId: Schema.optional(Schema.NullOr(Schema.String)),
  requestId: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.NullOr(Schema.String)),
  requestedSchema: Schema.optional(Schema.Unknown),
})
type CreateElicitationResponse =
  | { readonly action: 'accept'; readonly content?: Record<string, string | number | boolean | ReadonlyArray<string>> }
  | { readonly action: 'decline' }
  | { readonly action: 'cancel' }

function toolHints(value: unknown): Schema.Schema.Type<typeof toolHintsSchema> | undefined {
  const decoded = Schema.decodeUnknownOption(toolHintsSchema)(value)
  return decoded._tag === 'Some' ? decoded.value : undefined
}

function toolCategory(kind: ToolCallUpdate['kind']): AgentToolMetadata['category'] {
  switch (kind) {
    case 'execute':
      return 'command'
    case 'read':
      return 'fileRead'
    case 'edit':
    case 'delete':
    case 'move':
      return 'fileWrite'
    case 'search':
      return 'search'
    case 'fetch':
      return 'web'
    case null:
    case undefined:
      return undefined
    default:
      return 'other'
  }
}

function filePatch(path: string, oldText: string | null | undefined, newText: string, budget: number): string {
  const limit = Math.max(0, Math.floor((budget - 256 - path.length * 2) / 4))
  const before = (oldText ?? '').slice(0, limit)
  const after = newText.slice(0, limit)
  const lines = (value: string) => (value.length === 0 ? [] : value.replace(/\n$/, '').split('\n'))
  const removed = lines(before)
  const added = lines(after)
  const truncated = before.length < (oldText?.length ?? 0) || after.length < newText.length
  const headerPath = path.replace(/[\r\n]/g, ' ')
  return [
    `--- ${oldText == null ? '/dev/null' : `a/${headerPath}`}`,
    `+++ b/${headerPath}`,
    `@@ -${removed.length ? 1 : 0},${removed.length} +${added.length ? 1 : 0},${added.length} @@`,
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
    ...(truncated ? ['[Diff display truncated]'] : []),
  ]
    .join('\n')
    .slice(0, budget)
}

function toolMetadata(update: ToolCallUpdate): AgentToolMetadata {
  const input = toolHints(update.rawInput)
  const output = toolHints(update.rawOutput)
  const nativeCommand = input?.command ?? input?.cmd
  const command = typeof nativeCommand === 'string' ? nativeCommand : nativeCommand?.join(' ')
  const category = toolCategory(update.kind)
  const exitCode = output?.exitCode ?? output?.exit_code
  const durationMs = output?.durationMs ?? output?.duration_ms
  const changes: NonNullable<AgentToolMetadata['changes']>[number][] = []
  let patchBudget = MAX_TOOL_TEXT
  for (const content of (update.content ?? []).slice(0, MAX_TOOL_ITEMS)) {
    if (content.type !== 'diff') continue
    const path = content.path.slice(0, 4096)
    const diff = patchBudget > 256 ? filePatch(path, content.oldText, content.newText, patchBudget) : undefined
    patchBudget -= diff?.length ?? 0
    const kind = update.kind === 'delete' ? 'delete' : content.oldText == null ? 'add' : 'update'
    changes.push({ path, kind, ...(diff !== undefined ? { diff } : {}) })
  }
  const paths = [
    ...new Set([
      ...(update.locations ?? []).slice(0, MAX_TOOL_ITEMS).map(location => location.path),
      ...(input?.paths ?? []).slice(0, MAX_TOOL_ITEMS),
      ...[input?.path ?? input?.filePath ?? input?.file_path].filter((path): path is string => path !== undefined),
      ...changes.map(change => change.path),
    ]),
  ]
    .slice(0, MAX_TOOL_ITEMS)
    .map(path => path.slice(0, 4096))
  return {
    ...(category ? { category } : {}),
    ...(update.title ? { description: update.title.slice(0, 4096) } : {}),
    ...(command !== undefined ? { command: command.slice(0, MAX_TOOL_TEXT) } : {}),
    ...(input?.cwd !== undefined ? { cwd: input.cwd.slice(0, 4096) } : {}),
    ...(input?.url !== undefined ? { url: input.url.slice(0, 4096) } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(paths.length ? { paths } : {}),
    ...(changes.length ? { changes } : {}),
  }
}

function imageEvent(
  content: Extract<ContentBlock, { type: 'image' }>,
  itemId?: string,
  alt?: string,
): AgentDriverEvent {
  if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(content.mimeType) || content.data.length > MAX_IMAGE_DATA) {
    return { kind: 'nativeNotice', message: 'ACP image format or size is unsupported for inline display.' }
  }
  if (content.data.length > 0 && content.data.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(content.data)) {
    return {
      kind: 'media',
      mediaType: content.mimeType,
      url: `data:${content.mimeType};base64,${content.data}`,
      ...(itemId ? { itemId } : {}),
      ...(alt ? { alt: alt.slice(0, 4096) } : {}),
    }
  }
  return { kind: 'nativeNotice', message: 'ACP image did not contain valid inline image data.' }
}

function toolContentText(update: ToolCallUpdate): string | undefined {
  const raw = displayValue(update.rawOutput)
  const parts: string[] = []
  let remaining = MAX_TOOL_TEXT
  let truncated = false
  for (const [index, item] of (update.content ?? []).entries()) {
    if (item.type !== 'content') continue
    const content = item.content
    let value: string | undefined
    if (content.type === 'text') value = content.text
    else if (content.type === 'resource' && 'text' in content.resource) value = content.resource.text
    else if (content.type === 'resource_link') value = `${content.title ?? content.name}\n${content.uri}`
    if (value === undefined) continue
    if (remaining <= 0 || index >= MAX_TOOL_ITEMS) {
      truncated = true
      continue
    }
    if (value.length > remaining) truncated = true
    parts.push(value.slice(0, remaining))
    remaining -= value.length + 1
  }
  let text = parts.join('\n')
  if (truncated) text = boundedToolText(`${text}\n… [truncated]`)
  if (raw !== undefined && text && raw !== text) return boundedToolText(`${raw}\n\n${text}`)
  return raw ?? (update.content != null ? text : undefined)
}

function translateTool(update: ToolCallUpdate, started: boolean): readonly AgentDriverEvent[] {
  const metadata = toolMetadata(update)
  const input = displayValue(update.rawInput)
  const output = toolContentText(update)
  const name = update.title?.trim().slice(0, 4096)
  const fields = {
    toolCallId: update.toolCallId,
    ...(name ? { name } : {}),
    ...(input !== undefined ? { input } : {}),
    ...metadata,
  }
  const events: AgentDriverEvent[] = []
  if (update.status === 'completed' || update.status === 'failed') {
    events.push({
      kind: 'toolCompleted',
      ...fields,
      ...(output !== undefined ? { output } : {}),
      ...(update.status === 'failed' ? { error: output || name || 'Tool failed' } : {}),
    })
  } else {
    if (started) events.push({ kind: 'toolStarted', ...fields, name: name || update.kind || 'tool' })
    if (!started || output !== undefined)
      events.push({ kind: 'toolUpdated', ...fields, ...(output !== undefined ? { output, append: false } : {}) })
  }
  for (const [index, content] of (update.content ?? []).slice(0, MAX_TOOL_ITEMS).entries()) {
    if (content.type === 'content' && content.content.type === 'image')
      events.push(imageEvent(content.content, `${update.toolCallId}:image:${index}`, name))
    else if (content.type === 'terminal')
      events.push({
        kind: 'nativeNotice',
        message: 'ACP referenced terminal output without an available client terminal.',
      })
  }
  return events
}

/** A blank native value (Copilot's default persona uses "") cannot be a catalog choice, so it is dropped. */
const isRepresentableChoice = (value: string): boolean => value.trim().length > 0

function configCatalog(options: ReadonlyArray<SessionConfigOption>, category: string) {
  const choices = options
    .filter(option => option.category === category)
    .flatMap(option => optionValues(option).flatMap(item => (isRepresentableChoice(item.value) ? [item] : [])))
  // One row per value: agents may list an alias such as Copilot's repeated "auto".
  const seen = new Set<string>()
  return choices.flatMap(item => {
    if (seen.has(item.value)) return []
    seen.add(item.value)
    return [{ id: item.value, label: item.name }]
  })
}

const HIDDEN_CONFIG_CATEGORIES = new Set(['permission', 'approval', 'access', 'security', 'sandbox'])

function configOptionCatalog(options: ReadonlyArray<SessionConfigOption>) {
  return options
    .filter(option => option.type === 'select')
    .filter(option => option.category !== 'model')
    .filter(option => !HIDDEN_CONFIG_CATEGORIES.has(option.category ?? ''))
    .slice(0, MAX_CATALOG_CHOICES)
    .flatMap(option => {
      if (!isRepresentableChoice(option.id)) return []
      const seen = new Set<string>()
      const choices = optionValues(option)
        .flatMap(item => {
          // ACP can use the empty value for a selectable default persona, as Copilot does.
          const hasCatalogValue = isRepresentableChoice(item.value) || item.value === ''
          if (!hasCatalogValue || seen.has(item.value)) return []
          seen.add(item.value)
          return [
            {
              id: item.value,
              label: item.name,
              ...(item.description ? { description: item.description } : {}),
            },
          ]
        })
        .slice(0, MAX_CATALOG_CHOICES)
      if (choices.length === 0) return []
      return [
        {
          id: option.id,
          label: option.name,
          ...(option.description ? { description: option.description } : {}),
          ...(option.category ? { category: option.category } : {}),
          currentValue: option.currentValue,
          options: choices,
        },
      ]
    })
}

function optionValues(
  option: SessionConfigOption,
): ReadonlyArray<{ readonly value: string; readonly name: string; readonly description?: string | null }> {
  return option.options.flatMap(group => {
    if ('value' in group) return [{ value: group.value, name: group.name, description: group.description }]
    return group.options.map(item => ({ value: item.value, name: item.name, description: item.description }))
  })
}

interface SessionCatalog {
  readonly modes?: AcpSessionModeState | null
  readonly models?: AcpSessionModelState | null
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null
}

interface AcpSessionModelState {
  readonly currentModelId: string
  readonly availableModels: ReadonlyArray<{
    readonly modelId: string
    readonly name: string
    readonly description?: string | null
    readonly _meta?: Readonly<Record<string, unknown>> | null
  }>
}

interface AcpSessionModeState {
  readonly currentModeId: string
  readonly availableModes: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly description?: string | null
    readonly _meta?: Readonly<Record<string, unknown>> | null
  }>
}

const metadataRecordSchema = Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))
const acpModelInfoSchema = Schema.Struct({
  _meta: Schema.optional(metadataRecordSchema),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  modelId: Schema.String,
  name: Schema.String,
})
const acpSessionModelStateSchema = Schema.Struct({
  _meta: Schema.optional(metadataRecordSchema),
  availableModels: Schema.Array(acpModelInfoSchema),
  currentModelId: Schema.String,
})
const acpSessionModeSchema = Schema.Struct({
  _meta: Schema.optional(metadataRecordSchema),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  id: Schema.String,
  name: Schema.String,
})
const acpSessionModeStateSchema = Schema.Struct({
  _meta: Schema.optional(metadataRecordSchema),
  availableModes: Schema.Array(acpSessionModeSchema),
  currentModeId: Schema.String,
})
const acpInitializeMetadataSchema = Schema.Struct({
  modelState: Schema.optional(Schema.Unknown),
  modeState: Schema.optional(Schema.Unknown),
})
const modelEffortSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
})
const modelMetadataSchema = Schema.Struct({
  reasoningEfforts: Schema.optional(Schema.Array(modelEffortSchema)),
})

function initializeCatalog(metadata: unknown): Pick<SessionCatalog, 'models' | 'modes'> {
  const decoded = Schema.decodeUnknownOption(acpInitializeMetadataSchema)(metadata)
  if (decoded._tag === 'None') return {}
  const modelState = Schema.decodeUnknownOption(acpSessionModelStateSchema)(decoded.value.modelState)
  const modeState = Schema.decodeUnknownOption(acpSessionModeStateSchema)(decoded.value.modeState)
  return {
    ...(modelState._tag === 'Some' ? { models: modelState.value } : {}),
    ...(modeState._tag === 'Some' ? { modes: modeState.value } : {}),
  }
}

function modelEfforts(metadata: unknown): AgentCapabilities['models'][number]['modes'] | undefined {
  const decoded = Schema.decodeUnknownOption(modelMetadataSchema)(metadata)
  if (decoded._tag === 'None' || decoded.value.reasoningEfforts === undefined) return undefined
  return decoded.value.reasoningEfforts.map(effort => ({
    id: effort.id,
    label: effort.label ?? effort.name ?? effort.id,
  }))
}

function sessionCapabilities(response: SessionCatalog): Pick<AgentCapabilities, 'models' | 'modes' | 'configOptions'> {
  const configOptions = response.configOptions ?? []
  const effort = configCatalog(configOptions, 'thought_level').filter(choice => choice.id !== 'default')
  const executableEfforts = new Map(effort.map(choice => [choice.id, choice.label]))
  const seenModels = new Set<string>()
  const modelState = response.models?.availableModels.flatMap(model => {
    if (!isRepresentableChoice(model.modelId) || seenModels.has(model.modelId)) return []
    seenModels.add(model.modelId)
    const advertisedEfforts = modelEfforts(model._meta)
    const modes = advertisedEfforts?.flatMap(choice => {
      const label = executableEfforts.get(choice.id)
      return label ? [{ id: choice.id, label }] : []
    })
    return [
      {
        id: model.modelId,
        label: model.name,
        ...(model.description ? { description: model.description.slice(0, 256) } : {}),
        ...(advertisedEfforts !== undefined ? { modes: modes ?? [] } : {}),
      },
    ]
  })
  const configuredModels = configCatalog(configOptions, 'model')
  const modelMetadata = new Map((modelState ?? []).map(model => [model.id, model]))
  const models =
    configuredModels.length > 0
      ? configuredModels.map(model => {
          const advertised = modelMetadata.get(model.id)
          return {
            ...model,
            ...(advertised?.description ? { description: advertised.description } : {}),
            ...(advertised?.modes !== undefined ? { modes: advertised.modes } : {}),
          }
        })
      : (modelState ?? [])
  // Reasoning effort is the run choice offered first; OpenCode reports it as a thought level. Agents
  // without one keep their session modes.
  // OpenCode lists its own "default" level; the picker's blank choice already means the agent default.
  const configModes = configCatalog(configOptions, 'mode')
  let modes = response.modes?.availableModes.map(mode => ({ id: mode.id, label: mode.name })) ?? []
  if (configModes.length > 0) modes = configModes
  if (effort.length > 0) modes = effort
  const configurableOptions = configOptionCatalog(configOptions)
  const nativeModes = response.modes?.availableModes ?? []
  if (nativeModes.length > 0 && !configOptions.some(option => option.category === 'mode')) {
    configurableOptions.push({
      id: 'acp-session-mode',
      label: 'Mode',
      category: 'mode',
      currentValue: response.modes?.currentModeId ?? '',
      options: nativeModes.slice(0, MAX_CATALOG_CHOICES).map(mode => ({ id: mode.id, label: mode.name })),
    })
  }
  // A catalog larger than the renderer contract would fail the whole inspection, so it is trimmed instead.
  return {
    models: models.slice(0, MAX_CATALOG_CHOICES),
    modes: modes.slice(0, MAX_CATALOG_CHOICES),
    configOptions: configurableOptions,
  }
}

function promptCommands(commands: ReadonlyArray<AvailableCommand>): AgentPromptCatalog['commands'] {
  return commands.slice(0, 256).map(command => ({
    name: command.name,
    description: command.description,
    ...(command.input?.hint ? { inputHint: command.input.hint } : {}),
  }))
}

/**
 * An agent may publish reasoning effort only for the model its session is on (OpenCode does), so the
 * catalog probe asks every model in turn on disposable sessions. The first few answers decide whether the
 * agent has per-model efforts at all, so an agent without them pays almost nothing; the rest is bounded
 * by a deadline and a model that did not answer in time simply keeps no declared efforts.
 */
const MODEL_EFFORT_SESSION_LIMIT = 8
const MODEL_EFFORT_DISCOVERY_SAMPLE = 4
const MODEL_EFFORT_PROBE_DEADLINE = '3 seconds'
const MODEL_EFFORT_REQUEST_DEADLINE = '1 second'

type DeclaredEffort = Readonly<{ id: string; label: string }>

const declaredEfforts = (configOptions: ReadonlyArray<SessionConfigOption> | null | undefined): DeclaredEffort[] =>
  configCatalog(configOptions ?? [], 'thought_level').filter(choice => choice.id !== 'default')

/** Config option categories a Run's mode ID may select. */
const SELECTABLE_MODE_CATEGORIES: ReadonlyArray<string> = ['mode', 'thought_level']

/**
 * Reads the per-model reasoning efforts of an agent that publishes them only for the session's current
 * model. Each answer arrives as the session config options after a model switch; results are collected in
 * `found`, which keeps whatever answered before the caller's deadline.
 */
function probeModelEfforts(
  client: ClientSideConnection,
  modelOptionId: string,
  modelIds: ReadonlyArray<string>,
  onSession: (sessionId: string) => void,
  found: Map<string, ReadonlyArray<DeclaredEffort>>,
): Effect.Effect<void> {
  const ask = (sessionId: string, modelId: string) =>
    Effect.tryPromise({
      try: () =>
        client.setSessionConfigOption({
          sessionId: sessionId as never,
          configId: modelOptionId as never,
          value: modelId as never,
        }),
      catch: () => undefined,
    }).pipe(
      Effect.timeoutOption(MODEL_EFFORT_REQUEST_DEADLINE),
      Effect.map(Option.getOrUndefined),
      Effect.flatMap(updated =>
        Effect.sync(() => {
          const efforts = declaredEfforts(updated?.configOptions ?? [])
          if (efforts.length > 0) found.set(modelId, efforts)
        }),
      ),
      Effect.ignore,
    )
  const open = () =>
    Effect.tryPromise({ try: () => client.newSession({ cwd: tmpdir(), mcpServers: [] }), catch: () => undefined }).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
  return Effect.gen(function* () {
    const sample = yield* open()
    if (!sample) return
    onSession(sample.sessionId)
    yield* Effect.forEach(modelIds.slice(0, MODEL_EFFORT_DISCOVERY_SAMPLE), modelId => ask(sample.sessionId, modelId), {
      discard: true,
    })
    const remaining = modelIds.slice(MODEL_EFFORT_DISCOVERY_SAMPLE)
    if (found.size === 0 || remaining.length === 0) return
    const extra = yield* Effect.forEach(
      Array.from({ length: Math.min(MODEL_EFFORT_SESSION_LIMIT - 1, remaining.length) }),
      open,
      { concurrency: 'unbounded' },
    )
    for (const session of extra) if (session) onSession(session.sessionId)
    const sessions = [sample.sessionId, ...extra.flatMap(session => (session ? [session.sessionId] : []))]
    yield* Effect.forEach(
      sessions,
      (sessionId, index) =>
        Effect.forEach(
          remaining.filter((_, position) => position % sessions.length === index),
          modelId => ask(sessionId, modelId),
          { discard: true },
        ),
      { concurrency: 'unbounded', discard: true },
    )
  })
}

function emptyEventChannel(runId: AgentRunId): Effect.Effect<RunChannel, never> {
  return Effect.map(
    Queue.bounded<AgentDriverEvent, AgentDriverError | import('effect/Cause').Done<void>>(MAX_EVENTS),
    events => ({
      runId,
      events,
      pendingEvents: 0,
      pendingBytes: 0,
      ended: false,
      submitted: false,
      consumerAttached: false,
    }),
  )
}

function failChannel(channel: RunChannel, error: AgentDriverError): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (channel.ended) return
    channel.failure = error
    channel.ended = true
    yield* Queue.fail(channel.events, error)
  })
}

function endChannel(channel: RunChannel): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (channel.ended) return
    channel.ended = true
    yield* Queue.end(channel.events)
  })
}

function emitEventEffect(state: AcpSessionState, event: AgentDriverEvent): Effect.Effect<void, AgentDriverError> {
  return Effect.tryPromise({ try: () => emitEvent(state, event), catch: error => toDriverError(error) })
}

function makeRunChannelStream(channel: RunChannel): Stream.Stream<AgentDriverEvent, AgentDriverError> {
  return Stream.unwrap(
    Effect.sync(() => {
      if (channel.consumerAttached)
        return Stream.fail(
          new AgentDriverError({
            code: 'invalid-state',
            message: 'ACP run events have a single application ingestor.',
          }),
        )
      channel.consumerAttached = true
      return Stream.fromQueue(channel.events).pipe(
        Stream.tap(event =>
          Effect.sync(() => {
            channel.pendingEvents = Math.max(0, channel.pendingEvents - 1)
            channel.pendingBytes = Math.max(0, channel.pendingBytes - jsonBytes(event))
          }),
        ),
        Stream.ensuring(
          Effect.sync(() => {
            channel.consumerAttached = false
          }),
        ),
      )
    }),
  )
}

function guardFrameSize(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let frameBytes = 0
  const guard = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const byte of chunk) {
        if (byte === 10) frameBytes = 0
        else if (++frameBytes > MAX_FRAME_BYTES) {
          controller.error(
            new AgentDriverError({ code: 'protocol-error', message: 'ACP frame exceeded the configured byte limit.' }),
          )
          return
        }
      }
      controller.enqueue(chunk)
    },
  })
  return input.pipeThrough(guard)
}

function recordReplay(state: AcpSessionState, event: AgentDriverEvent): void {
  const bytes = jsonBytes(event)
  if (state.replay.length >= MAX_REPLAY_EVENTS || state.replayBytes + bytes > MAX_REPLAY_BYTES) {
    throw new AgentDriverError({
      code: 'protocol-error',
      message: 'ACP session history replay exceeded its bounded buffer.',
    })
  }
  state.eventSequence += 1
  const cursor = `${REPLAY_CURSOR_PREFIX}${state.eventSequence}`
  state.replay.push({ cursor, event, bytes })
  state.replayBytes += bytes
}

function emitEvent(state: AcpSessionState, event: AgentDriverEvent): Promise<void> {
  if (state.closed)
    return Promise.reject(new AgentDriverError({ code: 'disconnected', message: 'ACP session is closed.' }))
  if (state.replaying) {
    try {
      recordReplay(state, event)
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(toDriverError(error))
    }
  }
  const activeRun = state.activeRun
  if (!activeRun) return Promise.resolve()
  const channel = activeRun.channel
  const bytes = jsonBytes(event)
  if (channel.pendingEvents >= MAX_EVENTS || channel.pendingBytes + bytes > MAX_EVENT_BYTES) {
    const error = new AgentDriverError({
      code: 'protocol-error',
      message: 'ACP event buffer exceeded its bounded capacity.',
    })
    return Effect.runPromise(failChannel(channel, error)).then(() => {
      state.poison(error)
      return Promise.reject(error)
    })
  }
  channel.pendingEvents += 1
  channel.pendingBytes += bytes
  return Effect.runPromise(Queue.offer(channel.events, event))
    .then(() => undefined)
    .catch(error => {
      const driverError = toDriverError(error, 'disconnected')
      return Effect.runPromise(failChannel(channel, driverError)).then(() => {
        state.poison(driverError)
        return Promise.reject(driverError)
      })
    })
}

function translateUpdate(update: SessionUpdate, state: AcpSessionState): ReadonlyArray<AgentDriverEvent> {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      if (update.content.type === 'text') {
        return [
          update.sessionUpdate === 'agent_message_chunk'
            ? { kind: 'textDelta', text: update.content.text }
            : { kind: 'reasoningDelta', text: update.content.text },
        ]
      }
      if (update.content.type === 'image') return [imageEvent(update.content)]
      return [
        {
          kind: 'nativeNotice',
          message: `ACP emitted unsupported ${update.content.type} message content.`,
        },
      ]
    }
    case 'user_message_chunk':
      return []
    case 'tool_call':
      return translateTool(update, true)
    case 'tool_call_update':
      return translateTool(update, false)
    case 'usage_update': {
      state.eventSequence += 1
      return [
        {
          kind: 'usageReported',
          semantics: 'cumulative',
          scope: 'session',
          revision: `acp-usage:${state.eventSequence}`,
          ...(update.cost ? { cost: update.cost.amount, currency: update.cost.currency } : {}),
        },
      ]
    }
    case 'plan':
      return [
        {
          kind: 'planUpdated',
          entries: update.entries.slice(0, 128).map(entry => ({
            content: entry.content.slice(0, 4096),
            status: entry.status === 'in_progress' ? 'inProgress' : entry.status,
          })),
        },
      ]
    case 'current_mode_update':
      if (state.modeState) state.modeState = { ...state.modeState, currentModeId: update.currentModeId }
      state.liveCapabilities = {
        ...state.liveCapabilities,
        ...sessionCapabilities({
          configOptions: state.configOptions,
          modes: state.modeState,
          models: state.modelState,
        }),
      }
      return [
        { kind: 'capabilitiesUpdated', capabilities: state.liveCapabilities },
        { kind: 'nativeNotice', message: `ACP mode changed to ${update.currentModeId}.` },
      ]
    case 'config_option_update':
      state.configOptions = update.configOptions
      state.liveCapabilities = {
        ...state.liveCapabilities,
        ...sessionCapabilities({
          configOptions: update.configOptions,
          modes: state.modeState,
          models: state.modelState,
        }),
      }
      return [{ kind: 'capabilitiesUpdated', capabilities: state.liveCapabilities }]
    case 'available_commands_update':
      state.liveCapabilities = {
        ...state.liveCapabilities,
        commands: promptCommands(update.availableCommands),
      }
      return [{ kind: 'capabilitiesUpdated', capabilities: state.liveCapabilities }]
    case 'session_info_update':
      return [{ kind: 'nativeNotice', message: 'ACP reported updated session information.' }]
  }
}

function optionsForSession(response: {
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null
  readonly modes?: AcpSessionModeState | null
  readonly models?: AcpSessionModelState | null
}): ReadonlyArray<SessionConfigOption> {
  return response.configOptions ?? []
}

function selectSessionOptions(
  client: ClientSideConnection,
  sessionId: string,
  context: AgentSessionContext,
  response: {
    readonly configOptions?: ReadonlyArray<SessionConfigOption> | null
    readonly modes?: AcpSessionModeState | null
    readonly models?: AcpSessionModelState | null
  },
): Effect.Effect<ReadonlyArray<SessionConfigOption>, AgentDriverError | UnsupportedAgentOperation> {
  return Effect.gen(function* () {
    let configOptions = optionsForSession(response)
    // The model goes first: an agent such as OpenCode offers different effort levels per model.
    if (context.modelId) {
      const nativeModel = response.models?.availableModels.find(model => model.modelId === context.modelId)
      const configModel = configOptions.find(
        option => option.category === 'model' && optionValues(option).some(item => item.value === context.modelId),
      )
      if (configModel) {
        const updated = yield* Effect.tryPromise({
          try: () =>
            client.setSessionConfigOption({
              sessionId: sessionId as never,
              configId: configModel.id,
              value: context.modelId as never,
            }),
          catch: error => toDriverError(error),
        })
        configOptions = updated.configOptions?.length ? updated.configOptions : configOptions
      } else if (nativeModel && typeof client.unstable_setSessionModel === 'function') {
        yield* Effect.tryPromise({
          try: () =>
            client.unstable_setSessionModel({ sessionId: sessionId as never, modelId: context.modelId as never }),
          catch: error => toDriverError(error),
        })
      } else {
        return yield* unsupported('openSession', 'Requested model is not present in the ACP session catalog.')
      }
    }
    if (context.modeId) {
      const configuredMode = configOptions.find(
        option =>
          SELECTABLE_MODE_CATEGORIES.includes(option.category ?? '') &&
          optionValues(option).some(item => item.value === context.modeId),
      )
      const nativeMode = response.modes?.availableModes.find(mode => mode.id === context.modeId)
      const modeOverridden =
        configuredMode !== undefined && Object.hasOwn(context.configValues ?? {}, configuredMode.id)
      if (modeOverridden) {
        // The explicit config value is applied below and takes precedence over the general mode selection.
      } else if (configuredMode) {
        const updated = yield* Effect.tryPromise({
          try: () =>
            client.setSessionConfigOption({
              sessionId: sessionId as never,
              configId: configuredMode.id,
              value: context.modeId as never,
            }),
          catch: error => toDriverError(error),
        })
        configOptions = updated.configOptions?.length ? updated.configOptions : configOptions
      } else if (nativeMode) {
        yield* Effect.tryPromise({
          try: () => client.setSessionMode({ sessionId: sessionId as never, modeId: context.modeId as never }),
          catch: error => toDriverError(error),
        })
      } else {
        return yield* unsupported('openSession', 'Requested mode is not present in the ACP session catalog.')
      }
    }
    for (const [configId, value] of Object.entries(context.configValues ?? {})) {
      if (HIDDEN_CONFIG_CATEGORIES.has(configOptions.find(option => option.id === configId)?.category ?? '')) {
        return yield* unsupported('openSession', 'Requested ACP configuration option is managed by access policy.')
      }
      if (configId === 'acp-session-mode') {
        if (!response.modes?.availableModes.some(mode => mode.id === value)) {
          return yield* unsupported('openSession', 'Requested ACP mode is not present in the session catalog.')
        }
        yield* Effect.tryPromise({
          try: () => client.setSessionMode({ sessionId: sessionId as never, modeId: value as never }),
          catch: error => toDriverError(error),
        })
        continue
      }
      const option = configOptions.find(candidate => candidate.id === configId)
      if (!option || !optionValues(option).some(choice => choice.value === value)) {
        return yield* unsupported('openSession', 'Requested ACP configuration is not present in the session catalog.')
      }
      const updated = yield* Effect.tryPromise({
        try: () => client.setSessionConfigOption({ sessionId: sessionId as never, configId, value: value as never }),
        catch: error => toDriverError(error),
      })
      if (updated.configOptions?.length) configOptions = updated.configOptions
    }
    return configOptions
  })
}

function mapPromptContent(
  input: AgentTurnInput,
  images: boolean,
): Effect.Effect<Array<ContentBlock>, UnsupportedAgentOperation> {
  if (input.attachmentIds.length > 0) {
    return Effect.fail(
      unsupported('submit', 'ACP attachments need a content resolver; attachment IDs cannot be sent as text.'),
    )
  }
  if (input.messages.length !== 1 || input.messages[0]?.role !== 'user') {
    return Effect.fail(
      unsupported(
        'submit',
        'ACP accepts one user message per prompt; conversation history must remain in the loaded native session.',
      ),
    )
  }
  if (!images && input.attachments?.some(item => item.mediaType.startsWith('image/')))
    return Effect.fail(unsupported('submit', 'This ACP agent did not advertise image input.'))
  const content: ContentBlock[] = [{ type: 'text', text: input.messages[0].content }]
  for (const attachment of input.attachments ?? []) {
    if (attachment.mediaType.startsWith('image/'))
      content.push({ type: 'image', mimeType: attachment.mediaType, data: attachment.content })
    else content.push({ type: 'text', text: attachmentText(attachment) })
  }
  return Effect.succeed(content)
}

function permissionOptions(options: ReadonlyArray<PermissionOption>) {
  return options.map(option => {
    const persistent = option.kind === 'allow_always' || option.kind === 'reject_always'
    let kind: 'allow' | 'deny' | 'allowAlways' | 'other' = 'other'
    let decision: AgentRequestDecision | undefined
    if (option.kind === 'allow_once' || option.kind === 'allow_always') {
      kind = option.kind === 'allow_always' ? 'allowAlways' : 'allow'
      decision = { kind: 'approve', optionId: option.optionId }
    } else if (option.kind === 'reject_once' || option.kind === 'reject_always') {
      kind = 'deny'
      decision = { kind: 'deny', optionId: option.optionId }
    }
    return {
      id: option.optionId,
      label: option.name,
      scope: persistent ? ('session' as const) : ('once' as const),
      kind,
      ...(decision ? { decision } : {}),
    }
  })
}

function choosePermissionResponse(
  pending: PendingPermission,
  decision: AgentRequestDecision,
): RequestPermissionResponse | undefined {
  if (decision.kind === 'cancel') return { outcome: { outcome: 'cancelled' } }
  if (decision.kind === 'deny') {
    const selected = decision.optionId
      ? pending.options.find(option => option.optionId === decision.optionId)
      : pending.options.find(option => option.kind === 'reject_once')
    if (!selected) return { outcome: { outcome: 'cancelled' } }
    if (selected.kind === 'reject_once' || selected.kind === 'reject_always')
      return { outcome: { outcome: 'selected', optionId: selected.optionId } }
    return undefined
  }
  if (decision.kind !== 'approve') return undefined
  const selected = decision.optionId
    ? pending.options.find(option => option.optionId === decision.optionId)
    : pending.options.find(option => option.kind === 'allow_once')
  if (!selected || (selected.kind !== 'allow_once' && selected.kind !== 'allow_always')) return undefined
  return { outcome: { outcome: 'selected', optionId: selected.optionId } }
}

function questionFields(form: Schema.Schema.Type<typeof elicitationFormSchema>, message: string) {
  const properties = Object.entries(form.properties ?? {})
  if (properties.length === 0 || properties.length > 64) return undefined
  if (properties.some(([, property]) => property.type === 'array' && !property.items?.enum)) return undefined
  return properties.map(([id, property], index) => {
    const isMultiSelect = property.type === 'array'
    const values = isMultiSelect ? (property.items?.enum ?? []) : (property.enum ?? [])
    const booleanOptions = property.type === 'boolean' ? ['true', 'false'] : []
    const options = (values.length > 0 ? values.map(String) : booleanOptions).slice(0, 64).map(value => ({
      id: value,
      label: property.type === 'boolean' ? (value === 'true' ? 'Yes' : 'No') : value,
      ...(property.description ? { description: property.description } : {}),
    }))
    return {
      id,
      prompt: property.description ?? message,
      header: property.title ?? `Question ${index + 1}`,
      allowCustomAnswer: options.length === 0,
      isSecret: property.format === 'password',
      multiSelect: isMultiSelect,
      options,
    }
  })
}

function elicitationResponse(
  decision: AgentRequestDecision,
  questions: NonNullable<ReturnType<typeof questionFields>>,
  form: Schema.Schema.Type<typeof elicitationFormSchema>,
): CreateElicitationResponse | undefined {
  if (decision.kind === 'cancel') return { action: 'cancel' }
  if (decision.kind === 'deny') return { action: 'decline' }
  if (decision.kind !== 'answers') return undefined
  const properties = form.properties ?? {}
  const required = new Set(form.required ?? [])
  if (Object.keys(decision.answers).some(key => !(key in properties))) return undefined
  if (Array.from(required).some(key => !(key in decision.answers))) return undefined
  const content: Record<string, string | number | boolean | ReadonlyArray<string>> = {}
  for (const question of questions) {
    const answer = decision.answers[question.id]
    if (answer === undefined) continue
    const property = properties[question.id]
    if (!property) return undefined
    if (property.type === 'array') {
      if (!Array.isArray(answer)) return undefined
      const choices = property.items?.enum
      if (choices && answer.some(value => !choices.includes(value))) return undefined
      content[question.id] = answer
      continue
    }
    if (typeof answer !== 'string') return undefined
    if (property.enum && !property.enum.some(value => String(value) === answer)) return undefined
    if (property.type === 'boolean') {
      if (answer !== 'true' && answer !== 'false') return undefined
      content[question.id] = answer === 'true'
    } else if (property.type === 'number' || property.type === 'integer') {
      const value = Number(answer)
      if (!Number.isFinite(value) || (property.type === 'integer' && !Number.isInteger(value))) return undefined
      content[question.id] = value
    } else {
      content[question.id] = answer
    }
  }
  return { action: 'accept', content }
}

const READ_TOOL_KINDS: ReadonlyArray<string> = ['read', 'search', 'think']
const EDIT_TOOL_KINDS: ReadonlyArray<string> = ['edit', 'delete', 'move']

/**
 * The access mode applied to an ACP permission request: reads never ask, Supervised asks for the
 * rest, Auto-accept edits allows file changes, Full access allows everything. Approval picks the one-time option;
 * a persistent "always" choice is never made for the user, so its absence falls back to asking.
 */
export function automaticPermission(
  accessMode: AgentAccessMode,
  params: Pick<RequestPermissionRequest, 'options' | 'toolCall'>,
): RequestPermissionResponse | undefined {
  const kind = params.toolCall.kind ?? 'other'
  const allowed =
    READ_TOOL_KINDS.includes(kind) ||
    accessMode === 'full-access' ||
    ((accessMode === 'auto-accept-edits' || accessMode === 'auto') && EDIT_TOOL_KINDS.includes(kind))
  const once = allowed ? params.options.find(option => option.kind === 'allow_once') : undefined
  return once ? { outcome: { outcome: 'selected', optionId: once.optionId } } : undefined
}

function makeClient(stateRef: AcpStateRef): Client {
  return {
    requestPermission: async params => {
      const state = stateRef.current
      const run = state?.activeRun
      if (!state || !run || state.closed || !state.acceptRequests || params.sessionId !== state.nativeSessionId) {
        return { outcome: { outcome: 'cancelled' } }
      }
      const automatic = automaticPermission(state.context.accessMode ?? DEFAULT_AGENT_ACCESS_MODE, params)
      if (automatic) return automatic
      const id = `acp-request-${++state.requestSequence}`
      let resolve!: (response: RequestPermissionResponse) => void
      const response = new Promise<RequestPermissionResponse>(res => {
        resolve = res
      })
      const pending: PendingPermission = {
        kind: 'permission',
        id,
        runId: run.id,
        generation: state.context.generation,
        nativeSessionId: state.nativeSessionId,
        options: params.options,
        resolve,
        answered: false,
      }
      state.permissions.set(id, pending)
      try {
        await emitEvent(state, {
          kind: 'requestPending',
          request: {
            requestId: id,
            runId: run.id,
            sessionId: state.context.sessionId,
            generation: state.context.generation,
            kind: 'approval',
            prompt: params.toolCall.title ?? 'The agent requests permission to run a tool.',
            options: permissionOptions(params.options),
            questions: [],
            toolCallId: params.toolCall.toolCallId,
            tool: toolMetadata(params.toolCall),
          },
        })
      } catch {
        state.permissions.delete(id)
        return { outcome: { outcome: 'cancelled' } }
      }
      return response.finally(() => {
        state.permissions.delete(id)
      })
    },
    extMethod: async (method, params) => {
      if (method !== 'elicitation/create' && method !== 'session/elicitation' && method !== '_session/elicitation') {
        throw RequestError.methodNotFound(method)
      }
      const decoded = Schema.decodeUnknownOption(elicitationRequestSchema)(params)
      if (decoded._tag === 'None' || decoded.value.mode !== 'form' || decoded.value.requestedSchema === undefined)
        return { action: 'decline' }
      const form = Schema.decodeUnknownOption(elicitationFormSchema)(decoded.value.requestedSchema)
      if (form._tag === 'None') return { action: 'decline' }
      const questions = questionFields(form.value, decoded.value.message)
      if (!questions) return { action: 'decline' }
      const state = stateRef.current
      const run = state?.activeRun
      if (
        !state ||
        !run ||
        state.closed ||
        !state.acceptRequests ||
        (decoded.value.sessionId != null && decoded.value.sessionId !== state.nativeSessionId)
      ) {
        return { action: 'cancel' }
      }
      const id = `acp-request-${++state.requestSequence}`
      let resolve!: (response: CreateElicitationResponse) => void
      const response = new Promise<CreateElicitationResponse>(res => {
        resolve = res
      })
      const pending: PendingQuestion = {
        kind: 'question',
        id,
        runId: run.id,
        generation: state.context.generation,
        nativeSessionId: state.nativeSessionId,
        questions,
        form: form.value,
        resolve,
        answered: false,
      }
      state.permissions.set(id, pending)
      try {
        await emitEvent(state, {
          kind: 'requestPending',
          request: {
            requestId: id,
            runId: run.id,
            sessionId: state.context.sessionId,
            generation: state.context.generation,
            kind: 'question',
            prompt: decoded.value.message,
            cancelDecision: { kind: 'cancel' },
            questions,
            ...(decoded.value.toolCallId ? { toolCallId: decoded.value.toolCallId } : {}),
            ...(decoded.value.requestId ? { nativeRequestId: decoded.value.requestId } : {}),
          },
        })
      } catch {
        state.permissions.delete(id)
        return { action: 'cancel' }
      }
      return response.finally(() => {
        state.permissions.delete(id)
      })
    },
    sessionUpdate: async (notification: SessionNotification) => {
      if (stateRef.probes?.has(notification.sessionId)) {
        const probe = stateRef.promptCatalogProbe
        if (probe && notification.update.sessionUpdate === 'available_commands_update') {
          const commands = promptCommands(notification.update.availableCommands)
          probe.earlyCommands.set(notification.sessionId, commands)
          probe.waiters.get(notification.sessionId)?.(commands)
        }
        return
      }
      if (stateRef.promptCatalogProbe) {
        if (notification.update.sessionUpdate === 'available_commands_update') {
          stateRef.promptCatalogProbe.earlyCommands.set(
            notification.sessionId,
            promptCommands(notification.update.availableCommands),
          )
        }
        return
      }
      const state = stateRef.current
      if (!state || state.closed || notification.sessionId !== state.nativeSessionId) {
        throw new Error('ACP sent an update for an unrelated native session.')
      }
      const updates = translateUpdate(notification.update, state)
      for (const event of updates) await emitEvent(state, event)
    },
  }
}

function failPendingPermissions(state: AcpSessionState): void {
  for (const [id, pending] of state.permissions) {
    if (!pending.answered) {
      pending.answered = true
      if (pending.kind === 'permission') pending.resolve({ outcome: { outcome: 'cancelled' } })
      else pending.resolve({ action: 'cancel' })
    }
    state.permissions.delete(id)
  }
}

function makeSessionState(
  context: AgentSessionContext,
  nativeSessionId: string,
  loadSessionSupported: boolean,
  browserMcpUnavailable: boolean,
  replaying: boolean,
): AcpSessionState {
  return {
    context,
    nativeSessionId,
    identity: { nativeSessionId, generation: context.generation },
    browserMcpUnavailable,
    queues: new Map(),
    completedRuns: [],
    permissions: new Map(),
    replay: [],
    replayBytes: 0,
    replaying,
    requestSequence: 0,
    eventSequence: 0,
    liveCapabilities: connectionCapabilities(loadSessionSupported),
    configOptions: [],
    acceptRequests: true,
    closed: false,
    poison: () => undefined,
  }
}

function retainCompletedRun(state: AcpSessionState, runId: AgentRunId): void {
  if (!state.completedRuns.includes(runId)) state.completedRuns.push(runId)
  while (state.completedRuns.length > MAX_COMPLETED_CHANNELS) {
    const oldest = state.completedRuns.shift()
    if (oldest) state.queues.delete(oldest)
  }
}

function releaseActiveRun(state: AcpSessionState, active: ActiveRun): Effect.Effect<void> {
  return Effect.sync(() => {
    if (state.activeRun === active) state.activeRun = undefined
    failPendingPermissions(state)
    retainCompletedRun(state, active.id)
    active.complete()
  })
}

function closeAcpConnection(connection: AcpConnectionState, deadlineMs: number): Effect.Effect<void, AgentDriverError> {
  return Effect.gen(function* () {
    if (connection.transportClosed) return
    connection.closed = true
    const session = connection.session
    if (session) {
      session.acceptRequests = false
      failPendingPermissions(session)
      const active = session.activeRun
      if (active) {
        active.cancelRequested = true
        const result = yield* Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => connection.connection.cancel({ sessionId: session.nativeSessionId as never }),
            catch: error => toDriverError(error),
          }).pipe(Effect.ignore)
          yield* Effect.promise(() => active.completion)
        }).pipe(Effect.interruptible, Effect.timeoutOption(`${Math.max(0, deadlineMs)} millis`))
        if (result._tag === 'None') {
          yield* failChannel(
            active.channel,
            new AgentDriverError({ code: 'timeout', message: 'ACP prompt did not drain before connection close.' }),
          )
        }
      }
      session.closed = true
    }
    connection.transportClosed = true
    yield* connection.transport.close(deadlineMs).pipe(Effect.mapError(error => toDriverError(error, 'disconnected')))
  })
}

function sessionInterface(
  client: ClientSideConnection,
  connection: AcpConnectionState,
  state: AcpSessionState,
): AgentDriverSession {
  const errorStream = (code: ConstructorParameters<typeof AgentDriverError>[0]['code'], message: string) =>
    Stream.fail(new AgentDriverError({ code, message }))
  return {
    identity: state.identity,
    get capabilities() {
      return state.liveCapabilities
    },
    events: (runId, afterCursor) => {
      if (afterCursor !== undefined) {
        return errorStream(
          'outcome-uncertain',
          'ACP cannot resume a live turn from an event cursor; use the application event store.',
        )
      }
      return Stream.unwrap(
        Effect.gen(function* () {
          let channel = state.queues.get(runId)
          if (!channel) {
            const preparedCount = Array.from(state.queues.values()).filter(candidate => !candidate.submitted).length
            if (preparedCount >= MAX_PREPARED_CHANNELS) {
              return Stream.fail(
                new AgentDriverError({
                  code: 'invalid-state',
                  message: 'ACP prepared event channel limit has been reached.',
                }),
              )
            }
            channel = yield* emptyEventChannel(runId)
            state.queues.set(runId, channel)
          }
          const runEvents = makeRunChannelStream(channel)
          return state.browserMcpUnavailable
            ? Stream.concat(
                Stream.make({
                  kind: 'nativeNotice' as const,
                  message:
                    'Embedded browser tools are unavailable because this ACP agent did not advertise HTTP MCP support.',
                }),
                runEvents,
              )
            : runEvents
        }),
      )
    },
    submit: input => {
      let claimedRun: ActiveRun | undefined
      let promptPromise: Promise<Awaited<ReturnType<ClientSideConnection['prompt']>>> | undefined
      let promptSettled = false
      let submitExited = false
      let terminalRecorded = false
      const finishAfterPrompt = (
        result?: Awaited<ReturnType<ClientSideConnection['prompt']>>,
        promptError?: unknown,
      ) => {
        const active = claimedRun
        if (!active) return
        const finalize = Effect.gen(function* () {
          if (!terminalRecorded) {
            if (result?.stopReason === 'cancelled') {
              yield* emitEventEffect(state, { kind: 'turnInterrupted' }).pipe(Effect.ignore)
              yield* endChannel(active.channel)
            } else {
              const error = toDriverError(
                promptError ?? new Error('ACP submit fiber ended before native prompt completion.'),
                'outcome-uncertain',
              )
              yield* failChannel(active.channel, error)
            }
          }
          yield* releaseActiveRun(state, active)
        })
        void Effect.runPromise(finalize).catch(() => undefined)
      }
      const submitEffect = Effect.gen(function* () {
        if (state.closed || connection.closed)
          return yield* new AgentDriverError({ code: 'disconnected', message: 'ACP connection is closed.' })
        if (input.runId.length === 0)
          return yield* new AgentDriverError({ code: 'invalid-state', message: 'Run identity is required.' })
        if (state.activeRun)
          return yield* new AgentDriverError({
            code: 'invalid-state',
            message: 'This ACP session already has an active prompt.',
          })
        let channel = state.queues.get(input.runId)
        if (channel?.submitted)
          return yield* new AgentDriverError({
            code: 'invalid-state',
            message: 'An ACP Run ID cannot be submitted twice.',
          })
        const content = yield* mapPromptContent(input, state.liveCapabilities.promptContent?.images === true)
        if (!channel) channel = yield* emptyEventChannel(input.runId)
        channel.submitted = true
        const completed = yield* Effect.sync(() => {
          let complete!: () => void
          const completion = new Promise<void>(resolve => {
            complete = resolve
          })
          return { completion, complete }
        })
        const active: ActiveRun = {
          id: input.runId,
          channel,
          completion: completed.completion,
          complete: completed.complete,
          cancelRequested: false,
        }
        claimedRun = active
        state.activeRun = active
        state.queues.set(input.runId, channel)
        yield* emitEventEffect(state, { kind: 'turnStarted' })
        promptPromise = client.prompt({ sessionId: state.nativeSessionId as never, prompt: content })
        void promptPromise.then(
          result => {
            promptSettled = true
            if (submitExited) finishAfterPrompt(result)
          },
          error => {
            promptSettled = true
            if (submitExited) finishAfterPrompt(undefined, error)
          },
        )
        const result = yield* Effect.tryPromise({
          try: () => promptPromise as Promise<Awaited<ReturnType<ClientSideConnection['prompt']>>>,
          catch: error => toDriverError(error),
        }).pipe(
          Effect.tapError(error =>
            Effect.gen(function* () {
              terminalRecorded = true
              yield* failChannel(channel, error)
            }),
          ),
        )

        if (result.usage) {
          yield* emitEventEffect(state, {
            kind: 'usageReported',
            semantics: 'final',
            scope: 'run',
            revision: `acp-final:${state.eventSequence + 1}`,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          })
        }
        if (result.stopReason === 'end_turn') {
          yield* emitEventEffect(state, { kind: 'turnCompleted' })
        } else if (result.stopReason === 'cancelled') {
          yield* emitEventEffect(state, { kind: 'turnInterrupted' })
          terminalRecorded = true
        } else {
          const message = `ACP prompt stopped with ${result.stopReason}; this is not a successful completion.`
          yield* emitEventEffect(state, { kind: 'turnFailed', message })
          const error = new AgentDriverError({ code: 'outcome-uncertain', message })
          yield* failChannel(channel, error)
          terminalRecorded = true
          return yield* new AgentDriverError({ code: 'outcome-uncertain', message })
        }
        terminalRecorded = true
        yield* endChannel(channel)
        return {
          nativeSessionId: state.nativeSessionId,
          generation: state.context.generation,
        }
      })
      return submitEffect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            submitExited = true
            if (!claimedRun) return
            failPendingPermissions(state)
            if (!promptPromise || promptSettled) {
              finishAfterPrompt()
            } else {
              void client.cancel({ sessionId: state.nativeSessionId as never }).catch(() => undefined)
            }
          }),
        ),
      )
    },
    interrupt: (runId, expectedNativeTurnId) =>
      Effect.gen(function* () {
        const active = state.activeRun
        if (!active || active.id !== runId || state.closed) {
          return yield* new AgentDriverError({
            code: 'invalid-state',
            message: 'There is no active ACP prompt for this Run.',
          })
        }
        if (expectedNativeTurnId !== undefined && active.nativeTurnId !== expectedNativeTurnId) {
          return yield* new AgentDriverError({
            code: 'invalid-state',
            message: 'The expected ACP native turn is stale.',
          })
        }
        active.cancelRequested = true
        failPendingPermissions(state)
        yield* Effect.tryPromise({
          try: () => client.cancel({ sessionId: state.nativeSessionId as never }),
          catch: error => toDriverError(error),
        })
        return { acknowledged: true, termination: 'unknown' } satisfies InterruptAcknowledgement
      }),
    steer: () => Effect.fail(unsupported('steer', 'ACP has no standard operation for steering an active prompt.')),
    respond: (runId, requestId, generation, decision) =>
      Effect.gen(function* () {
        const pending = state.permissions.get(requestId)
        if (
          !pending ||
          pending.answered ||
          pending.runId !== runId ||
          pending.generation !== generation ||
          generation !== state.context.generation ||
          pending.nativeSessionId !== state.nativeSessionId ||
          state.activeRun?.id !== runId
        ) {
          return yield* new AgentDriverError({
            code: 'invalid-state',
            message: 'ACP permission request is stale or belongs to another Run.',
          })
        }
        if (
          pending.kind === 'question' &&
          decision.kind !== 'answers' &&
          decision.kind !== 'cancel' &&
          decision.kind !== 'deny'
        ) {
          return yield* new AgentDriverError({
            code: 'invalid-state',
            message: 'ACP elicitation needs answers, a denial, or a cancellation.',
          })
        }
        if (pending.kind === 'permission') {
          const response = choosePermissionResponse(pending, decision)
          if (!response)
            return yield* new AgentDriverError({
              code: 'invalid-state',
              message: 'Decision does not match a current ACP permission option.',
            })
          pending.answered = true
          pending.resolve(response)
        } else {
          const response = elicitationResponse(decision, pending.questions, pending.form)
          if (!response)
            return yield* new AgentDriverError({
              code: 'invalid-state',
              message: 'Answers do not match the current ACP elicitation schema.',
            })
          pending.answered = true
          pending.resolve(response)
        }
        state.permissions.delete(requestId)
        yield* emitEventEffect(state, { kind: 'requestResolved', requestId, decision })
        return { outcome: 'accepted', nativeConfirmation: 'unconfirmed' } satisfies DeliveryOutcome
      }),
    reconcile: () =>
      state.liveCapabilities.reconcile.support === 'supported'
        ? Stream.fromIterable(
            state.replay.map(
              record => ({ cursor: record.cursor, replay: true, event: record.event }) satisfies AgentReconcileEvent,
            ),
          )
        : Stream.fail(unsupported('reconcile', 'This ACP agent did not advertise session/load.')),
  }
}

function createConnection(
  options: AgentDriverConnectOptions,
  transport: JsonRpcTransport,
  clientVersion: string,
): Effect.Effect<AgentDriverConnection, AgentDriverError, Scope.Scope> {
  return Effect.gen(function* () {
    const effectContext = yield* Effect.context<never>()
    let transportClosed = false
    yield* Effect.addFinalizer(() => {
      if (transportClosed) return Effect.void
      transportClosed = true
      return transport.close(1000).pipe(Effect.ignore)
    })
    const stateRef: AcpStateRef = {}
    const readable = yield* Stream.toReadableStreamEffect(transport.input, { strategy: { highWaterMark: 32 } })
    const writable = new WritableStream<Uint8Array>({
      write: bytes => {
        if (bytes.byteLength > 8 * MAX_FRAME_BYTES) {
          throw new AgentDriverError({
            code: 'protocol-error',
            message: 'ACP outgoing frame exceeded the configured byte limit.',
          })
        }
        return Effect.runPromiseWith(effectContext)(transport.write(bytes)).catch(error => {
          throw toDriverError(error, 'disconnected')
        })
      },
    })
    const wire = ndJsonStream(writable, guardFrameSize(readable) as Parameters<typeof ndJsonStream>[1])
    const client = new ClientSideConnection(() => makeClient(stateRef), wire)
    const initialized = yield* Effect.tryPromise({
      try: () =>
        client.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'watchtower', version: clientVersion },
          clientCapabilities: { elicitation: { form: {} } } as never,
        }),
      catch: error => toDriverError(error, 'driver-unavailable'),
    })
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      return yield* new AgentDriverError({
        code: 'protocol-error',
        message: 'ACP peer negotiated an unsupported protocol version.',
      })
    }
    const loadSessionSupported = initialized.agentCapabilities?.loadSession === true
    const browserMcpHttpSupported = initialized.agentCapabilities?.mcpCapabilities?.http === true
    const initializeStates = initializeCatalog(initialized._meta)
    const connectionState: AcpConnectionState = {
      identity: {
        id: options.connectionId,
        driverId: 'acp',
        protocolVersion: String(initialized.protocolVersion),
        authentication: 'unknown',
      },
      connection: client,
      transport,
      loadSessionSupported,
      browserMcpHttpSupported,
      initializeModels: initializeStates.models ?? undefined,
      initializeModes: initializeStates.modes ?? undefined,
      closed: false,
      get transportClosed() {
        return transportClosed
      },
      set transportClosed(value: boolean) {
        transportClosed = value
      },
    }
    const poisonConnection = (session: AcpSessionState, error: AgentDriverError) => {
      if (connectionState.closed) return
      connectionState.closed = true
      session.closed = true
      session.acceptRequests = false
      failPendingPermissions(session)
      const active = session.activeRun
      if (active) void Effect.runPromise(failChannel(active.channel, error)).catch(() => undefined)
      if (transportClosed) return
      const forceClose = () => {
        if (transportClosed) return
        transportClosed = true
        void Effect.runPromise(transport.close(1000).pipe(Effect.ignore)).finally(() => {
          if (active) {
            if (session.activeRun === active) session.activeRun = undefined
            retainCompletedRun(session, active.id)
            active.complete()
          }
        })
      }
      void Promise.race([
        client.cancel({ sessionId: session.nativeSessionId as never }).catch(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, 250)),
      ]).finally(forceClose)
    }
    client.signal.addEventListener('abort', () => {
      connectionState.closed = true
      const session = connectionState.session
      if (session) {
        session.closed = true
        failPendingPermissions(session)
        if (session.activeRun) {
          const error = new AgentDriverError({
            code: 'disconnected',
            message: 'ACP connection closed during a prompt.',
          })
          void Effect.runPromise(failChannel(session.activeRun.channel, error)).finally(() => {
            const active = session.activeRun
            if (active) {
              session.activeRun = undefined
              retainCompletedRun(session, active.id)
              active.complete()
            }
          })
        }
      }
    })
    yield* Effect.addFinalizer(() => closeAcpConnection(connectionState, 1000).pipe(Effect.ignore))

    const open = (context: AgentSessionContext, native?: NativeSessionReference) =>
      Effect.gen(function* () {
        if (connectionState.closed)
          return yield* new AgentDriverError({ code: 'disconnected', message: 'ACP connection is closed.' })
        if (connectionState.session)
          return yield* new AgentDriverError({
            code: 'invalid-state',
            message: 'An ACP connection owns one native session at a time.',
          })
        if (
          context.generation < 1 ||
          !Number.isInteger(context.generation) ||
          context.workspacePath.trim().length === 0
        ) {
          return yield* new AgentDriverError({
            code: 'invalid-state',
            message: 'ACP session requires a valid generation and resolved workspace path.',
          })
        }
        if (native && !connectionState.loadSessionSupported) {
          return yield* unsupported('loadSession', 'The ACP agent did not advertise session/load.')
        }
        const restore = native !== undefined
        if (native && (native.nativeSessionId.trim().length === 0 || native.generation !== context.generation)) {
          return yield* new AgentDriverError({
            code: 'invalid-state',
            message: 'ACP load requires the exact native session and current generation.',
          })
        }
        let state = native
          ? makeSessionState(
              context,
              native.nativeSessionId,
              connectionState.loadSessionSupported,
              Boolean(context.browserMcp && !connectionState.browserMcpHttpSupported && !context.browserMcp.stdio),
              true,
            )
          : undefined
        if (state) {
          state.poison = error => poisonConnection(state as AcpSessionState, error)
          stateRef.current = state
          connectionState.session = state
        }
        const response = yield* Effect.tryPromise({
          try: async () => {
            if (restore) {
              if (typeof client.loadSession !== 'function')
                throw new AgentDriverError({
                  code: 'protocol-error',
                  message: 'The negotiated ACP session/load method is unavailable.',
                })
              const loaded = await client.loadSession({
                sessionId: native.nativeSessionId as never,
                cwd: context.workspacePath,
                mcpServers: sessionMcpServers(context, connectionState.browserMcpHttpSupported),
              })
              return { ...loaded, sessionId: native.nativeSessionId }
            }
            return client.newSession({
              cwd: context.workspacePath,
              mcpServers: sessionMcpServers(context, connectionState.browserMcpHttpSupported),
            })
          },
          catch: error => toDriverError(error),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (state) state.replaying = false
            }),
          ),
          Effect.tapError(() => {
            if (state) {
              state.closed = true
              stateRef.current = undefined
              connectionState.session = undefined
            }
            return Effect.void
          }),
        )
        const catalogResponse = {
          ...response,
          models: response.models ?? connectionState.initializeModels,
          modes: response.modes ?? connectionState.initializeModes,
        }
        if (native && response.sessionId !== native.nativeSessionId) {
          return yield* new AgentDriverError({
            code: 'protocol-error',
            message: 'ACP loaded a different native session identity.',
          })
        }
        state ??= makeSessionState(
          context,
          response.sessionId,
          connectionState.loadSessionSupported,
          Boolean(context.browserMcp && !connectionState.browserMcpHttpSupported && !context.browserMcp.stdio),
          false,
        )
        state.liveCapabilities = {
          ...state.liveCapabilities,
          promptContent: { images: initialized.agentCapabilities?.promptCapabilities?.image === true, files: true },
        }
        state.poison = error => poisonConnection(state as AcpSessionState, error)
        state.replaying = false
        state.liveCapabilities = { ...state.liveCapabilities, ...sessionCapabilities(catalogResponse) }
        state.configOptions = catalogResponse.configOptions ?? []
        state.modeState = catalogResponse.modes ?? undefined
        state.modelState = catalogResponse.models ?? undefined
        stateRef.current = state
        connectionState.session = state
        const attachedState = state
        const selectedConfigOptions = yield* selectSessionOptions(
          client,
          response.sessionId,
          context,
          catalogResponse,
        ).pipe(
          Effect.tapError(error =>
            Effect.gen(function* () {
              attachedState.closed = true
              stateRef.current = undefined
              connectionState.session = undefined
              yield* closeAcpConnection(connectionState, 1000).pipe(Effect.ignore)
              if (error instanceof UnsupportedAgentOperation) return
            }),
          ),
        )
        state.configOptions = selectedConfigOptions
        if (context.modeId && state.modeState?.availableModes.some(mode => mode.id === context.modeId)) {
          state.modeState = { ...state.modeState, currentModeId: context.modeId }
        }
        for (const [configId, value] of Object.entries(context.configValues ?? {})) {
          if (configId === 'acp-session-mode' && state.modeState) {
            state.modeState = { ...state.modeState, currentModeId: value }
          }
          const selectedOption = state.configOptions.find(option => option.id === configId)
          if (selectedOption?.category === 'mode' && state.modeState?.availableModes.some(mode => mode.id === value)) {
            state.modeState = { ...state.modeState, currentModeId: value }
          }
          state.configOptions = state.configOptions.map(option =>
            option.id === configId ? { ...option, currentValue: value } : option,
          )
        }
        state.liveCapabilities = {
          ...state.liveCapabilities,
          ...sessionCapabilities({
            configOptions: state.configOptions,
            modes: state.modeState,
            models: state.modelState,
          }),
        }
        return sessionInterface(client, connectionState, state)
      })

    return {
      identity: connectionState.identity,
      discover: () =>
        Effect.succeed({
          ...connectionCapabilities(
            connectionState.loadSessionSupported,
            initialized.agentCapabilities?.promptCapabilities?.image === true,
          ),
          ...sessionCapabilities(initializeStates),
        }),
      discoverPromptCatalog: workspacePath =>
        Effect.gen(function* () {
          if (connectionState.closed || connectionState.session)
            return yield* new AgentDriverError({
              code: 'invalid-state',
              message: 'ACP prompt catalogs are discovered only on an idle connection.',
            })
          const probe = {
            earlyCommands: new Map<string, AgentPromptCatalog['commands']>(),
            waiters: new Map<string, (commands: AgentPromptCatalog['commands']) => void>(),
          }
          stateRef.promptCatalogProbe = probe
          const response = yield* Effect.tryPromise({
            try: () => client.newSession({ cwd: workspacePath, mcpServers: [] }),
            catch: error => toDriverError(error),
          })
          ;(stateRef.probes ??= new Set()).add(response.sessionId)
          const discovered = probe.earlyCommands.get(response.sessionId)
          if (discovered) return { skills: [], skillsComplete: false, commands: discovered }
          const commands = yield* Effect.tryPromise({
            try: () =>
              new Promise<AgentPromptCatalog['commands']>(resolve => {
                probe.waiters.set(response.sessionId, resolve)
                const commands = probe.earlyCommands.get(response.sessionId)
                if (commands) resolve(commands)
              }),
            catch: error => toDriverError(error),
          }).pipe(
            Effect.timeoutOption('3 seconds'),
            Effect.map(result => (Option.isSome(result) ? result.value : [])),
          )
          return { skills: [], skillsComplete: false, commands }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              stateRef.promptCatalogProbe = undefined
            }),
          ),
        ),
      openSession: context => open(context),
      probeCatalog: () =>
        Effect.gen(function* () {
          if (connectionState.closed || connectionState.session)
            return yield* new AgentDriverError({
              code: 'invalid-state',
              message: 'ACP catalogs are probed only on an idle connection.',
            })
          const response = yield* Effect.tryPromise({
            try: () => client.newSession({ cwd: tmpdir(), mcpServers: [] }),
            catch: error => toDriverError(error),
          })
          ;(stateRef.probes ??= new Set()).add(response.sessionId)
          const capabilities = sessionCapabilities({
            ...response,
            models: response.models ?? connectionState.initializeModels,
            modes: response.modes ?? connectionState.initializeModes,
          })
          const configOptions = response.configOptions ?? []
          // The probe switches models by option id, so the gate is on the id itself: `category` is an optional
          // protocol hint, while OpenCode publishes its model option under the fixed id `model`.
          const modelOptionId = configOptions.find(option => option.id === 'model')?.id
          const modelEffortsArePerModel =
            declaredEfforts(configOptions).length === 0 && modelOptionId !== undefined && capabilities.models.length > 0
          if (!modelEffortsArePerModel) return capabilities
          const found = new Map<string, ReadonlyArray<DeclaredEffort>>()
          yield* probeModelEfforts(
            client,
            modelOptionId,
            capabilities.models.map(model => model.id),
            sessionId => (stateRef.probes ??= new Set()).add(sessionId),
            found,
          ).pipe(Effect.timeoutOption(MODEL_EFFORT_PROBE_DEADLINE), Effect.ignore)
          if (found.size === 0) return capabilities
          return {
            ...capabilities,
            models: capabilities.models.map(model => {
              const efforts = found.get(model.id)
              return efforts === undefined ? model : { ...model, modes: efforts }
            }),
          }
        }),
      loadSession: (context, native) => open(context, native),
      close: deadlineMs => closeAcpConnection(connectionState, deadlineMs),
    } satisfies AgentDriverConnection
  })
}

export function makeAcpDriver(dependencies: AcpDriverDependencies): AgentDriver['Service'] {
  return AgentDriver.of({
    driverId: 'acp',
    accessModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'],
    connect: options =>
      dependencies.transportFactory(options).pipe(
        Effect.mapError(error =>
          error instanceof AgentDriverError ? error : toDriverError(error, 'driver-unavailable'),
        ),
        Effect.flatMap(transport => createConnection(options, transport, dependencies.clientVersion ?? '0.0.0')),
      ),
  })
}

function defaultTransportFactory(
  spawner: Context.Service.Shape<typeof ChildProcessSpawner.ChildProcessSpawner>,
  scrubEnvironment: ReadonlyArray<string>,
  runtimeExecutable?: string,
): AcpTransportFactory {
  const schema = driverConfigurationSchema.check(
    Schema.makeFilter(
      configuration =>
        configuration.nodeRuntime === undefined ||
        configuration.command === runtimeExecutable ||
        'Electron Node mode requires the trusted runtime executable.',
    ),
  )
  return options => {
    const configuration = Schema.decodeUnknownResult(schema)(options.configuration ?? {})
    if (configuration._tag === 'Failure') {
      return Effect.fail(
        new AgentDriverError({
          code: 'invalid-state',
          message: 'ACP connection needs a valid command and JSON argument list.',
        }),
      )
    }
    const { command, argsJson = [], nodeRuntime } = configuration.success
    const env = acpSpawnEnvironment(scrubEnvironment, nodeRuntime)
    return spawnJsonRpcStdio(command, argsJson, { env, extendEnv: true }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError(
        () =>
          new AgentDriverError({
            code: 'driver-unavailable',
            message: 'ACP process could not be started.',
          }),
      ),
    )
  }
}

/** Apply the fixed inherited-environment policy and the one supported bundled-runtime setting. */
export function acpSpawnEnvironment(
  scrubEnvironment: ReadonlyArray<string> = defaultScrubbedEnvironment,
  nodeRuntime?: 'electron',
): Record<string, string> {
  const env = Object.fromEntries(Array.from(scrubEnvironment, name => [name, undefined])) as unknown as Record<
    string,
    string
  >
  env.ELECTRON_RUN_AS_NODE = undefined as unknown as string
  if (nodeRuntime === 'electron') env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export const layerAcpAgentDriver = (factoryOptions: AcpDriverFactoryOptions = {}) =>
  Layer.effect(
    AgentDriver,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const scrub = new Set(factoryOptions.scrubEnvironment ?? defaultScrubbedEnvironment)
      for (const name of factoryOptions.preserveEnvironment ?? []) scrub.delete(name)
      return makeAcpDriver({
        transportFactory: defaultTransportFactory(spawner, [...scrub], factoryOptions.runtimeExecutable),
      })
    }),
  )

export const acpDriverLimits = Object.freeze({
  maxFrameBytes: MAX_FRAME_BYTES,
  maxEvents: MAX_EVENTS,
  maxEventBytes: MAX_EVENT_BYTES,
  maxReplayEvents: MAX_REPLAY_EVENTS,
  maxReplayBytes: MAX_REPLAY_BYTES,
  maxCompletedChannels: MAX_COMPLETED_CHANNELS,
})

export type AcpTestAgent = Agent
export type AcpInitializedPeer = InitializeResponse
export type AcpSupportedUpdate = SessionUpdate
export type AcpAgentClient = Client
export type AcpRequestPermissionOptions = PermissionOption[]
export type AcpConnectionFactory = (
  toClient: (agent: Agent) => Client,
  stream: Parameters<typeof ndJsonStream>[0] extends never ? never : import('@agentclientprotocol/sdk').Stream,
) => ClientSideConnection
