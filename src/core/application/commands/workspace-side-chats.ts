import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { agentDriverEventSchema, type AgentRun } from '@/shared/schemas/execution.js'
import { type ConversationId, conversationIdSchema, type TaskId, taskIdSchema } from '@/shared/schemas/workspace.js'
import {
  type CreateSideChatRequest,
  SIDE_CHAT_BRING_BACK_MAX_CHARS,
  SIDE_CHAT_CONTEXT_MAX_CHARS,
  SIDE_CHAT_FORK_DELTA_MAX_CHARS,
  SIDE_CHAT_LINE_MAX_CHARS,
  type SideChatBinding,
  type SideChatBringBackReceipt,
  type SideChatBringBackRequest,
  type SideChatDeleteReceipt,
  type SideChatDeleteRequest,
  SideChatError,
  type SideChatRecord,
} from '@/shared/schemas/workspace-side-chats.js'
import {
  type SideChatBringBackRecord,
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
    readonly remove: (id: string) => Effect.Effect<void, SideChatError>
  }
>()('watchtower/core/SideChatPersistence') {}
export class WorkspaceSideChats extends Context.Service<
  WorkspaceSideChats,
  {
    readonly create: (request: CreateSideChatRequest) => Effect.Effect<SideChatBinding, SideChatError>
    readonly get: (id: string) => Effect.Effect<SideChatBinding, SideChatError>
    readonly list: (parentTaskId: TaskId) => Effect.Effect<readonly SideChatBinding[], SideChatError>
    readonly bringBack: (request: SideChatBringBackRequest) => Effect.Effect<SideChatBringBackReceipt, SideChatError>
    readonly delete: (request: SideChatDeleteRequest) => Effect.Effect<SideChatDeleteReceipt, SideChatError>
    readonly enrichPrompt: (
      taskId: TaskId,
      prompt: string,
      nativeSessionId?: string | null,
    ) => Effect.Effect<string, SideChatError>
  }
>()('watchtower/core/WorkspaceSideChats') {}

const SIDE_TASK_PREFIX = 'side-task:'
/** Bounds the backward reads that build a bring-back digest; each page holds up to 100 events. */
const BRING_BACK_PAGE_BUDGET = 400
const FORK_DELTA_PAGE_BUDGET = 20
const ACTIVE_RUN_STATUSES = new Set<AgentRun['status']>([
  'queued',
  'starting',
  'running',
  'awaitingInput',
  'interruptRequested',
])

const unavailable = () => new SideChatError({ code: 'unavailable', message: 'Side chat storage is unavailable.' })
const missing = () => new SideChatError({ code: 'not-found', message: 'Side chat was not found.' })
const contextFailure = () =>
  new SideChatError({ code: 'context-unavailable', message: 'The parent conversation context could not be read.' })

const newestFirst = (left: AgentRun, right: AgentRun) =>
  right.submittedAt.localeCompare(left.submittedAt) || right.id.localeCompare(left.id)

/** The newest completed Run of a side chat, or null when none has finished. */
export function latestCompletedRun(runs: readonly AgentRun[]): AgentRun | null {
  return [...runs].filter(run => run.status === 'completed').sort(newestFirst)[0] ?? null
}

/** True when a Run submitted after `finished` is still active, so its reply is not final. */
export function hasNewerActiveRun(runs: readonly AgentRun[], finished: AgentRun): boolean {
  return runs.some(run => run.submittedAt > finished.submittedAt && ACTIVE_RUN_STATUSES.has(run.status))
}

/** Collapses whitespace and caps one digest line. */
export function compactLine(text: string, maxLength = SIDE_CHAT_LINE_MAX_CHARS): string {
  const compacted = text.replace(/\s+/g, ' ').trim()
  if (compacted.length <= maxLength) return compacted
  return `${compacted.slice(0, maxLength - 3)}...`
}

