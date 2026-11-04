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
import type { CreateSideChatRequest, SideChatRecord } from '../src/shared/schemas/workspace-side-chats.js'
import type { CreateTaskCommand, WorkspaceConversationPageItem } from '../src/shared/schemas/workspace-store.js'

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
  let sideItems = [item(3, 'old reply', true, 'side-run-a'), item(4, 'latest reply', true, 'side-run-b')]
  let busy = false
  let reads = 0
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
        runs: [{ status: busy && id === parentTaskId ? 'running' : 'completed' }],
        runContexts: [{ conversationId: parentConversationId, checkoutId }],
      }),
    readConversationPage: (id: string, after: number, _limit: number, through?: number) => {
      reads++
      watermarks.push(through)
      const all = id === parentConversationId ? parentItems : sideItems
      const bound = through ?? all.at(-1)?.event.sequence ?? 0
      const entries = all.filter(item => item.event.sequence > after && item.event.sequence <= bound)
      return Effect.succeed({
        items: entries.slice(0, 1),
        highWatermark: bound,
        nextAfterSequence: entries.length > 1 ? (entries[0]?.event.sequence ?? null) : null,
        hasMore: entries.length > 1,
      })
    },
    createTask: (command: CreateTaskCommand) => {
      created.push(command)
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
})
