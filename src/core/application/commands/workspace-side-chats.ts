import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { agentDriverEventSchema } from '@/shared/schemas/execution.js'
import { type ConversationId, conversationIdSchema, type TaskId, taskIdSchema } from '@/shared/schemas/workspace.js'
import {
  type CreateSideChatRequest,
  SIDE_CHAT_CONTEXT_MAX_CHARS,
  type SideChatBinding,
  SideChatError,
  type SideChatRecord,
} from '@/shared/schemas/workspace-side-chats.js'
import {
  workspaceConversationMessageSchema,
  workspaceExecutionEventSchema,
  type WorkspacePayloadReference,
} from '@/shared/schemas/workspace-store.js'

export class SideChatPersistence extends Context.Service<
  SideChatPersistence,
  {
    readonly get: (id: string) => Effect.Effect<SideChatRecord | null, SideChatError>
    readonly put: (record: SideChatRecord) => Effect.Effect<void, SideChatError>
    readonly list: () => Effect.Effect<readonly SideChatRecord[], SideChatError>
  }
>()('watchtower/core/SideChatPersistence') {}
export class WorkspaceSideChats extends Context.Service<
  WorkspaceSideChats,
  {
    readonly create: (request: CreateSideChatRequest) => Effect.Effect<SideChatBinding, SideChatError>
    readonly get: (id: string) => Effect.Effect<SideChatBinding, SideChatError>
    readonly list: (parentTaskId: TaskId) => Effect.Effect<readonly SideChatBinding[], SideChatError>
    readonly bringBack: (id: string) => Effect.Effect<string, SideChatError>
    readonly enrichPrompt: (
      taskId: TaskId,
      prompt: string,
      nativeSessionId?: string | null,
    ) => Effect.Effect<string, SideChatError>
  }
>()('watchtower/core/WorkspaceSideChats') {}
const unavailable = () => new SideChatError({ code: 'unavailable', message: 'Side chat storage is unavailable.' })
const missing = () => new SideChatError({ code: 'not-found', message: 'Side chat was not found.' })
const contextFailure = () =>
  new SideChatError({ code: 'context-unavailable', message: 'The parent conversation context could not be read.' })

