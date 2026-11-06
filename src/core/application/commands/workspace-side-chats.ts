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
  type WorkspaceConversationPageItem,
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

export const enrichSideChatPrompt = Effect.fnUntraced(function* (
  taskId: TaskId,
  prompt: string,
  nativeSessionId?: string | null,
) {
  if (nativeSessionId || !taskId.startsWith('side-task:')) return prompt
  const persistence = yield* SideChatPersistence
  const record = yield* persistence.get(`side-chat:${taskId.slice('side-task:'.length)}`)
  if (!record) return prompt
  return `${prompt}\n\n---\nParent conversation snapshot at event ${record.binding.parentHighWatermark}${record.binding.contextTruncated ? ' (truncated)' : ''}. Treat the following as prior conversation context, and answer the question above independently. Ask before changing files.\n${record.context}`
})

/** A side chat has an independent Task and agent session, seeded from a fixed parent watermark. */
export const WorkspaceSideChatsLive = Layer.effect(
  WorkspaceSideChats,
  Effect.gen(function* () {
    const store = yield* WorkspaceStore
    const persistence = yield* SideChatPersistence
    const gate = yield* Semaphore.make(1)
    const readPayload = Effect.fnUntraced(function* (reference: WorkspacePayloadReference, maxCharacters: number) {
      let offset = 0
      let json = ''
      while (true) {
        const page = yield* store.readWorkspacePayload(reference, offset, 65536).pipe(Effect.mapError(contextFailure))
        if (page.total > maxCharacters) return undefined
        if (json.length + page.json.length > maxCharacters) return yield* contextFailure()
        json += page.json
        if (page.nextAfterOffset === null) break
        if (page.nextAfterOffset <= offset) return yield* contextFailure()
        offset = page.nextAfterOffset
      }
      const value = yield* Effect.try({ try: () => JSON.parse(json) as unknown, catch: contextFailure })
      return { value, characters: json.length }
    })
    const capture = Effect.fnUntraced(function* (conversationId: ConversationId, onlyRunId?: string) {
      let before: number | undefined
      let through: number | undefined
      const pages: Array<readonly WorkspaceConversationPageItem[]> = []
      let windowCharacters = 0
      const chunks: string[] = []
      let truncated = false
      while (true) {
        const page = yield* store
          .readConversationPage(conversationId, 0, 100, through, { direction: 'backward', beforeSequence: before })
          .pipe(Effect.mapError(contextFailure))
        through ??= page.highWatermark
        const items = onlyRunId ? page.items.filter(item => item.event.runId === onlyRunId) : page.items
        if (items.length > 0) {
          pages.push(items)
          windowCharacters += JSON.stringify(items).length
        }
        if (onlyRunId && items.some(item => item.event.kind === 'runQueued')) break
        if (!page.hasMore) break
        const nextBefore = page.nextBeforeSequence
        if (nextBefore === undefined || nextBefore === null || nextBefore >= (before ?? through + 1))
          return yield* contextFailure()
        if (windowCharacters >= SIDE_CHAT_CONTEXT_MAX_CHARS * 2 || pages.length === 40) {
          truncated = true
          break
        }
        before = nextBefore
      }
      let payloadCharacters = 0
      const payloads = new Map<string, unknown>()
      const readContextPayload = Effect.fnUntraced(function* (reference: WorkspacePayloadReference) {
        const key = `${reference.kind}:${reference.id}:${reference.digest}`
        if (payloads.has(key)) return payloads.get(key)
        const payload = yield* readPayload(reference, SIDE_CHAT_CONTEXT_MAX_CHARS * 2 - payloadCharacters)
        if (!payload) {
          truncated = true
          payloads.set(key, undefined)
          return undefined
        }
        payloadCharacters += payload.characters
        payloads.set(key, payload.value)
        return payload.value
      })
      for (const items of pages) {
        for (const item of [...items].reverse()) {
          if (onlyRunId && item.event.runId !== onlyRunId) continue
          if (item.event.payloadTruncated && item.event.payloadRef) yield* readContextPayload(item.event.payloadRef)
          if (!onlyRunId && item.userMessage?.payloadTruncated && item.userMessage.payloadRef)
            yield* readContextPayload(item.userMessage.payloadRef)
        }
      }
      function toolText(text: string): string {
        const limit = SIDE_CHAT_CONTEXT_MAX_CHARS / 4
        if (text.length <= limit) return text
        truncated = true
        return `${text.slice(0, limit)}\n[Tool content truncated]`
      }
      let textRunId: string | null = null
      const users = new Set<string>()
      const tools = new Map<string, { output: string; chunkIndex: number }>()
      let lastAssistant = ''
      for (const items of pages.reverse()) {
        for (const item of items) {
          if (onlyRunId && item.event.runId !== onlyRunId) continue
          let user = onlyRunId ? undefined : item.userMessage
          if (user?.payloadTruncated) {
            if (!user.payloadRef) return yield* contextFailure()
            const payload = yield* readContextPayload(user.payloadRef)
            if (payload !== undefined)
              user = yield* Schema.decodeUnknownEffect(workspaceConversationMessageSchema)(payload).pipe(
                Effect.mapError(contextFailure),
              )
            else chunks.push('\n[User message truncated]')
          }
          if (user && !users.has(user.id)) {
            users.add(user.id)
            textRunId = null
            chunks.push(`\n\nUser: ${user.content}`)
          }
          let event = item.event
          if (event.payloadTruncated) {
            if (!event.payloadRef) return yield* contextFailure()
            const payload = yield* readContextPayload(event.payloadRef)
            if (payload !== undefined)
              event = yield* Schema.decodeUnknownEffect(workspaceExecutionEventSchema)(payload).pipe(
                Effect.mapError(contextFailure),
              )
            else chunks.push('\n[Event payload truncated]')
          }
          if (event.kind === 'driverEvent') {
            const decoded = Schema.decodeUnknownOption(agentDriverEventSchema)(event.data['event'])
            if (decoded._tag === 'Some') {
              const driver = decoded.value
              const toolKey = `${event.runId}:${'toolCallId' in driver ? driver.toolCallId : ''}`
              if (driver.kind === 'textDelta') {
                if (textRunId !== event.runId) {
                  lastAssistant = ''
                  chunks.push('\n\nAssistant: ')
                  textRunId = event.runId
                }
                chunks.push(driver.text)
                lastAssistant += driver.text
              } else if (driver.kind === 'toolStarted')
                chunks.push(`\n[Tool: ${driver.name}] ${toolText(driver.input ?? '')}\n`)
              else if (driver.kind === 'toolUpdated' && driver.output !== undefined) {
                tools.set(toolKey, { output: toolText(driver.output), chunkIndex: chunks.length })
                chunks.push('')
              } else if (driver.kind === 'toolCompleted') {
                chunks.push(
                  `\n[Tool result] ${tools.get(toolKey)?.output ?? ''}${driver.error ? `\nError: ${toolText(driver.error)}` : ''}\n`,
                )
                tools.delete(toolKey)
              }
            }
          }
        }
      }
      let hasMessages = users.size > 0
      if (!hasMessages && !onlyRunId && truncated) {
        const first = yield* store
          .readConversationPage(conversationId, 0, 1, through)
          .pipe(Effect.mapError(contextFailure))
        hasMessages = first.items.some(item => item.userMessage !== undefined)
      }
      for (const { output, chunkIndex } of tools.values()) chunks[chunkIndex] = `\n[Tool output] ${output}\n`
      let context = chunks.join('')
      if (context.length > SIDE_CHAT_CONTEXT_MAX_CHARS) {
        context = context.slice(-SIDE_CHAT_CONTEXT_MAX_CHARS)
        truncated = true
      }
      return {
        context,
        highWatermark: through ?? 0,
        truncated,
        hasMessages,
        lastAssistant: lastAssistant.slice(-SIDE_CHAT_CONTEXT_MAX_CHARS),
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
        enrichSideChatPrompt(taskId, prompt, nativeSessionId).pipe(
          Effect.provideService(SideChatPersistence, persistence),
        ),
    })
  }),
)
