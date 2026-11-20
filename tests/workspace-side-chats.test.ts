import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'

import {
  hasNewerActiveRun,
  latestCompletedRun,
  sideChatBringBackPrompt,
  sideChatDigest,
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
  SIDE_CHAT_BRING_BACK_MAX_CHARS,
  SIDE_CHAT_CONTEXT_MAX_CHARS,
  SIDE_CHAT_LINE_MAX_CHARS,
  type SideChatRecord,
} from '../src/shared/schemas/workspace-side-chats.js'
import type {
  CreateTaskCommand,
  SideChatBringBackRecord,
  WorkspaceConversationPageItem,
  WorkspaceConversationPageReadOptions,
  WorkspacePayloadReference,
} from '../src/shared/schemas/workspace-store.js'

const parentTaskId = taskIdSchema.make('parent-task')
const parentConversationId = conversationIdSchema.make('parent-conversation')
const projectId = projectIdSchema.make('project')
const checkoutId = workspaceCheckoutIdSchema.make('checkout')
const otherCheckoutId = workspaceCheckoutIdSchema.make('checkout-feature')
const issued = '2026-11-02T12:00:00.000Z'
const request: CreateSideChatRequest = { commandId: 'create-a', parentTaskId, parentConversationId }
const sideRuns = (): Array<{ id: string; status: string; submittedAt: string }> => [
  { id: 'side-run-a', status: 'completed', submittedAt: '2026-11-02T12:00:00.000Z' },
  { id: 'side-run-b', status: 'completed', submittedAt: '2026-11-02T12:01:00.000Z' },
  { id: 'side-run-c', status: 'failed', submittedAt: '2026-11-02T12:02:00.000Z' },
]
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
  const bringBacks: SideChatBringBackRecord[] = []
  const deletedTasks = new Set<string>()
  let parentItems = [item(1, 'first reply', true), item(2, ' continues')]
  let sideItems = [
    item(3, 'old reply', true, 'side-run-a'),
    item(4, 'latest reply', true, 'side-run-b'),
    item(5, 'unfinished reply', true, 'side-run-c'),
  ]
  let sideRunList = sideRuns()
  let busy = false
  let parentIsSide = false
  let parentCheckout = checkoutId
  let otherCheckouts: Array<{ id: typeof checkoutId; archivedAt?: string }> = []
  let pageSize = 1
  let failCreation = false
  let onRead: (() => void) | undefined
  let reads = 0
  const payloads = new Map<string, string>()
  const payloadReads: number[] = []
  const watermarks: Array<number | undefined> = []
  const pendingIndexFor = (conversation: string) =>
    bringBacks.findIndex(record => record.parentConversationId === conversation && record.status === 'pending')
  const store = {
    readTaskDetail: () =>
      Effect.succeed({
        task: { id: parentTaskId, projectId, title: 'Parent' },
        conversations: [{ id: parentConversationId }],
      }),
    getProject: () =>
      Effect.succeed({
        project: { id: projectId },
        mainCheckout: { id: checkoutId },
        otherCheckouts,
      }),
    readTaskSnapshot: (id: string) => {
      if (deletedTasks.has(id)) return Effect.fail(new Error('Task does not exist'))
      if (id === parentTaskId)
        return Effect.succeed({
          task: { id, projectId, title: 'Parent', status: 'open', sideChat: parentIsSide },
          runs: [{ id: 'parent-run', status: busy ? 'running' : 'completed', submittedAt: issued }],
          runContexts: [{ runId: 'parent-run', conversationId: parentConversationId, checkoutId: parentCheckout }],
        })
      return Effect.succeed({
        task: { id, projectId, title: 'Side chat', status: 'open', sideChat: true },
        runs: sideRunList,
        runContexts: [{ runId: 'side-run-a', conversationId: 'side-conversation', checkoutId }],
      })
    },
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
    recordSideChatBringBack: (record: SideChatBringBackRecord) => {
      if (busy) return Effect.succeed({ _tag: 'parent-busy' as const })
      const index = pendingIndexFor(record.parentConversationId)
      const pending = bringBacks[index]
      if (pending && pending.sideChatId !== record.sideChatId)
        return Effect.succeed({ _tag: 'bring-back-pending' as const, pendingSideChatId: pending.sideChatId })
      if (pending) bringBacks[index] = { ...pending, status: 'superseded' }
      bringBacks.push(record)
      return Effect.succeed({ _tag: 'recorded' as const, record, supersedesId: pending?.id ?? null })
    },
    deleteSideChatTask: (command: { sideChatId: string; sideTaskId: string; onlyIfUnused: boolean }) => {
      if (command.onlyIfUnused && sideRunList.length > 0) return Effect.succeed(false)
      deletedTasks.add(command.sideTaskId)
      bringBacks.forEach((record, index) => {
        if (record.sideChatId === command.sideChatId && record.status === 'pending')
          bringBacks[index] = { ...record, status: 'cancelled' }
      })
      return Effect.succeed(true)
    },
  } as unknown as WorkspaceStore['Service']
  const persistence = SideChatPersistence.of({
    get: id => Effect.succeed(records.get(id) ?? null),
    put: record =>
      Effect.sync(() => {
        records.set(record.binding.id, record)
      }),
    list: () => Effect.succeed([...records.values()]),
    remove: id =>
      Effect.sync(() => {
        records.delete(id)
      }),
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
    bringBacks,
    get reads() {
      return reads
    },
    setParent: (items: WorkspaceConversationPageItem[]) => {
      parentItems = items
    },
    setSide: (items: WorkspaceConversationPageItem[]) => {
      sideItems = items
    },
    setSideRuns: (runs: Array<{ id: string; status: string; submittedAt: string }>) => {
      sideRunList = runs
    },
    setBusy: (value: boolean) => {
      busy = value
    },
    setParentIsSide: (value: boolean) => {
      parentIsSide = value
    },
    setParentCheckout: (value: typeof checkoutId) => {
      parentCheckout = value
      otherCheckouts = [{ id: otherCheckoutId }]
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
    expect(h.created[0]?.task.sideChat).toEqual({ parentTaskId, parentConversationId })
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
  it('replays the same binding and frozen snapshot, and adds only the parent activity after the watermark', async () => {
    const h = harness()
    await h.run(service =>
      Effect.gen(function* () {
        const first = yield* service.create(request)
        h.setParent([item(1, 'first reply', true), item(2, ' continues'), item(7, 'changed context', true)])
        const before = h.reads
        expect(yield* service.create(request)).toEqual(first)
        expect(h.reads).toBe(before)
        const seeded = yield* service.enrichPrompt(first.taskId, 'side question', null)
        const [snapshot = '', delta = ''] = seeded.split('Main thread activity since the snapshot')
        expect(snapshot).toContain('question 1')
        expect(snapshot).not.toContain('changed context')
        expect(delta).toContain('changed context')
        expect(seeded).toContain('You are in a side chat beside the main thread.')
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
        const [snapshot = ''] = (yield* service.enrichPrompt(binding.taskId, 'question')).split(
          'Main thread activity since the snapshot',
        )
        expect(snapshot).not.toContain('later context')
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
  it('refuses to start a side chat from a side chat', async () => {
    const h = harness()
    h.setParentIsSide(true)
    await h.run(service =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(service.create(request))).toMatchObject({ code: 'nested' })
        expect(h.created).toHaveLength(0)
        expect(h.records.size).toBe(0)
      }),
    )
  })
  it('titles a new side chat from its request and falls back to Side chat', async () => {
    const h = harness()
    const titled = await h.run(service => service.create({ ...request, title: 'Trace the parser' }))
    expect(titled.title).toBe('Trace the parser')
    const untitled = await h.run(service => service.create({ ...request, commandId: 'create-untitled' }))
    expect(untitled.title).toBe('Side chat')
  })
  it('shares the parent checkout, and ignores any checkout choice on the request', async () => {
    const h = harness()
    h.setParentCheckout(otherCheckoutId)
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        expect(binding.checkoutId).toBe(otherCheckoutId)
        expect(h.records.get(binding.id)?.request).toEqual(request)
      }),
    )
  })
})