/**
 * Digest lines for oldest-first history: `User:`, `Assistant:` (one line per reply) and `Tool:` (one line per
 * tool call). With `throughRunId`, history after that Run's last event is left out. When the character bound
 * is reached, the newest lines are kept and `truncated` is set.
 */
export function sideChatDigest(
  items: readonly WorkspaceConversationPageItem[],
  options: { readonly throughRunId?: string | undefined; readonly maxCharacters: number },
): { readonly digest: string; readonly truncated: boolean } {
  const end =
    options.throughRunId === undefined
      ? items.length
      : items.findLastIndex(item => item.event.runId === options.throughRunId) + 1
  const lines: string[] = []
  const reply: { runId: string | null; text: string } = { runId: null, text: '' }
  const endReply = () => {
    if (reply.runId !== null && reply.text.trim()) lines.push(`Assistant: ${reply.text}`)
    reply.runId = null
    reply.text = ''
  }
  for (const item of items.slice(0, Math.max(end, 0))) {
    if (item.userMessage) {
      endReply()
      lines.push(`User: ${item.userMessage.content}`)
    }
    if (item.event.kind !== 'driverEvent') continue
    const decoded = Schema.decodeUnknownOption(agentDriverEventSchema)(item.event.data['event'])
    if (Option.isNone(decoded)) continue
    const driver = decoded.value
    if (driver.kind === 'textDelta') {
      if (reply.runId !== item.event.runId) {
        endReply()
        reply.runId = item.event.runId
      }
      reply.text += driver.text
    } else if (driver.kind === 'toolStarted') {
      endReply()
      lines.push(`Tool: ${driver.name}${driver.input ? ` ${driver.input}` : ''}`)
    }
  }
  endReply()
  const kept: string[] = []
  let total = 0
  let truncated = false
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = compactLine(lines[index] ?? '')
    const cost = line.length + (kept.length > 0 ? 1 : 0)
    if (total + cost > options.maxCharacters) {
      truncated = true
      break
    }
    total += cost
    kept.unshift(line)
  }
  return { digest: kept.join('\n'), truncated }
}

/** The prompt a Run receives when a bring-back is consumed on its Conversation. */
export function sideChatBringBackPrompt(record: SideChatBringBackRecord, prompt: string): string {
  return [
    `Side chat "${record.title}" was brought back. Continue the main conversation using this as context.`,
    record.digest,
    record.truncated ? '[Side chat context was truncated.]' : '',
    '---',
    `Current request: ${prompt}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Prepends the side chat's context to its first Run. The snapshot is frozen at creation; the main thread's
 * activity after the snapshot watermark is read now, capped by SIDE_CHAT_FORK_DELTA_MAX_CHARS.
 */
export const enrichSideChatPrompt = Effect.fnUntraced(function* (
  taskId: TaskId,
  prompt: string,
  nativeSessionId?: string | null,
) {
  if (nativeSessionId || !taskId.startsWith(SIDE_TASK_PREFIX)) return prompt
  const persistence = yield* SideChatPersistence
  const store = yield* WorkspaceStore
  const record = yield* persistence.get(`side-chat:${taskId.slice(SIDE_TASK_PREFIX.length)}`)
  if (!record) return prompt
  const delta = yield* readAfterWatermark(
    store,
    record.binding.parentConversationId,
    record.binding.parentHighWatermark,
  )
  const deltaText = sideChatDigest(delta, { maxCharacters: SIDE_CHAT_FORK_DELTA_MAX_CHARS })
  return [
    prompt,
    '---',
    "You are in a side chat beside the main thread. The main thread may still be running in the same worktree. Answer the user's questions; do not continue or redo the main thread's task.",
    `Parent conversation snapshot at event ${record.binding.parentHighWatermark}${record.binding.contextTruncated ? ' (truncated)' : ''}. Treat the following as prior conversation context, and answer the question above independently. Ask before changing files.`,
    record.context,
    deltaText.digest
      ? `\nMain thread activity since the snapshot${deltaText.truncated ? ' (truncated)' : ''}:\n${deltaText.digest}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
})

