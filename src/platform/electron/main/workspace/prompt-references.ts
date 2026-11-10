import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { filePromptToken } from '@/shared/prompt-links.js'
import { agentDriverEventSchema } from '@/shared/schemas/execution.js'
import type { PromptContextSearchResult } from '@/shared/schemas/prompt-context.js'
import { type ConversationId, conversationIdSchema, type Task, taskIdSchema } from '@/shared/schemas/workspace.js'
import type { WorkspaceConnection } from '@/shared/schemas/workspace-connections.js'
import type { WorkspaceConversationPageItem, WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'
import { workspaceConversationMessageSchema, workspaceExecutionEventSchema, type WorkspacePayloadReference } from '@/shared/schemas/workspace-store.js'
import { normalizeSearchQuery, scorePromptCommandMatch } from '@/shared/search-ranking.js'

type Item = PromptContextSearchResult['items'][number]
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024
export interface MentionModel {
  readonly connection: Pick<WorkspaceConnection, 'connectionId' | 'label' | 'harnessKind'>
  readonly id: string
  readonly label: string
}

/** Model mentions use literal word starts so short fuzzy queries leave room for files. */
export function searchMentionModels(models: readonly MentionModel[], query: string): Item[] {
  const spaced = query.replace(/[:/]+/g, ' ').trim().toLowerCase()
  const unhyphenated = spaced.replace(/-+/g, ' ')
  if (unhyphenated.replace(/\s/g, '').length < 2) return []
  for (const words of new Set([spaced, unhyphenated])) {
    const tokens = words.split(/\s+/)
    const matches = models.filter(model => {
      const haystack = `${model.label} ${model.id} ${model.connection.label} ${model.connection.harnessKind}`
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
      return tokens.every(token => haystack.some(word => word.startsWith(token)))
    })
    if (!matches.length) continue
    return matches.slice(0, 8).map(model => ({
      kind: 'model',
      path: `model:${model.connection.connectionId}/${model.id}`,
      label: model.label,
      description: model.connection.label,
    }))
  }
  return []
}

export function searchMentionTasks(tasks: readonly Task[], query: string, excludeTaskId?: string): Item[] {
  const needle = normalizeSearchQuery(query)
  return tasks
    .filter(task => !task.archivedAt && task.id !== excludeTaskId)
    .map(task => ({ task, score: needle ? scorePromptCommandMatch(task.title, undefined, needle) : 0 }))
    .filter((entry): entry is { task: Task; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || b.task.updatedAt.localeCompare(a.task.updatedAt) || a.task.id.localeCompare(b.task.id))
    .slice(0, 8)
    .map(({ task }) => ({ kind: 'conversation', path: task.id, label: task.title.slice(0, 512), description: 'Chat context' }))
}

/** One inventory per host; scans every page, so older chats remain searchable. */
export function createPromptReferenceIndex(store: WorkspaceStore['Service']) {
  const load = Effect.fn('PromptReferences.load')(function* () {
    const tasks: Task[] = []
    let projectCursor: string | undefined
    do {
      const projects = yield* store.listProjects({ limit: 50, ...(projectCursor ? { afterId: projectCursor } : {}) })
      for (const project of projects.items) {
        if (project.archivedAt) continue
        let taskCursor: string | undefined
        do {
          const page = yield* store.listTasks(project.id, { limit: 50, ...(taskCursor ? { afterId: taskCursor } : {}) })
          tasks.push(...page.items)
          taskCursor = page.nextAfterId ?? undefined
        } while (taskCursor)
      }
      projectCursor = projects.nextAfterId ?? undefined
    } while (projectCursor)
    return tasks
  })
  type Read = ReturnType<typeof load>
  let cached: readonly [get: Read, invalidate: Effect.Effect<void>] | undefined
  const read = Effect.fnUntraced(function* () {
    if (!cached) {
      const created = yield* load().pipe(Effect.cachedInvalidateWithTTL('5 seconds'))
      cached ??= created
    }
    return yield* cached[0]
  })
  return {
    search: (query: string, excludeTaskId?: string, excludeConversationId?: ConversationId): Effect.Effect<Item[], WorkspaceStoreError> =>
      store.searchPromptConversations
        ? Effect.map(store.searchPromptConversations({ query, ...(excludeConversationId ? { excludeConversationId } : {}) }), matches => matches.map(match => ({
            kind: 'conversation' as const,
            path: JSON.stringify([match.taskId, match.conversationId]),
            label: match.title,
            description: 'Chat context',
          })))
        : Effect.map(read(), tasks => searchMentionTasks(tasks, query, excludeTaskId)),
    invalidate: Effect.suspend(() => cached?.[1] ?? Effect.void),
  }
}

function transcriptEntry(item: WorkspaceConversationPageItem): string {
  const lines: string[] = []
  if (item.userMessage) lines.push(`User:\n${item.userMessage.content}`)
  const event = item.event.data
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ event: agentDriverEventSchema }))(event)
  if (Option.isSome(decoded)) {
    const activity = decoded.value.event
    if (activity.kind === 'textDelta') lines.push(`Assistant:\n${activity.text}`)
    else if (activity.kind === 'reasoningDelta') lines.push(`Reasoning:\n${activity.text}`)
  }
  // Driver events retain their structured payload when it is not plain text.
  if (!lines.length) lines.push(JSON.stringify(event))
  return lines.join('\n\n')
}