describe('side chat bring-back', () => {
  it('records the latest finished reply, and brings it back as a pending transfer rather than a draft', async () => {
    const h = harness()
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        const receipt = yield* service.bringBack({ id: binding.id })
        expect(receipt).toMatchObject({
          sideChatId: binding.id,
          sourceRunId: 'side-run-b',
          supersedesBringBackId: null,
        })
        expect(h.bringBacks).toHaveLength(1)
        expect(h.bringBacks[0]?.digest).toContain('Assistant: latest reply')
        expect(h.bringBacks[0]?.digest).not.toContain('unfinished')
      }),
    )
  })
  it('reports no finished reply before the side chat completes a Run', async () => {
    const h = harness()
    h.setSideRuns([{ id: 'side-run-x', status: 'running', submittedAt: issued }])
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        expect(yield* Effect.flip(service.bringBack({ id: binding.id }))).toMatchObject({ code: 'no-finished-reply' })
        expect(h.bringBacks).toHaveLength(0)
      }),
    )
  })
  it('waits while a newer side Run is still active', async () => {
    const h = harness()
    h.setSideRuns([
      { id: 'side-run-done', status: 'completed', submittedAt: '2026-11-02T12:00:00.000Z' },
      { id: 'side-run-next', status: 'running', submittedAt: '2026-11-02T12:05:00.000Z' },
    ])
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        expect(yield* Effect.flip(service.bringBack({ id: binding.id }))).toMatchObject({ code: 'conflict' })
      }),
    )
  })
  it('refuses while the main chat is busy', async () => {
    const h = harness()
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        h.setBusy(true)
        expect(yield* Effect.flip(service.bringBack({ id: binding.id }))).toMatchObject({ code: 'parent-busy' })
        expect(h.bringBacks).toHaveLength(0)
      }),
    )
  })
  it('supersedes an earlier bring-back from the same side chat, and refuses another side chat while one is pending', async () => {
    const h = harness()
    await h.run(service =>
      Effect.gen(function* () {
        const first = yield* service.create(request)
        const original = yield* service.bringBack({ id: first.id })
        const again = yield* service.bringBack({ id: first.id })
        expect(again.supersedesBringBackId).toBe(original.bringBackId)
        const second = yield* service.create({ ...request, commandId: 'create-b' })
        expect(yield* Effect.flip(service.bringBack({ id: second.id }))).toMatchObject({
          code: 'bring-back-pending',
        })
      }),
    )
  })
  it('uses the reply through its own Run, not a later failed attempt', async () => {
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
        expect(yield* service.bringBack({ id: binding.id })).toMatchObject({ sourceRunId: 'side-run-b' })
        expect(h.bringBacks[0]?.digest).toContain('Assistant: latest reply')
        expect(h.bringBacks[0]?.digest).not.toContain('unfinished')
      }),
    )
  })
})