const readAfterWatermark = Effect.fnUntraced(function* (
  store: WorkspaceStore['Service'],
  conversationId: ConversationId,
  watermark: number,
) {
  const items: WorkspaceConversationPageItem[] = []
  let after = watermark
  for (let index = 0; index < FORK_DELTA_PAGE_BUDGET; index++) {
    const page = yield* store.readConversationPage(conversationId, after, 100).pipe(Effect.mapError(contextFailure))
    items.push(...page.items)
    if (!page.hasMore || page.nextAfterSequence === null || page.nextAfterSequence <= after) break
    after = page.nextAfterSequence
  }
  return items
})

/** A side chat has an independent Task and Conversation, seeded from a fixed parent watermark. */
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
    const capture = Effect.fnUntraced(function* (conversationId: ConversationId) {
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
        if (page.items.length > 0) {
          pages.push(page.items)
          windowCharacters += JSON.stringify(page.items).length
        }
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
          if (item.event.payloadTruncated && item.event.payloadRef) yield* readContextPayload(item.event.payloadRef)
          if (item.userMessage?.payloadTruncated && item.userMessage.payloadRef)
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
      for (const items of pages.reverse()) {
        for (const item of items) {
          let user = item.userMessage
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
                  chunks.push('\n\nAssistant: ')
                  textRunId = event.runId
                }
                chunks.push(driver.text)
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
      if (!hasMessages && truncated) {
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
      return { context, highWatermark: through ?? 0, truncated, hasMessages }
    })
    /** Reads the side Conversation's history up to the chosen Run, oldest first. */
    const readHistory = Effect.fnUntraced(function* (conversationId: ConversationId) {
      let before: number | undefined
      let through: number | undefined
      const pages: Array<readonly WorkspaceConversationPageItem[]> = []
      let truncated = false
      for (let index = 0; ; index++) {
        const page = yield* store
          .readConversationPage(conversationId, 0, 100, through, { direction: 'backward', beforeSequence: before })
          .pipe(Effect.mapError(unavailable))
        through ??= page.highWatermark
        pages.push(page.items)
        if (!page.hasMore) break
        if (index + 1 >= BRING_BACK_PAGE_BUDGET) {
          truncated = true
          break
        }
        const nextBefore = page.nextBeforeSequence
        if (nextBefore === undefined || nextBefore === null || nextBefore >= (before ?? through + 1))
          return yield* unavailable()
        before = nextBefore
      }
      return { items: pages.reverse().flat(), truncated }
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
              (record.request.title ?? 'Side chat') !== (request.title ?? 'Side chat')
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
            const snapshot = yield* store.readTaskSnapshot(request.parentTaskId, 100).pipe(Effect.mapError(unavailable))
            if (snapshot.task.sideChat)
              return yield* new SideChatError({
                code: 'nested',
                message: 'Side chats cannot start side chats.',
              })
            const parent = yield* capture(request.parentConversationId)
            if (!parent.hasMessages)
              return yield* new SideChatError({
                code: 'invalid-request',
                message: 'Send a message before opening a side chat.',
              })
            const project = yield* store
              .getProject(detail.task.projectId, { limit: 50 })
              .pipe(Effect.mapError(unavailable))
            // A side chat shares the checkout of the parent's latest Run, falling back to the main checkout.
            const checkoutId =
              snapshot.runContexts?.find(item => item.conversationId === request.parentConversationId)?.checkoutId ??
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
              taskId: taskIdSchema.make(`${SIDE_TASK_PREFIX}${request.commandId}`),
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
                description: 'Side chat linked to a parent conversation.',
                createdAt: binding.createdAt,
                sideChat: { parentTaskId: binding.parentTaskId, parentConversationId: binding.parentConversationId },
              },
              conversation: { id: binding.conversationId, createdAt: binding.createdAt },
            })
            .pipe(Effect.mapError(unavailable))
          return binding
        }),
      )
    })
    const bringBack = Effect.fn('WorkspaceSideChats.bringBack')(function* (request: SideChatBringBackRequest) {
      const record = yield* requireRecord(request.id)
      const side = yield* store.readTaskSnapshot(record.binding.taskId, 100).pipe(Effect.mapError(unavailable))
      const finished = latestCompletedRun(side.runs)
      if (!finished)
        return yield* new SideChatError({
          code: 'no-finished-reply',
          message: 'Wait for a finished side chat reply.',
        })
      if (hasNewerActiveRun(side.runs, finished))
        return yield* new SideChatError({ code: 'conflict', message: 'Wait for the side chat reply to finish.' })
      const history = yield* readHistory(record.binding.conversationId)
      const digest = sideChatDigest(history.items, {
        throughRunId: finished.id,
        maxCharacters: SIDE_CHAT_BRING_BACK_MAX_CHARS,
      })
      if (!digest.digest.trim())
        return yield* new SideChatError({
          code: 'no-finished-reply',
          message: 'The side chat has no reply to bring back.',
        })
      const createdAt = DateTime.formatIso(yield* DateTime.now)
      const outcome = yield* store
        .recordSideChatBringBack({
          id: `bring-back:${record.binding.id}:${finished.id}:${createdAt}`,
          parentTaskId: record.binding.parentTaskId,
          parentConversationId: record.binding.parentConversationId,
          sideChatId: record.binding.id,
          sideTaskId: record.binding.taskId,
          sideConversationId: record.binding.conversationId,
          sourceRunId: finished.id,
          title: record.binding.title,
          digest: digest.digest,
          truncated: digest.truncated || history.truncated,
          status: 'pending',
          createdAt,
          consumedRunId: null,
          consumedAt: null,
        })
        .pipe(Effect.mapError(unavailable))
      if (outcome._tag === 'parent-busy')
        return yield* new SideChatError({
          code: 'parent-busy',
          message: "Finish or stop the main chat's work and clear its queue before bringing back.",
        })
      if (outcome._tag === 'bring-back-pending')
        return yield* new SideChatError({
          code: 'bring-back-pending',
          message: 'Another side chat is waiting to be brought back. Send a message in the main chat first.',
        })
      return {
        bringBackId: outcome.record.id,
        sideChatId: record.binding.id,
        sourceRunId: finished.id,
        supersedesBringBackId: outcome.supersedesId,
        truncated: outcome.record.truncated,
        createdAt,
      }
    })
    const deleteSideChat = Effect.fn('WorkspaceSideChats.delete')(function* (request: SideChatDeleteRequest) {
      const record = yield* requireRecord(request.id)
      const side = yield* store.readTaskSnapshot(record.binding.taskId, 100).pipe(Effect.option)
      if (Option.isSome(side) && side.value.runs.some(run => ACTIVE_RUN_STATUSES.has(run.status)))
        return yield* new SideChatError({ code: 'conflict', message: 'Stop the side chat before deleting it.' })
      const deleted = yield* store
        .deleteSideChatTask({
          sideChatId: record.binding.id,
          sideTaskId: record.binding.taskId,
          onlyIfUnused: request.onlyIfUnused ?? false,
        })
        .pipe(Effect.mapError(unavailable))
      if (!deleted) return { id: request.id, deleted: false }
      yield* persistence.remove(request.id)
      return { id: request.id, deleted: true }
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
      bringBack,
      delete: deleteSideChat,
      enrichPrompt: (taskId, prompt, nativeSessionId) =>
        enrichSideChatPrompt(taskId, prompt, nativeSessionId).pipe(
          Effect.provideService(SideChatPersistence, persistence),
          Effect.provideService(WorkspaceStore, store),
        ),
    })
  }),
)