/** A side chat has an independent Task and agent session, seeded from a fixed parent watermark. */
export const WorkspaceSideChatsLive = Layer.effect(
  WorkspaceSideChats,
  Effect.gen(function* () {
    const store = yield* WorkspaceStore
    const persistence = yield* SideChatPersistence
    const gate = yield* Semaphore.make(1)
    const readPayload = Effect.fnUntraced(function* (reference: WorkspacePayloadReference) {
      let offset = 0
      let json = ''
      while (true) {
        const page = yield* store.readWorkspacePayload(reference, offset, 65536).pipe(Effect.mapError(contextFailure))
        if (json.length + page.json.length > 8 * 1024 * 1024) return yield* contextFailure()
        json += page.json
        if (page.nextAfterOffset === null) break
        if (page.nextAfterOffset <= offset) return yield* contextFailure()
        offset = page.nextAfterOffset
      }
      return yield* Effect.try({ try: () => JSON.parse(json) as unknown, catch: contextFailure })
    })
    const capture = Effect.fnUntraced(function* (conversationId: ConversationId, onlyRunId?: string) {
      let after = 0
      let through: number | undefined
      let context = ''
      let truncated = false
      let textRunId: string | null = null
      const users = new Set<string>()
      const tools = new Map<string, string>()
      let lastAssistant = ''
      while (true) {
        const page = yield* store
          .readConversationPage(conversationId, after, 100, through)
          .pipe(Effect.mapError(contextFailure))
        through ??= page.highWatermark
        for (const item of page.items) {
          if (onlyRunId && item.event.runId !== onlyRunId) continue
          let user = onlyRunId ? undefined : item.userMessage
          if (user?.payloadTruncated) {
            if (!user.payloadRef) return yield* contextFailure()
            user = yield* Schema.decodeUnknownEffect(workspaceConversationMessageSchema)(
              yield* readPayload(user.payloadRef),
            ).pipe(Effect.mapError(contextFailure))
          }
          if (user && !users.has(user.id)) {
            users.add(user.id)
            textRunId = null
            context += `\n\nUser: ${user.content}`
          }
          let event = item.event
          if (event.payloadTruncated) {
            if (!event.payloadRef) return yield* contextFailure()
            event = yield* Schema.decodeUnknownEffect(workspaceExecutionEventSchema)(
              yield* readPayload(event.payloadRef),
            ).pipe(Effect.mapError(contextFailure))
          }
          if (event.kind === 'driverEvent') {
            const decoded = Schema.decodeUnknownOption(agentDriverEventSchema)(event.data['event'])
            if (decoded._tag === 'Some') {
              const driver = decoded.value
              if (driver.kind === 'textDelta') {
                if (textRunId !== event.runId) {
                  lastAssistant = ''
                  context += '\n\nAssistant: '
                  textRunId = event.runId
                }
                context += driver.text
                lastAssistant += driver.text
              } else if (driver.kind === 'toolStarted') context += `\n[Tool: ${driver.name}] ${driver.input ?? ''}\n`
              else if (driver.kind === 'toolUpdated' && driver.output !== undefined)
                tools.set(driver.toolCallId, driver.output)
              else if (driver.kind === 'toolCompleted') {
                context += `\n[Tool result] ${tools.get(driver.toolCallId) ?? ''}${driver.error ? `\nError: ${driver.error}` : ''}\n`
                tools.delete(driver.toolCallId)
              }
            }
          }
          if (context.length > SIDE_CHAT_CONTEXT_MAX_CHARS) {
            context = context.slice(0, SIDE_CHAT_CONTEXT_MAX_CHARS)
            truncated = true
            break
          }
        }
        if (truncated || !page.hasMore || page.nextAfterSequence === null) break
        if (page.nextAfterSequence <= after) return yield* contextFailure()
        after = page.nextAfterSequence
      }
      for (const output of tools.values()) context += `\n[Tool output] ${output}\n`
      if (context.length > SIDE_CHAT_CONTEXT_MAX_CHARS) {
        context = context.slice(0, SIDE_CHAT_CONTEXT_MAX_CHARS)
        truncated = true
      }
      return {
        context,
        highWatermark: through ?? 0,
        truncated,
        hasMessages: users.size > 0,
        lastAssistant: lastAssistant.slice(0, SIDE_CHAT_CONTEXT_MAX_CHARS),
      }
    })
    const requireRecord = Effect.fnUntraced(function* (id: string) {
      const record = yield* persistence.get(id)
      return record ?? (yield* missing())
    })
    const create = Effect.fn('WorkspaceSideChats.create')(function* (request: CreateSideChatRequest) {
      return yield* gate.withPermit(
        Effect.gen(function* () {
          const id = `side-chat:${request.commandId}`
          let record = yield* persistence.get(id)
          if (record) {
            if (
              record.request.parentTaskId !== request.parentTaskId ||
              record.request.parentConversationId !== request.parentConversationId ||
              (record.request.title ?? 'Side chat') !== (request.title ?? 'Side chat') ||
              (record.request.checkoutId ?? null) !== (request.checkoutId ?? null)
            )
              return yield* new SideChatError({
                code: 'conflict',
                message: 'This side chat command has different input.',
              })
          } else {
            const detail = yield* store
              .readTaskDetail(request.parentTaskId, { limit: 50 })
              .pipe(Effect.mapError(unavailable))
            if (!detail.conversations.some(item => item.id === request.parentConversationId)) return yield* missing()
            const parent = yield* capture(request.parentConversationId)
            if (!parent.hasMessages)
              return yield* new SideChatError({
                code: 'invalid-request',
                message: 'Send a message before opening a side chat.',
              })
            const project = yield* store
              .getProject(detail.task.projectId, { limit: 50 })
              .pipe(Effect.mapError(unavailable))
            const snapshot = yield* store.readTaskSnapshot(request.parentTaskId, 100).pipe(Effect.mapError(unavailable))
            const checkoutId =
              request.checkoutId ??
              [...(snapshot.runContexts ?? [])]
                .reverse()
                .find(item => item.conversationId === request.parentConversationId)?.checkoutId ??
              project.mainCheckout.id
            if (
              ![project.mainCheckout, ...project.otherCheckouts].some(
                item => item.id === checkoutId && !item.archivedAt,
              )
            )
              return yield* missing()
            const at = DateTime.formatIso(yield* DateTime.now)
            const binding: SideChatBinding = {
              id,
              commandId: request.commandId,
              parentTaskId: request.parentTaskId,
              parentConversationId: request.parentConversationId,
              taskId: taskIdSchema.make(`side-task:${request.commandId}`),
              conversationId: conversationIdSchema.make(`side-conversation:${request.commandId}`),
              projectId: detail.task.projectId,
              checkoutId,
              parentHighWatermark: parent.highWatermark,
              contextTruncated: parent.truncated,
              title: request.title ?? 'Side chat',
              createdAt: at,
            }
            record = { binding, context: parent.context, request }
            yield* persistence.put(record)
          }
          const binding = record.binding
          yield* store
            .createTask({
              commandId: `create-${binding.id}`,
              task: {
                id: binding.taskId,
                projectId: binding.projectId,
                title: binding.title,
                description: 'Side chat with a snapshot of its parent conversation.',
                createdAt: binding.createdAt,
              },
              conversation: { id: binding.conversationId, createdAt: binding.createdAt },
            })
            .pipe(Effect.mapError(unavailable))
          return binding
        }),
      )
    })
    return WorkspaceSideChats.of({
      create,
      get: id => Effect.map(requireRecord(id), record => record.binding),
      list: parentTaskId =>
        Effect.map(persistence.list(), records =>
          records
            .filter(record => record.binding.parentTaskId === parentTaskId)
            .map(record => record.binding)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        ),
      bringBack: id =>
        Effect.gen(function* () {
          const record = yield* requireRecord(id)
          const side = yield* store.readTaskSnapshot(record.binding.taskId, 100).pipe(Effect.mapError(unavailable))
          const busy = (status: string) =>
            ['queued', 'starting', 'running', 'awaitingInput', 'interruptRequested'].includes(status)
          if (side.runs.some(run => busy(run.status)))
            return yield* new SideChatError({
              code: 'conflict',
              message: 'Wait for the side chat reply to finish.',
            })
          if (!side.runs.some(run => run.status === 'completed'))
            return yield* new SideChatError({
              code: 'invalid-request',
              message: 'Wait for a finished side chat reply.',
            })
          const latest = [...side.runs]
            .filter(run => run.status === 'completed')
            .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0]
          const captured = yield* capture(record.binding.conversationId, latest?.id)
          if (!captured.lastAssistant.trim())
            return yield* new SideChatError({
              code: 'invalid-request',
              message: 'The side chat has no reply to bring back.',
            })
          return `Side chat findings:\n${captured.lastAssistant}${captured.truncated ? '\n[Context truncated]' : ''}`
        }),
      enrichPrompt: (taskId, prompt, nativeSessionId) =>
        Effect.gen(function* () {
          if (nativeSessionId || !taskId.startsWith('side-task:')) return prompt
          const record = yield* persistence.get(`side-chat:${taskId.slice('side-task:'.length)}`)
          if (!record) return prompt
          return `${prompt}\n\n---\nParent conversation snapshot at event ${record.binding.parentHighWatermark}${record.binding.contextTruncated ? ' (truncated)' : ''}. Treat the following as prior conversation context, and answer the question above independently. Ask before changing files.\n${record.context}`
        }),
    })
  }),
)