describe('side chat delete', () => {
  it('deletes an unused side chat and cancels its pending bring-back', async () => {
    const h = harness()
    h.setSideRuns([])
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        expect(yield* service.delete({ id: binding.id, onlyIfUnused: true })).toEqual({ id: binding.id, deleted: true })
        expect(h.records.has(binding.id)).toBe(false)
        expect(yield* Effect.flip(service.get(binding.id))).toMatchObject({ code: 'not-found' })
      }),
    )
  })
  it('keeps a side chat that already has Runs when closing it', async () => {
    const h = harness()
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        expect(yield* service.delete({ id: binding.id, onlyIfUnused: true })).toEqual({
          id: binding.id,
          deleted: false,
        })
        expect(yield* service.get(binding.id)).toEqual(binding)
      }),
    )
  })
  it('refuses to delete a side chat while its Run is active', async () => {
    const h = harness()
    h.setSideRuns([{ id: 'side-run-live', status: 'running', submittedAt: issued }])
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        expect(yield* Effect.flip(service.delete({ id: binding.id }))).toMatchObject({ code: 'conflict' })
        expect(h.records.has(binding.id)).toBe(true)
      }),
    )
  })
  it('deletes an explicitly chosen side chat, even one with Runs', async () => {
    const h = harness()
    await h.run(service =>
      Effect.gen(function* () {
        const binding = yield* service.create(request)
        expect(yield* service.delete({ id: binding.id })).toEqual({ id: binding.id, deleted: true })
        expect(yield* Effect.flip(service.get(binding.id))).toMatchObject({ code: 'not-found' })
      }),
    )
  })
  it('reports a missing side chat as not found', async () => {
    const h = harness()
    await h.run(service =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(service.delete({ id: 'side-chat:missing' }))).toMatchObject({ code: 'not-found' })
      }),
    )
  })
})

