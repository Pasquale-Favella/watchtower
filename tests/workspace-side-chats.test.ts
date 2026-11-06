import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'

import {
  SideChatPersistence,
  WorkspaceSideChats,
  WorkspaceSideChatsLive,
} from '../src/core/application/commands/workspace-side-chats.js'
import { WorkspaceStore } from '../src/core/ports/workspace-store.js'
import {
  agentRunIdSchema,
  conversationIdSchema,
  projectIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '../src/shared/schemas/workspace.js'
import {
  type CreateSideChatRequest,
  SIDE_CHAT_CONTEXT_MAX_CHARS,
  type SideChatRecord,
} from '../src/shared/schemas/workspace-side-chats.js'
import type {
  CreateTaskCommand,
  WorkspaceConversationPageItem,
  WorkspaceConversationPageReadOptions,
  WorkspacePayloadReference,
} from '../src/shared/schemas/workspace-store.js'

const parentTaskId = taskIdSchema.make('parent-task')
const parentConversationId = conversationIdSchema.make('parent-conversation')
const projectId = projectIdSchema.make('project')
const checkoutId = workspaceCheckoutIdSchema.make('checkout')
const issued = '2026-11-02T12:00:00.000Z'
const request: CreateSideChatRequest = { commandId: 'create-a', parentTaskId, parentConversationId }
function item(sequence: number, text: string, user = false, run = 'run-a'): WorkspaceConversationPageItem {
  return {
    event: {
      sequence,
      schemaVersion: 1,
      kind: 'driverEvent',
      runId: agentRunIdSchema.make(run),
      taskId: parentTaskId,
      generation: 1,
      occurredAt: issued,
      data: { event: { kind: 'textDelta', text } },
    },
    ...(user ? { userMessage: { id: `message-${sequence}`, content: `question ${sequence}`, createdAt: issued } } : {}),
  }
}
function harness() {
  const records = new Map<string, SideChatRecord>()
  const created: CreateTaskCommand[] = []
  let parentItems = [item(1, 'first reply', true), item(2, ' continues')]
  let sideItems = [
    item(3, 'old reply', true, 'side-run-a'),
    item(4, 'latest reply', true, 'side-run-b'),
    item(5, 'unfinished reply', true, 'side-run-c'),
  ]
  let busy = false
  let pageSize = 1
  let failCreation = false
  let onRead: (() => void) | undefined
  let reads = 0
  const payloads = new Map<string, string>()
  const payloadReads: number[] = []
  const watermarks: Array<number | undefined> = []
  const store = {
    readTaskDetail: () =>
      Effect.succeed({
        task: { id: parentTaskId, projectId, title: 'Parent' },
        conversations: [{ id: parentConversationId }],
      }),
    getProject: () =>
      Effect.succeed({ project: { id: projectId }, mainCheckout: { id: checkoutId }, otherCheckouts: [] }),
    readTaskSnapshot: (id: string) =>
      Effect.succeed({
        runs:
          id === parentTaskId
            ? [{ status: busy ? 'running' : 'completed' }]
            : [
                { id: 'side-run-a', status: 'completed', submittedAt: '2026-11-02T12:00:00.000Z' },
                { id: 'side-run-b', status: 'completed', submittedAt: '2026-11-02T12:01:00.000Z' },
                { id: 'side-run-c', status: 'failed', submittedAt: '2026-11-02T12:02:00.000Z' },
              ],
        runContexts: [{ conversationId: parentConversationId, checkoutId }],
      }),
    readConversationPage: (
      id: string,
      after: number,
      limit: number,
      through?: number,
      options?: WorkspaceConversationPageReadOptions,
    ) => {
      reads++
      watermarks.push(through)
      const all = id === parentConversationId ? parentItems : sideItems
      const bound = through ?? all.at(-1)?.event.sequence ?? 0
      const backward = options?.direction === 'backward'
      const entries = all.filter(
        item =>
          item.event.sequence <= bound &&
          (backward ? item.event.sequence <= (options.beforeSequence ?? bound) : item.event.sequence > after),
      )
      const count = Math.min(pageSize, limit)
      const selected = backward ? entries.slice(-count) : entries.slice(0, count)
      const hasMore = entries.length > selected.length
      onRead?.()
      return Effect.succeed({
        items: selected,
        highWatermark: bound,
        nextAfterSequence: !backward && hasMore ? (selected.at(-1)?.event.sequence ?? null) : null,
        nextBeforeSequence: backward && hasMore ? (selected[0]?.event.sequence ?? 1) - 1 : null,
        hasMore,
      })
    },
    readWorkspacePayload: (reference: WorkspacePayloadReference, offset: number, limit: number) => {
      const json = payloads.get(reference.id)
      if (json === undefined) return Effect.fail(new Error('Payload unavailable'))
      payloadReads.push(offset)
      const end = Math.min(offset + limit, json.length)
      return Effect.succeed({
        json: json.slice(offset, end),
        total: json.length,
        nextAfterOffset: end < json.length ? end : null,
        truncated: end < json.length,
      })
    },
    createTask: (command: CreateTaskCommand) => {
      created.push(command)
      if (failCreation) {
        failCreation = false
        return Effect.fail(new Error('Storage unavailable'))
      }
      return Effect.succeed({
        commandId: command.commandId,
        taskId: command.task.id,
        conversationId: command.conversation.id,
        replayed: created.length > 1,
      })
    },
  } as unknown as WorkspaceStore['Service']
  const persistence = SideChatPersistence.of({
    get: id => Effect.succeed(records.get(id) ?? null),
    put: record =>
      Effect.sync(() => {
        records.set(record.binding.id, record)
      }),
    list: () => Effect.succeed([...records.values()]),
  })
  const layer = WorkspaceSideChatsLive.pipe(
    Layer.provide(Layer.merge(Layer.succeed(WorkspaceStore, store), Layer.succeed(SideChatPersistence, persistence))),
  )
  return {
    created,
    records,
    payloads,
    payloadReads,
    watermarks,
    get reads() {
      return reads
    },
    setParent: (items: WorkspaceConversationPageItem[]) => {
      parentItems = items
    },
    setSide: (items: WorkspaceConversationPageItem[]) => {
      sideItems = items
    },
    setBusy: (value: boolean) => {
      busy = value
    },
    setPageSize: (value: number) => {
      pageSize = value
    },
    failNextCreation: () => {
      failCreation = true
    },
    onRead: (callback: () => void) => {
      onRead = callback
    },
    run: <A, E>(use: (service: WorkspaceSideChats['Service']) => Effect.Effect<A, E>) =>
      Effect.runPromise(Effect.provide(Effect.flatMap(WorkspaceSideChats, use), layer)),
  }
}
describe('side chat context and independent identity', () => {
  it('captures ordered parent context at one watermark and creates an independent Task', async () => {
    const h = harness()
    const binding = await h.run(service => service.create(request))
    expect(binding.taskId).not.toBe(parentTaskId)
    expect(binding.conversationId).not.toBe(parentConversationId)
    expect(binding.parentHighWatermark).toBe(2)
    expect(h.watermarks).toEqual([undefined, 2])
    expect(h.records.get(binding.id)?.context).toBe('\n\nUser: question 1\n\nAssistant: first reply continues')
    expect(h.created).toHaveLength(1)
    expect(h.created[0]?.task.projectId).toBe(projectId)
  })
  it('captures final tool output and input without duplicating intermediate tool snapshots', async () => {
    const h = harness()
    const start = item(2, '')
    const interim = item(3, '')
    const final = item(4, '')
    const done = item(5, '')
    h.setParent([
      item(1, 'reply', true),
      {
        ...start,
        event: {
          ...start.event,
          data: { event: { kind: 'toolStarted', toolCallId: 'tool', name: 'Read', input: 'config.ts' } },
        },
      },
      {
        ...interim,
        event: {
          ...interim.event,
          data: { event: { kind: 'toolUpdated', toolCallId: 'tool', output: 'intermediate' } },
        },
      },
      {
        ...final,
        event: {
          ...final.event,
          data: { event: { kind: 'toolUpdated', toolCallId: 'tool', output: 'final contents' } },
        },
      },
      { ...done, event: { ...done.event, data: { event: { kind: 'toolCompleted', toolCallId: 'tool' } } } },
    ])
    const binding = await h.run(service => service.create(request))
    const context = h.records.get(binding.id)?.context
    expect(context).toContain('config.ts')
    expect(context).toContain('final contents')
    expect(context).not.toContain('intermediate')
  })
  it('replays the same binding and original context after parent messages change', async () => {
    const h = harness()
    await h.run(service =>
      Effect.gen(function* () {
        const first = yield* service.create(request)
        h.setParent([item(7, 'changed context', true)])
        const before = h.reads
        expect(yield* service.create(request)).toEqual(first)
        expect(h.reads).toBe(before)
        const seeded = yield* service.enrichPrompt(first.taskId, 'side question', null)
        expect(seeded).toContain('question 1')
        expect(seeded).not.toContain('changed context')
        expect(yield* service.enrichPrompt(first.taskId, 'continuation', 'native-session')).toBe('continuation')
      }),
    )
  })
  it('keeps recent decisions in chronological order without scanning the whole history', async () => {
    const h = harness()
    h.setPageSize(100)
    h.setParent([
      ...Array.from({ length: 10000 }, (_, index) => item(index + 1, `old ${index} ${'x'.repeat(200)}`, true)),
      item(10001, 'recent decision A', true, 'recent-a'),
      item(10002, 'recent decision B', true, 'recent-b'),
    ])
    const binding = await h.run(service => service.create(request))
    const context = h.records.get(binding.id)?.context ?? ''
    expect(binding.contextTruncated).toBe(true)
    expect(context.length).toBeLessThanOrEqual(SIDE_CHAT_CONTEXT_MAX_CHARS)
    expect(context).not.toContain('old 0 ')
    expect(context).toContain('recent decision A')
    expect(context.indexOf('recent decision A')).toBeLessThan(context.indexOf('recent decision B'))
    expect(h.reads).toBeLessThan(10)
  })
  it('pins every page to the first watermark when new parent events arrive during capture', async () => {
    const h = harness()
    h.onRead(() => h.setParent([item(1, 'first reply', true), item(2, ' continues'), item(3, 'later', true)]))
    const binding = await h.run(service => service.create(request))
    expect(binding.parentHighWatermark).toBe(2)
    expect(h.watermarks).toEqual([undefined, 2])
    expect(h.records.get(binding.id)?.context).toBe('\n\nUser: question 1\n\nAssistant: first reply continues')
  })
  it('retries task creation with the immutable captured context after a storage failure', async () => {
    const h = harness()
    h.failNextCreation()
    await h.run(service =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(service.create(request))).toMatchObject({ code: 'unavailable' })
        const original = h.records.get('side-chat:create-a')
        const reads = h.reads
        h.setParent([item(7, 'later context', true)])
        const binding = yield* service.create(request)
        expect(binding).toEqual(original?.binding)
        expect(h.records.get(binding.id)).toEqual(original)
        expect(h.reads).toBe(reads)
        expect(yield* service.enrichPrompt(binding.taskId, 'question')).not.toContain('later context')
      }),
    )
  })
  it('omits an oversized referenced tool payload and keeps the surrounding recent discussion', async () => {
    const h = harness()
    const update = item(2, '')
    const reference: WorkspacePayloadReference = { kind: 'event', id: '2', digest: 'a'.repeat(64) }
    const fullEvent = {
      ...update.event,
      data: { event: { kind: 'toolUpdated', toolCallId: 'tool', output: 'x'.repeat(9 * 1024 * 1024) } },
    }
    h.payloads.set(reference.id, JSON.stringify(fullEvent))
    h.setParent([
      item(1, 'before the tool', true),
      {
        event: {
          ...fullEvent,
          data: { event: { kind: 'toolUpdated', toolCallId: 'tool', output: 'tool preview' } },
          payloadTruncated: true,
          payloadRef: reference,
        },
      },
      item(3, 'recent decision'),
    ])
    const binding = await h.run(service => service.create(request))
    const context = h.records.get(binding.id)?.context
    expect(binding.contextTruncated).toBe(true)
    expect(context).toContain('[Event payload truncated]')
    expect(context).toContain('before the tool')
    expect(context).toContain('recent decision')
    expect(context).toContain('tool preview')
    expect(context?.indexOf('tool preview')).toBeLessThan(context?.indexOf('recent decision') ?? 0)
    expect(h.payloadReads).toEqual([0])
  })
  it.each(['{invalid JSON', '{"unrelated":true}'])(
    'rejects an invalid referenced payload instead of treating it as oversized context: %s',
    async json => {
      const h = harness()
      const original = item(1, 'preview', true)
      const reference: WorkspacePayloadReference = { kind: 'event', id: '1', digest: 'a'.repeat(64) }
      h.payloads.set(reference.id, json)
      h.setParent([{ ...original, event: { ...original.event, payloadTruncated: true, payloadRef: reference } }])
      await h.run(service =>
        Effect.gen(function* () {
          expect(yield* Effect.flip(service.create(request))).toMatchObject({ code: 'context-unavailable' })
          expect(h.created).toHaveLength(0)
          expect(h.records.size).toBe(0)
        }),
      )
    },
  )
  it('bounds a large inline tool output without losing the latest discussion', async () => {
    const h = harness()
    const update = item(2, '')
    h.setParent([
      item(1, 'before the tool', true),
      {
        event: {
          ...update.event,
          data: { event: { kind: 'toolUpdated', toolCallId: 'tool', output: 'x'.repeat(500000) } },
        },
      },
      item(3, 'recent decision'),
    ])
    const binding = await h.run(service => service.create(request))
    const context = h.records.get(binding.id)?.context
    expect(binding.contextTruncated).toBe(true)
    expect(context).toContain('[Tool content truncated]')
    expect(context).toContain('recent decision')
  })
  it('refuses a changed request under the same command identity', async () => {
    const h = harness()
    await h.run(service =>
      Effect.gen(function* () {
        yield* service.create(request)
        expect(yield* Effect.flip(service.create({ ...request, title: 'different' }))).toMatchObject({
          code: 'conflict',
        })
      }),
    )
  })
  it('cannot create a side chat before the first parent message', async () => {
    const h = harness()
    h.setParent([])
    await h.run(service =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(service.create(request))).toMatchObject({ code: 'invalid-request' })
        expect(h.created).toHaveLength(0)
        expect(h.records.size).toBe(0)
      }),
    )
  })
  it('brings back only the latest reply while allowing the parent to keep running', async () => {
    const h = harness()
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        expect(yield* service.bringBack(binding.id)).toBe('Side chat findings:\nlatest reply')
        h.setBusy(true)
        expect(yield* service.bringBack(binding.id)).toBe('Side chat findings:\nlatest reply')
      }),
    )
  })
  it('reaches the latest completed reply after a long failed attempt without spending its context budget', async () => {
    const h = harness()
    h.setPageSize(100)
    h.setSide([
      item(3, 'old reply', true, 'side-run-a'),
      item(4, 'latest reply', true, 'side-run-b'),
      ...Array.from({ length: 4100 }, (_, index) =>
        item(index + 5, `unfinished ${'x'.repeat(100)}`, false, 'side-run-c'),
      ),
    ])
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        expect(yield* service.bringBack(binding.id)).toBe('Side chat findings:\nlatest reply')
      }),
    )
  })
})