/** Immutable snapshots are named by content; the agent reads the referenced file on demand. */
export function createPromptReferenceFiles(directory: string) {
  async function save(title: string, content: string): Promise<{ readonly text: string }> {
    if (Buffer.byteLength(content) > MAX_REFERENCE_BYTES) throw new Error('The context snapshot exceeds 2 MiB.')
    const hash = createHash('sha256').update(content).digest('hex')
    const basename = title.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 60) || 'context'
    const path = join(directory, hash, `${basename}.md`)
    await mkdir(join(directory, hash), { recursive: true })
    await writeFile(path, content, { flag: 'wx', mode: 0o600 }).catch(cause => {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause
    })
    return { text: filePromptToken(path.replaceAll('\\', '/')) }
  }
  const conversation = Effect.fn('PromptReferences.conversation')(function* (store: WorkspaceStore['Service'], id: string) {
    const parsed = id.startsWith('[') ? yield* Effect.try(() => JSON.parse(id) as unknown) : id
    const identity = yield* Schema.decodeUnknownEffect(Schema.Union([taskIdSchema, Schema.Tuple([taskIdSchema, conversationIdSchema])]))(parsed)
    const taskId = typeof identity === 'string' ? identity : identity[0]
    const selectedId = typeof identity === 'string' ? undefined : identity[1]
    let detail = yield* store.readTaskDetail(taskId)
    if (selectedId) {
      while (!detail.conversations.some(item => item.id === selectedId) && detail.nextAfterConversationId) {
        detail = yield* store.readTaskDetail(taskId, { afterId: detail.nextAfterConversationId, limit: 50 })
      }
      if (!detail.conversations.some(item => item.id === selectedId))
        return yield* Effect.fail(new Error('The referenced Conversation no longer belongs to this Task.'))
    }
    const chunks = [`# Chat: ${detail.task.title}`, `Task: ${taskId}`, 'This is a read-only snapshot. It does not authorize sending messages to the source chat.']
    let length = Buffer.byteLength(chunks.join('\n\n'))
    const truncated = '[Snapshot limited to 2 MiB. Additional history was not captured.]'
    function append(text: string): boolean {
      const bytes = Buffer.byteLength(text) + 2
      if (length + bytes + Buffer.byteLength(truncated) + 2 > MAX_REFERENCE_BYTES) return false
      length += bytes
      chunks.push(text)
      return true
    }
    const readPayload = Effect.fnUntraced(function* (reference: WorkspacePayloadReference) {
      let offset = 0
      let json = ''
      while (true) {
        const page = yield* store.readWorkspacePayload(reference, offset, 65536)
        if (page.total > MAX_REFERENCE_BYTES || json.length + page.json.length > MAX_REFERENCE_BYTES) return undefined
        json += page.json
        if (page.nextAfterOffset === null) break
        if (page.nextAfterOffset <= offset) return yield* Effect.fail(new Error('Context payload did not advance.'))
        offset = page.nextAfterOffset
      }
      return yield* Effect.try(() => JSON.parse(json) as unknown)
    })
    for (const conversation of detail.conversations.filter(item => !selectedId || item.id === selectedId)) {
      if (!append(`## ${conversation.title ?? conversation.id}`)) {
        chunks.push(truncated)
        break
      }
      let cursor = 0
      let watermark: number | undefined
      do {
        const page = yield* store.readConversationPage(conversation.id, cursor, 100, watermark)
        watermark ??= page.highWatermark
        for (const row of page.items) {
          let item = row
          if (row.userMessage?.payloadTruncated && row.userMessage.payloadRef) {
            const payload = yield* readPayload(row.userMessage.payloadRef)
            if (payload === undefined) append('[User message exceeds the snapshot limit and was not captured.]')
            else item = { ...item, userMessage: yield* Schema.decodeUnknownEffect(workspaceConversationMessageSchema)(payload) }
          }
          if (row.event.payloadTruncated && row.event.payloadRef) {
            const payload = yield* readPayload(row.event.payloadRef)
            if (payload === undefined) append('[Agent event exceeds the snapshot limit and was not captured.]')
            else item = { ...item, event: yield* Schema.decodeUnknownEffect(workspaceExecutionEventSchema)(payload) }
          }
          const text = transcriptEntry(item)
          if (!append(text)) {
            chunks.push(truncated)
            return yield* Effect.tryPromise(() => save(`chat-${detail.task.title}`, chunks.join('\n\n')))
          }
        }
        if (page.hasMore && page.nextAfterSequence !== null && page.nextAfterSequence <= cursor)
          return yield* Effect.fail(new Error('Context history did not advance.'))
        cursor = page.nextAfterSequence ?? cursor
        if (!page.hasMore || page.nextAfterSequence === null) break
      } while (true)
    }
    if (!selectedId && detail.nextAfterConversationId) append('[Additional conversations were not captured.]')
    return yield* Effect.tryPromise(() => save(`chat-${detail.task.title}`, chunks.join('\n\n')))
  })
  return { save, conversation }
}

export type PromptReferenceFiles = ReturnType<typeof createPromptReferenceFiles>