describe('side chat digest and framing', () => {
  it('keeps every digest line within the line limit and stops at the chosen Run', () => {
    const items = [
      item(1, 'x'.repeat(500), true, 'run-1'),
      item(2, 'second reply', true, 'run-2'),
      item(3, 'after the chosen run', true, 'run-3'),
    ]
    const digest = sideChatDigest(items, { throughRunId: 'run-2', maxCharacters: SIDE_CHAT_BRING_BACK_MAX_CHARS })
    for (const line of digest.digest.split('\n')) expect(line.length).toBeLessThanOrEqual(SIDE_CHAT_LINE_MAX_CHARS)
    expect(digest.digest).toContain('User: question 2')
    expect(digest.digest).not.toContain('after the chosen run')
    expect(digest.truncated).toBe(false)
  })
  it('keeps the newest lines and marks truncation when the bound is reached', () => {
    const items = Array.from({ length: 50 }, (_, index) => item(index + 1, `reply ${index} ${'y'.repeat(200)}`, true))
    const digest = sideChatDigest(items, { maxCharacters: 1000 })
    expect(digest.truncated).toBe(true)
    expect(digest.digest.length).toBeLessThanOrEqual(1000)
    expect(digest.digest).toContain('question 50')
    expect(digest.digest).not.toContain('question 1\n')
  })
  it('includes tool lines in the digest', () => {
    const items: WorkspaceConversationPageItem[] = [
      {
        event: {
          sequence: 1,
          schemaVersion: 1,
          kind: 'driverEvent',
          runId: agentRunIdSchema.make('run-1'),
          taskId: parentTaskId,
          generation: 1,
          occurredAt: issued,
          data: { event: { kind: 'toolStarted', toolCallId: 'tool', name: 'Read', input: 'config.ts' } },
        },
      },
    ]
    expect(sideChatDigest(items, { maxCharacters: 1000 }).digest).toBe('Tool: Read config.ts')
  })
  it('frames a brought-back digest ahead of the current request', () => {
    const record: SideChatBringBackRecord = {
      id: 'bring-back-1',
      parentTaskId,
      parentConversationId,
      sideChatId: 'side-chat:a',
      sideTaskId: taskIdSchema.make('side-task:a'),
      sideConversationId: conversationIdSchema.make('side-conversation:a'),
      sourceRunId: agentRunIdSchema.make('side-run-b'),
      title: 'Picker',
      digest: 'User: which picker?\nAssistant: keep it',
      truncated: false,
      status: 'consumed',
      createdAt: issued,
      consumedRunId: null,
      consumedAt: null,
    }
    const prompt = sideChatBringBackPrompt(record, 'Ship it')
    expect(prompt).toContain('Side chat "Picker" was brought back')
    expect(prompt.endsWith('---\nCurrent request: Ship it')).toBe(true)
    expect(prompt).toContain('User: which picker?\nAssistant: keep it')
  })
})

describe('side chat run selection', () => {
  it('picks the newest completed Run and detects a newer active one', () => {
    const runs = [
      { id: 'a', status: 'completed', submittedAt: '2026-11-02T12:00:00.000Z' },
      { id: 'b', status: 'completed', submittedAt: '2026-11-02T12:01:00.000Z' },
      { id: 'c', status: 'running', submittedAt: '2026-11-02T12:02:00.000Z' },
    ] as never[]
    expect(latestCompletedRun(runs)).toMatchObject({ id: 'b' })
    expect(hasNewerActiveRun(runs, latestCompletedRun(runs) as never)).toBe(true)
    expect(latestCompletedRun([])).toBeNull()
  })
})
