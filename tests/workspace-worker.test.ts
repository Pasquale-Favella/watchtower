import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { WorkspaceWorkerStoreLive } from '@/platform/electron/workers/workspace/client.js'
import {
  type BeginRunCommand,
  type QueuedFollowUpPage,
  type WorkspacePayloadPage,
  WorkspaceStoreError,
} from '@/shared/schemas/workspace-store.js'

const timestamp = '2026-10-29T10:00:00Z'
const project = {
  id: 'project-worker' as never,
  name: 'Worker project',
  repositoryIdentity: 'repo:workspace-worker',
  createdAt: timestamp,
  updatedAt: timestamp,
}
const checkout = {
  id: 'checkout-worker' as never,
  kind: 'main' as const,
  path: 'C:/workspace-worker',
  createdAt: timestamp,
}
const task = {
  id: 'task-worker' as never,
  projectId: project.id,
  title: 'Workspace worker integration',
  description: '',
  createdAt: timestamp,
}
const conversation = { id: 'conversation-worker' as never, title: 'Integration', createdAt: timestamp }
const beginRun: BeginRunCommand = {
  commandId: 'command-worker',
  issuedAt: '2026-10-29T10:00:01Z',
  runId: 'run-worker' as never,
  taskId: task.id,
  conversationId: conversation.id,
  checkoutId: checkout.id,
  provisionalAgentSessionId: 'agent-session-worker',
  generation: 1,
  driverId: 'test-driver',
  connectionId: 'test-connection',
  prompt: 'Complete the controlled integration task',
}

let fixtureDirectory = ''
let workerPath = ''
let shutdownIgnoringWorkerPath = ''

interface RuntimeFixture {
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkspaceStore, WorkspaceStoreError>
  readonly workers: Array<Worker>
}

const makeRuntime = (
  filename: string,
  options: {
    readonly workerPath?: string
    readonly initializationTimeoutMs?: number
    readonly closeTimeoutMs?: number
    readonly workerFactory?: (workerPath: string | URL, workerData: { readonly filename: string }) => Worker
  } = {},
): RuntimeFixture => {
  const workers: Array<Worker> = []
  const runtime = ManagedRuntime.make(
    WorkspaceWorkerStoreLive({
      filename,
      workerPath: options.workerPath ?? workerPath,
      ...(options.initializationTimeoutMs === undefined
        ? {}
        : { initializationTimeoutMs: options.initializationTimeoutMs }),
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
      workerFactory: (path, data) => {
        const worker = options.workerFactory
          ? options.workerFactory(path, data)
          : new Worker(path, { workerData: data })
        workers.push(worker)
        return worker
      },
    }),
  )
  return { runtime, workers }
}

const withStore = async (filename: string, use: (store: WorkspaceStore['Service']) => Promise<void>): Promise<void> => {
  const { runtime } = makeRuntime(filename)
  try {
    const store = await runtime.runPromise(WorkspaceStore)
    await use(store)
  } finally {
    await runtime.dispose()
  }
}

const setup = async (store: WorkspaceStore['Service']): Promise<void> => {
  await Effect.runPromise(store.registerProject({ project, mainCheckout: checkout }))
  await Effect.runPromise(store.createTask({ task, conversation }))
}

beforeAll(async () => {
  const buildCache = resolve('node_modules/.cache')
  await mkdir(buildCache, { recursive: true })
  fixtureDirectory = await mkdtemp(join(buildCache, 'watchtower-workspace-worker-'))
  workerPath = join(fixtureDirectory, 'workspace-worker.mjs')
  shutdownIgnoringWorkerPath = join(fixtureDirectory, 'shutdown-ignoring-worker.mjs')
  await build({
    entryPoints: [resolve('src/platform/electron/workers/workspace/entry.ts')],
    outfile: workerPath,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'shutdown-ignoring-worker.mjs',
      contents: `
import { parentPort } from 'node:worker_threads'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Effect from 'effect/Effect'
import { Rpc, RpcGroup, RpcServer, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'

if (!parentPort) throw new Error('test worker must run on a worker thread')
const on = parentPort.on.bind(parentPort)
parentPort.on = (event, listener) => on(event, event === 'message'
  ? message => { if (!Array.isArray(message) || message[0] !== 1) listener(message) }
  : listener)

const group = RpcGroup.make(
  Rpc.make('workspace-worker:ready', { success: Schema.Struct({ protocolVersion: Schema.Literal(6) }) }),
  Rpc.make('workspace-worker:shutdown', { success: Schema.Void }),
)
const handlers = group.toLayer({
  'workspace-worker:ready': () => Effect.succeed({ protocolVersion: 6 }),
  'workspace-worker:shutdown': () => Effect.succeed(undefined),
})
const program = Effect.scoped(Effect.gen(function* () {
  const protocol = yield* RpcServer.makeProtocolWorkerRunner.pipe(Effect.provide(NodeWorkerRunner.layer))
  yield* RpcWorker.initialMessage(Schema.Void).pipe(Effect.provideService(RpcServer.Protocol, protocol))
  return yield* RpcServer.make(group, { disableTracing: true }).pipe(
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.provide(handlers),
  )
}))
NodeRuntime.runMain(program, { disableErrorReporting: true })
`,
    },
    outfile: shutdownIgnoringWorkerPath,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
})

afterAll(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe('workspace worker RPC client', () => {
  it('retrieves oversized pre-existing event and message bodies through bounded lossless payload chunks', async () => {
    const filename = join(fixtureDirectory, 'oversized-records.db')
    const seed = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
    const text = '\u{1f600}'.repeat(1_100_000)
    try {
      const store = await seed.runPromise(WorkspaceStore)
      await setup(store)
      await Effect.runPromise(store.beginRun({ ...beginRun, prompt: text }))
      await Effect.runPromise(store.claimDispatch(beginRun.runId, 7, timestamp))
      await Effect.runPromise(
        store.acknowledgeDispatch(beginRun.runId, {
          ownerEpoch: 7,
          nativeSessionId: 'native-oversized',
          acknowledgedAt: timestamp,
        }),
      )
      await Effect.runPromise(
        store.recordDriverEvent(beginRun.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'oversized',
          occurredAt: timestamp,
          event: { kind: 'textDelta', text },
        }),
      )
    } finally {
      await seed.dispose()
    }
    await withStore(filename, async store => {
      const events = await Effect.runPromise(store.pageEvents(3, 500))
      expect(events.events).toHaveLength(1)
      expect(events.events[0]).toMatchObject({ payloadTruncated: true, payloadRef: { kind: 'event', id: '4' } })
      expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(3 * 1024 * 1024)
      const conversationPage = await Effect.runPromise(store.readConversationPage(conversation.id, 0, 500))
      const message = conversationPage.items.find(item => item.userMessage)?.userMessage
      expect(message).toMatchObject({ payloadTruncated: true, payloadRef: { kind: 'message' } })
      for (const reference of [events.events[0]?.payloadRef, message?.payloadRef]) {
        if (!reference) throw new Error('Expected an oversized record payload reference')
        let json = ''
        let cursor: number | null = 0
        while (cursor !== null) {
          const page: WorkspacePayloadPage = await Effect.runPromise(
            store.readWorkspacePayload(reference, cursor, 65536),
          )
          expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024)
          expect(page.json.length).toBeGreaterThan(0)
          json += page.json
          cursor = page.nextAfterOffset
        }
        expect(reference.kind === 'event' ? JSON.parse(json).data.event.text : JSON.parse(json).content).toBe(text)
        await expect(
          Effect.runPromise(store.readWorkspacePayload({ ...reference, digest: '0'.repeat(64) }, 0, 1)),
        ).rejects.toMatchObject({ code: 'invalid-data' })
        await expect(
          Effect.runPromise(store.readWorkspacePayload(reference, json.length + 1, 1)),
        ).rejects.toMatchObject({ code: 'invalid-data' })
      }
      await expect(
        Effect.runPromise(store.readWorkspacePayload({ kind: 'event', id: '999999', digest: '0'.repeat(64) }, 0, 1)),
      ).rejects.toMatchObject({ code: 'not-found' })
    })
  })

  it('traverses byte-bounded project and task catalogs and fetches summarized detail payloads', async () => {
    await withStore(join(fixtureDirectory, 'read-catalogs.db'), async store => {
      await setup(store)
      const large = 'catalog'.repeat(100_000)
      const expectedProjects = [project.id as string]
      const expectedTasks = [task.id as string]
      for (let index = 0; index < 8; index += 1) {
        const id = `project-byte-${index}`
        expectedProjects.push(id)
        await Effect.runPromise(
          store.registerProject({
            project: { ...project, id: id as never, name: large, repositoryIdentity: `repo:byte-${index}` },
            mainCheckout: { ...checkout, id: `checkout-byte-${index}` as never, path: `C:/byte-${index}` },
          }),
        )
        const taskId = `task-byte-${index}`
        expectedTasks.push(taskId)
        await Effect.runPromise(
          store.createTask({
            task: { ...task, id: taskId as never, description: large },
            conversation: { ...conversation, id: `conversation-byte-${index}` as never },
          }),
        )
      }
      const projectIds: Array<string> = []
      let projectCursor: string | undefined
      let projectPages = 0
      do {
        const page = await Effect.runPromise(store.listProjects({ afterId: projectCursor, limit: 50 }))
        expect(page.total).toBe(9)
        expect(page.items.length).toBeGreaterThan(0)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(3 * 1024 * 1024)
        projectIds.push(...page.items.map(item => item.id))
        projectCursor = page.nextAfterId ?? undefined
        projectPages += 1
      } while (projectCursor)
      expect(projectPages).toBeGreaterThan(1)
      expect(projectIds).toEqual(expectedProjects.sort())
      const taskIds: Array<string> = []
      let taskCursor: string | undefined
      do {
        const page = await Effect.runPromise(store.listTasks(project.id, { afterId: taskCursor, limit: 50 }))
        expect(page.total).toBe(9)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(3 * 1024 * 1024)
        taskIds.push(...page.items.map(item => item.id))
        taskCursor = page.nextAfterId ?? undefined
      } while (taskCursor)
      expect(taskIds).toEqual(expectedTasks.sort())
      const detail = await Effect.runPromise(store.readTaskDetail('task-byte-0' as never))
      expect(detail.task).toMatchObject({ payloadTruncated: true, payloadRef: { kind: 'task', id: 'task-byte-0' } })
      if (!detail.task.payloadRef) throw new Error('Expected a summarized Task payload reference')
      let json = ''
      let cursor: number | null = 0
      while (cursor !== null) {
        const page: WorkspacePayloadPage = await Effect.runPromise(
          store.readWorkspacePayload(detail.task.payloadRef, cursor, 65536),
        )
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024)
        json += page.json
        cursor = page.nextAfterOffset
      }
      expect(JSON.parse(json)).toMatchObject({ id: 'task-byte-0', description: large })
      expect((await Effect.runPromise(store.getProject('project-byte-0' as never))).project).toMatchObject({
        payloadTruncated: true,
      })
      const missing: ReadonlyArray<Effect.Effect<unknown, WorkspaceStoreError>> = [
        store.getProject('missing' as never),
        store.listTasks('missing' as never),
        store.readTaskDetail('missing' as never),
        store.listNativeAgentSessions('missing' as never),
        store.listPendingRuntimeRequests('missing' as never, 0, 1),
        store.readConversationPage('missing' as never, 0, 1),
      ]
      for (const read of missing) await expect(Effect.runPromise(read)).rejects.toMatchObject({ code: 'not-found' })
      const invalid: ReadonlyArray<Effect.Effect<unknown, WorkspaceStoreError>> = [
        store.listProjects({ limit: 51 }),
        store.getProject(project.id, { limit: 0 }),
        store.listTasks(project.id, { limit: 51 }),
        store.readTaskDetail(task.id, { limit: 0 }),
        store.listNativeAgentSessions(task.id, { limit: 51 }),
        store.listPendingRuntimeRequests(task.id, 0, 51),
        store.pageEvents(2, 1, 1),
        store.readConversationPage(conversation.id, 2, 1, 1),
      ]
      for (const read of invalid) await expect(Effect.runPromise(read)).rejects.toMatchObject({ code: 'invalid-data' })
    })
  })

  it('traverses bounded native sessions and large pending requests without mutating state', async () => {
    await withStore(join(fixtureDirectory, 'native-requests-pages.db'), async store => {
      await setup(store)
      for (let index = 0; index < 7; index += 1) {
        const command = {
          ...beginRun,
          commandId: `sessions-command-${index}`,
          runId: `sessions-run-${index}` as never,
          provisionalAgentSessionId: `sessions-${index}`,
        }
        await Effect.runPromise(store.beginRun(command))
        await Effect.runPromise(store.claimDispatch(command.runId, 7, timestamp))
        await Effect.runPromise(
          store.acknowledgeDispatch(command.runId, {
            ownerEpoch: 7,
            nativeSessionId: `native-${index}-` + 'n'.repeat(650 * 1024),
            acknowledgedAt: timestamp,
          }),
        )
        if (index < 6)
          await Effect.runPromise(
            store.recordDriverEvent(command.runId, {
              ownerEpoch: 7,
              generation: 1,
              eventId: `end-${index}`,
              occurredAt: timestamp,
              event: { kind: 'turnCompleted' },
            }),
          )
      }
      for (let index = 0; index < 8; index += 1)
        await Effect.runPromise(
          store.recordDriverEvent('sessions-run-6' as never, {
            ownerEpoch: 7,
            generation: 1,
            eventId: `request-${index}`,
            occurredAt: timestamp,
            event: {
              kind: 'requestPending',
              request: {
                kind: 'question',
                runId: 'sessions-run-6' as never,
                generation: 1,
                requestId: `request-${index}`,
                prompt: 'p'.repeat(700 * 1024),
                questions: [],
              },
            },
          }),
        )
      const before = await Effect.runPromise(store.readTaskSnapshot(task.id, 10))
      const sessions: Array<string> = []
      let sessionCursor: string | undefined
      let sessionPages = 0
      do {
        const page = await Effect.runPromise(
          store.listNativeAgentSessions(task.id, { afterId: sessionCursor, limit: 50 }),
        )
        expect(page.total).toBe(7)
        expect(page.items.length).toBeGreaterThan(0)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(3 * 1024 * 1024)
        expect(page.truncated).toBe(page.nextAfterId !== null)
        sessions.push(...page.items.map(item => item.id))
        sessionCursor = page.nextAfterId ?? undefined
        sessionPages += 1
      } while (sessionCursor)
      expect(sessionPages).toBeGreaterThan(1)
      expect(sessions).toEqual([
        'sessions-0',
        'sessions-1',
        'sessions-2',
        'sessions-3',
        'sessions-4',
        'sessions-5',
        'sessions-6',
      ])
      const requests: Array<string> = []
      let requestCursor = 0
      let requestPages = 0
      while (true) {
        const page = await Effect.runPromise(store.listPendingRuntimeRequests(task.id, requestCursor, 50))
        expect(page.total).toBe(8)
        expect(page.items.length).toBeGreaterThan(0)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(3 * 1024 * 1024)
        requests.push(...page.items.map(item => item.request.requestId))
        requestPages += 1
        if (!page.hasMore) break
        expect(page.nextAfterSequence).not.toBeNull()
        requestCursor = page.nextAfterSequence ?? 0
      }
      expect(requestPages).toBeGreaterThan(1)
      expect(requests).toEqual(Array.from({ length: 8 }, (_, index) => `request-${index}`))
      expect((await Effect.runPromise(store.listNativeAgentSessions(task.id, { limit: 1 }))).items).toHaveLength(1)
      expect((await Effect.runPromise(store.listPendingRuntimeRequests(task.id, 0, 1))).items).toHaveLength(1)
      expect(await Effect.runPromise(store.readTaskSnapshot(task.id, 10))).toEqual(before)
    })
  })

  it('keeps large queued prompts and delivery histories readable through bounded cursor pages', async () => {
    await withStore(join(fixtureDirectory, 'bounded-history.db'), async store => {
      await setup(store)
      for (let index = 0; index < 5; index += 1) {
        await Effect.runPromise(
          store.enqueueFollowUp({
            commandId: `large-queue-${index}`,
            issuedAt: timestamp,
            taskId: task.id,
            conversationId: conversation.id,
            prompt: 'q'.repeat(900 * 1024),
          }),
        )
      }
      await Effect.runPromise(store.beginRun(beginRun))
      await Effect.runPromise(store.claimDispatch(beginRun.runId, 7, timestamp))
      await Effect.runPromise(
        store.acknowledgeDispatch(beginRun.runId, {
          ownerEpoch: 7,
          nativeSessionId: 'native-large',
          acknowledgedAt: timestamp,
        }),
      )
      for (let index = 0; index < 8; index += 1) {
        await Effect.runPromise(
          store.recordSteer({
            commandId: `large-steer-${index}`,
            issuedAt: timestamp,
            runId: beginRun.runId,
            ownerEpoch: 7,
            generation: 1,
            message: 's'.repeat(700 * 1024),
          }),
        )
        await Effect.runPromise(
          store.recordDriverEvent(beginRun.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: `pending-large-${index}`,
            occurredAt: timestamp,
            event: {
              kind: 'requestPending',
              request: {
                runId: beginRun.runId,
                requestId: `large-request-${index}`,
                generation: 1,
                kind: 'question',
                prompt: 'Answer?',
                questions: [],
              },
            },
          }),
        )
        await Effect.runPromise(
          store.recordRequestResponse({
            commandId: `large-response-${index}`,
            issuedAt: timestamp,
            runId: beginRun.runId,
            ownerEpoch: 7,
            generation: 1,
            requestId: `large-request-${index}`,
            decision: { kind: 'answers', answers: { answer: 'r'.repeat(700 * 1024) } },
          }),
        )
      }
      const transcriptText = 't'.repeat(700 * 1024)
      for (let index = 0; index < 6; index += 1) {
        await Effect.runPromise(
          store.recordDriverEvent(beginRun.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: `transcript-${index}`,
            occurredAt: timestamp,
            event: { kind: 'textDelta', text: transcriptText },
          }),
        )
      }
      await expect(Effect.runPromise(store.listProjects({ limit: 1 }))).resolves.toMatchObject({
        items: [{ id: project.id }],
        total: 1,
      })
      await expect(Effect.runPromise(store.getProject(project.id))).resolves.toMatchObject({
        project: { id: project.id },
        mainCheckout: { id: checkout.id, path: checkout.path },
      })
      await expect(Effect.runPromise(store.listTasks(project.id))).resolves.toMatchObject({
        items: [{ id: task.id }],
      })
      await expect(Effect.runPromise(store.readTaskDetail(task.id))).resolves.toMatchObject({
        task: { id: task.id },
        conversations: [{ id: conversation.id }],
      })
      await expect(Effect.runPromise(store.listNativeAgentSessions(task.id))).resolves.toMatchObject({
        items: [{ nativeSessionId: 'native-large', driverId: 'test-driver', connectionId: 'test-connection' }],
        total: 1,
        truncated: false,
      })
      await expect(Effect.runPromise(store.listPendingRuntimeRequests(task.id, 0, 50))).resolves.toMatchObject({
        total: 8,
        hasMore: false,
      })
      const pendingRequests = await Effect.runPromise(store.listPendingRuntimeRequests(task.id, 0, 50))
      expect(pendingRequests.items[0]?.request).toMatchObject({ requestId: 'large-request-0', prompt: 'Answer?' })
      let transcriptCursor = 0
      let transcriptWatermark: number | undefined
      const transcriptEvents: Array<number> = []
      let transcriptUserPrompt: string | undefined
      let transcriptBytes = 0
      while (true) {
        const page = await Effect.runPromise(
          store.readConversationPage(conversation.id, transcriptCursor, 500, transcriptWatermark),
        )
        transcriptWatermark ??= page.highWatermark
        expect(page.highWatermark).toBe(transcriptWatermark)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(3 * 1024 * 1024)
        transcriptBytes += Buffer.byteLength(JSON.stringify(page))
        transcriptEvents.push(...page.items.map(item => item.event.sequence))
        transcriptUserPrompt ??= page.items.find(item => item.userMessage)?.userMessage?.content
        if (!page.hasMore) break
        transcriptCursor = page.nextAfterSequence ?? transcriptCursor
      }
      expect(transcriptBytes).toBeGreaterThan(4 * 1024 * 1024)
      const replayEvents: Array<number> = []
      let replayBytes = 0
      let replayCursor = 0
      while (true) {
        const page = await Effect.runPromise(store.pageEvents(replayCursor, 500, transcriptWatermark))
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(3 * 1024 * 1024)
        replayBytes += Buffer.byteLength(JSON.stringify(page))
        replayEvents.push(...page.events.map(event => event.sequence))
        if (!page.hasMore) break
        expect(page.events.length).toBeGreaterThan(0)
        expect(page.nextAfterSequence).not.toBeNull()
        replayCursor = page.nextAfterSequence ?? 0
      }
      expect(replayBytes).toBeGreaterThan(4 * 1024 * 1024)
      expect(replayEvents).toEqual(transcriptEvents)
      expect(transcriptEvents.length).toBeGreaterThan(6)
      expect(new Set(transcriptEvents).size).toBe(transcriptEvents.length)
      expect(transcriptUserPrompt).toBe(beginRun.prompt)
      const snapshot = await Effect.runPromise(store.readTaskSnapshot(task.id, 10))
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(2 * 1024 * 1024)
      expect(snapshot.requestResponseSummary).toMatchObject({ total: 8, truncated: true, pendingCount: 8 })
      expect(snapshot.steerIntentSummary).toMatchObject({ total: 8, truncated: true, pendingCount: 8 })
      expect(snapshot.queuedFollowUps).toHaveLength(5)
      expect(snapshot.queuedFollowUps?.[0]).toMatchObject({ promptByteLength: 900 * 1024 })
      expect(snapshot.queuedFollowUps?.[0]).not.toHaveProperty('prompt')
      const firstResponse = await Effect.runPromise(store.listRequestResponses(task.id, { limit: 1 }))
      expect(firstResponse.items[0]?.decision).toMatchObject({
        kind: 'answers',
        answers: { answer: 'r'.repeat(700 * 1024) },
      })
      const firstSteer = await Effect.runPromise(store.listSteerIntents(task.id, { limit: 1 }))
      expect(firstSteer.items[0]?.message).toHaveLength(700 * 1024)
      await expect(Effect.runPromise(store.listQueuedFollowUps(conversation.id, { limit: 51 }))).rejects.toMatchObject({
        code: 'invalid-data',
      })
      const queueIds: Array<string> = []
      let queueCursor: number | null = 0
      while (queueCursor !== null) {
        const page: QueuedFollowUpPage = await Effect.runPromise(
          store.listQueuedFollowUps(conversation.id, { afterPosition: queueCursor, limit: 50 }),
        )
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2 * 1024 * 1024)
        expect(page.items.length).toBeGreaterThan(0)
        expect(page.items[0]?.prompt).toHaveLength(900 * 1024)
        queueIds.push(...page.items.map(item => item.commandId))
        queueCursor = page.nextAfterPosition
      }
      expect(queueIds).toEqual(['large-queue-0', 'large-queue-1', 'large-queue-2', 'large-queue-3', 'large-queue-4'])
      const historyReaders: ReadonlyArray<
        (options: { afterPosition: number; limit: number }) => Effect.Effect<
          {
            readonly items: ReadonlyArray<{ readonly commandId: string }>
            readonly nextAfterPosition: number | null
          },
          WorkspaceStoreError
        >
      > = [options => store.listRequestResponses(task.id, options), options => store.listSteerIntents(task.id, options)]
      for (const list of historyReaders) {
        const ids: Array<string> = []
        let cursor: number | null = 0
        while (cursor !== null) {
          const page: {
            readonly items: ReadonlyArray<{ readonly commandId: string }>
            readonly nextAfterPosition: number | null
          } = await Effect.runPromise(list({ afterPosition: cursor, limit: 50 }))
          expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2 * 1024 * 1024)
          expect(page.items.length).toBeGreaterThan(0)
          ids.push(...page.items.map(item => item.commandId))
          cursor = page.nextAfterPosition
        }
        expect(ids).toHaveLength(8)
        expect(new Set(ids).size).toBe(8)
      }
    })
  }, 20_000)

  it('round-trips durable responses, steering and the queue through a real worker and reopen', async () => {
    const filename = join(fixtureDirectory, 'delivery-queue.db')
    const queued = {
      commandId: 'queue-worker',
      taskId: task.id,
      conversationId: conversation.id,
      prompt: 'Queued first',
      modelId: 'queued-model',
      issuedAt: timestamp,
    }
    const response = {
      commandId: 'respond-worker',
      runId: beginRun.runId,
      ownerEpoch: 7,
      generation: 1,
      requestId: 'approval-worker',
      decision: { kind: 'approve' as const },
      issuedAt: timestamp,
    }
    const steer = {
      commandId: 'steer-worker',
      runId: beginRun.runId,
      ownerEpoch: 7,
      generation: 1,
      message: 'Please focus',
      issuedAt: timestamp,
    }
    const retryMetadata = { ownerEpoch: 8, issuedAt: '2026-10-30T12:00:00Z' }
    await withStore(filename, async store => {
      await setup(store)
      await Effect.runPromise(store.enqueueFollowUp(queued))
      await Effect.runPromise(
        store.enqueueFollowUp({ ...queued, commandId: 'queue-worker-2', prompt: 'Queued second' }),
      )
    })
    await withStore(filename, async store => {
      expect(await Effect.runPromise(store.enqueueFollowUp({ ...queued, issuedAt: retryMetadata.issuedAt }))).toEqual({
        commandId: queued.commandId,
        conversationId: conversation.id,
        acceptedAt: timestamp,
        replayed: true,
      })
      expect((await Effect.runPromise(store.listQueuedFollowUps(conversation.id))).items).toMatchObject([
        { commandId: queued.commandId },
        { commandId: 'queue-worker-2' },
      ])
      await Effect.runPromise(store.cancelQueuedFollowUp(conversation.id, 'queue-worker-2'))
      const promoted = await Effect.runPromise(store.promoteNextFollowUp(conversation.id, beginRun))
      expect(promoted?.followUp.prompt).toBe('Queued first')
      const claim = await Effect.runPromise(store.claimDispatch(beginRun.runId, 7, timestamp))
      expect(claim).toMatchObject({ prompt: 'Queued first', modelId: 'queued-model' })
      await Effect.runPromise(
        store.acknowledgeDispatch(beginRun.runId, {
          ownerEpoch: 7,
          nativeSessionId: 'native-delivery',
          acknowledgedAt: timestamp,
        }),
      )
      await Effect.runPromise(
        store.recordDriverEvent(beginRun.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'request-worker',
          occurredAt: timestamp,
          event: {
            kind: 'requestPending',
            request: {
              runId: beginRun.runId,
              generation: 1,
              requestId: 'approval-worker',
              kind: 'approval',
              prompt: 'Allow?',
              questions: [],
            },
          },
        }),
      )
      expect(await Effect.runPromise(store.recordRequestResponse(response))).toMatchObject({ replayed: false })
      expect(await Effect.runPromise(store.recordRequestResponse({ ...response, ...retryMetadata }))).toEqual({
        commandId: response.commandId,
        runId: beginRun.runId,
        acceptedAt: timestamp,
        replayed: true,
      })
      await Effect.runPromise(
        store.settleRequestResponse(beginRun.runId, 'approval-worker', {
          ownerEpoch: 7,
          occurredAt: timestamp,
          outcome: 'uncertain',
        }),
      )
      expect(await Effect.runPromise(store.recordSteer(steer))).toMatchObject({ replayed: false })
      await Effect.runPromise(
        store.settleSteer(beginRun.runId, steer.commandId, {
          ownerEpoch: 7,
          occurredAt: timestamp,
          outcome: 'accepted',
          nativeConfirmation: 'unconfirmed',
        }),
      )
    })
    await withStore(filename, async store => {
      expect((await Effect.runPromise(store.listQueuedFollowUps(conversation.id))).items).toEqual([])
      expect(await Effect.runPromise(store.enqueueFollowUp({ ...queued, issuedAt: retryMetadata.issuedAt }))).toEqual({
        commandId: queued.commandId,
        conversationId: conversation.id,
        acceptedAt: timestamp,
        replayed: true,
      })
      const replay = await Effect.runPromise(
        store.promoteNextFollowUp(conversation.id, {
          ...beginRun,
          ...retryMetadata,
          runId: 'regenerated-promotion' as never,
          provisionalAgentSessionId: 'regenerated-session',
        }),
      )
      expect(replay).toEqual({
        followUp: { ...queued, position: 1 },
        receipt: {
          commandId: beginRun.commandId,
          runId: beginRun.runId,
          acceptedAt: beginRun.issuedAt,
          replayed: true,
        },
      })
      expect(await Effect.runPromise(store.recordRequestResponse({ ...response, ...retryMetadata }))).toEqual({
        commandId: response.commandId,
        runId: beginRun.runId,
        acceptedAt: timestamp,
        replayed: true,
      })
      expect(await Effect.runPromise(store.recordSteer({ ...steer, ...retryMetadata }))).toEqual({
        commandId: steer.commandId,
        runId: beginRun.runId,
        acceptedAt: timestamp,
        replayed: true,
      })
      await expect(Effect.runPromise(store.enqueueFollowUp({ ...queued, prompt: 'Different' }))).rejects.toMatchObject({
        code: 'command-conflict',
      })
      await expect(
        Effect.runPromise(
          store.promoteNextFollowUp(conversation.id, { ...beginRun, checkoutId: 'different-checkout' as never }),
        ),
      ).rejects.toMatchObject({ code: 'command-conflict' })
      await expect(
        Effect.runPromise(store.recordRequestResponse({ ...response, decision: { kind: 'deny' } })),
      ).rejects.toMatchObject({ code: 'command-conflict' })
      await expect(Effect.runPromise(store.recordSteer({ ...steer, message: 'Different' }))).rejects.toMatchObject({
        code: 'command-conflict',
      })

      expect(
        await Effect.runPromise(
          store.promoteNextFollowUp(conversation.id, {
            ...beginRun,
            commandId: 'no-double-promote',
            runId: 'run-no-double' as never,
          }),
        ),
      ).toBeNull()
      const snapshot = await Effect.runPromise(store.readTaskSnapshot(task.id, 10))
      expect(snapshot.requestResponses).toMatchObject([{ state: 'uncertain' }])
      expect(snapshot.steerIntents).toMatchObject([
        { state: 'accepted', delivery: { nativeConfirmation: 'unconfirmed' } },
      ])
      expect(snapshot.queuedFollowUps).toEqual([])
    })
  }, 20_000)

  it('runs the durable WorkspaceStore lifecycle through one bundled worker', async () => {
    const filename = join(fixtureDirectory, 'lifecycle.db')
    await withStore(filename, async store => {
      await setup(store)

      await expect(Effect.runPromise(store.beginRun(beginRun))).resolves.toMatchObject({ replayed: false })
      await expect(
        Effect.runPromise(
          store.beginRun({
            ...beginRun,
            issuedAt: '2026-10-30T12:00:00Z',
            runId: 'regenerated-worker-run' as never,
            provisionalAgentSessionId: 'regenerated-worker-session',
          }),
        ),
      ).resolves.toEqual({
        commandId: beginRun.commandId,
        runId: beginRun.runId,
        acceptedAt: beginRun.issuedAt,
        replayed: true,
      })
      await expect(
        Effect.runPromise(store.beginRun({ ...beginRun, prompt: 'Different intent' })),
      ).rejects.toMatchObject({ code: 'command-conflict' })
      const claim = await Effect.runPromise(store.claimDispatch(beginRun.runId, 7, '2026-10-29T10:00:02Z'))
      expect(claim).toMatchObject({ runId: beginRun.runId, ownerEpoch: 7, workspacePath: checkout.path })
      await Effect.runPromise(
        store.acknowledgeDispatch(beginRun.runId, {
          ownerEpoch: 7,
          nativeSessionId: 'native-session-worker',
          nativeTurnId: 'native-turn-worker',
          acknowledgedAt: '2026-10-29T10:00:03Z',
        }),
      )
      const event = await Effect.runPromise(
        store.recordDriverEvent(beginRun.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-complete-worker',
          occurredAt: '2026-10-29T10:00:04Z',
          event: { kind: 'turnCompleted', nativeTurnId: 'native-turn-worker' },
        }),
      )
      expect(event.kind).toBe('driverEvent')
      await expect(
        Effect.runPromise(store.beginRun({ ...beginRun, prompt: 'conflicting prompt' })),
      ).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'command-conflict',
        message: 'Workspace command conflicts with a prior operation.',
      })

      const page = await Effect.runPromise(store.pageEvents(0, 20))
      const snapshot = await Effect.runPromise(store.readTaskSnapshot(task.id, 10))
      expect(page.events.map(entry => entry.kind)).toEqual([
        'runQueued',
        'dispatchClaimed',
        'runStarted',
        'driverEvent',
      ])
      expect(snapshot.runs).toMatchObject([expect.objectContaining({ id: beginRun.runId, status: 'completed' })])
    })
  }, 20_000)

  it('requires explicit replacement and recovers an unresolved epoch-7 dispatch without re-dispatch', async () => {
    const filename = join(fixtureDirectory, 'recovery.db')
    const first = makeRuntime(filename)
    try {
      const store = await first.runtime.runPromise(WorkspaceStore)
      await setup(store)
      await Effect.runPromise(store.beginRun(beginRun))
      await Effect.runPromise(store.claimDispatch(beginRun.runId, 7, '2026-10-29T10:00:02Z'))
      expect(first.workers).toHaveLength(1)
      const firstWorker = first.workers[0]
      if (!firstWorker) throw new Error('workspace worker was not created')
      await firstWorker.terminate()
      await first.runtime.dispose()

      const replacement = makeRuntime(filename)
      try {
        const recoveredStore = await replacement.runtime.runPromise(WorkspaceStore)
        expect(replacement.workers).toHaveLength(1)
        await expect(Effect.runPromise(recoveredStore.recoverWorker(7, '2026-10-29T10:00:03Z'))).resolves.toBe(1)
        expect(
          await Effect.runPromise(
            recoveredStore.beginRun({
              ...beginRun,
              issuedAt: '2026-10-30T12:00:00Z',
              runId: 'regenerated-after-replacement' as never,
              provisionalAgentSessionId: 'regenerated-session-after-replacement',
            }),
          ),
        ).toEqual({
          commandId: beginRun.commandId,
          runId: beginRun.runId,
          acceptedAt: beginRun.issuedAt,
          replayed: true,
        })

        const snapshot = await Effect.runPromise(recoveredStore.readTaskSnapshot(task.id, 10))
        expect(snapshot.runs).toMatchObject([expect.objectContaining({ id: beginRun.runId, status: 'uncertain' })])
        expect(replacement.workers).toHaveLength(1)
      } finally {
        await replacement.runtime.dispose()
      }
    } finally {
      await first.runtime.dispose()
    }
  }, 20_000)

  it('bounds startup failure and exposes only a sanitized transport error', async () => {
    const missingWorkerPath = join(fixtureDirectory, 'missing-workspace-worker.mjs')
    const { runtime } = makeRuntime(join(fixtureDirectory, 'boot-failure.db'), {
      workerPath: missingWorkerPath,
      initializationTimeoutMs: 1_000,
    })
    const startedAt = Date.now()
    try {
      await expect(runtime.runPromise(WorkspaceStore)).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'database-unavailable',
        message: 'Workspace storage is unavailable.',
      })
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    } finally {
      await runtime.dispose()
    }
  }, 10_000)

  it('bounds the full acquisition when a live worker never completes its protocol handshake', async () => {
    const { runtime, workers } = makeRuntime(join(fixtureDirectory, 'silent-startup.db'), {
      initializationTimeoutMs: 100,
      workerFactory: () => new Worker('setInterval(() => {}, 1_000)', { eval: true }),
    })
    const startedAt = Date.now()
    const opening = runtime.runPromise(WorkspaceStore)
    try {
      const outcome = await Promise.race([
        opening.then(
          () => ({ status: 'resolved' as const }),
          error => ({ status: 'rejected' as const, error }),
        ),
        new Promise<{ readonly status: 'guard-timeout' }>(resolve =>
          setTimeout(() => resolve({ status: 'guard-timeout' }), 1_500),
        ),
      ])
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') {
        expect(outcome.error).toMatchObject({
          _tag: 'WorkspaceStoreError',
          code: 'database-unavailable',
          message: 'Workspace storage is unavailable.',
        })
      }
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(workers[0]?.threadId).toBe(-1)
    } finally {
      const worker = workers[0]
      if (worker && worker.threadId !== -1) await worker.terminate()
      await opening.catch(() => {})
      await runtime.dispose()
    }
  }, 5_000)

  it('forces termination within the close deadline when the worker ignores protocol close', async () => {
    const { runtime, workers } = makeRuntime(join(fixtureDirectory, 'ignored-close.db'), {
      workerPath: shutdownIgnoringWorkerPath,
      closeTimeoutMs: 100,
    })
    await runtime.runPromise(WorkspaceStore)
    const worker = workers[0]
    if (!worker) throw new Error('workspace worker was not created')

    const startedAt = Date.now()
    const closing = runtime.dispose()
    try {
      const outcome = await Promise.race([
        closing.then(
          () => ({ status: 'resolved' as const }),
          error => ({ status: 'rejected' as const, error }),
        ),
        new Promise<{ readonly status: 'guard-timeout' }>(resolve =>
          setTimeout(() => resolve({ status: 'guard-timeout' }), 1_500),
        ),
      ])
      expect(outcome.status).toBe('resolved')
      expect(Date.now() - startedAt).toBeLessThan(600)
      expect(worker.threadId).toBe(-1)
    } finally {
      if (worker.threadId !== -1) await worker.terminate()
      await closing.catch(() => {})
    }
  }, 5_000)

  it('reports a typed cleanup error when forced native termination cannot be confirmed', async () => {
    const terminateNative: Array<() => Promise<number>> = []
    const { runtime, workers } = makeRuntime(join(fixtureDirectory, 'unresolved-close.db'), {
      workerPath: shutdownIgnoringWorkerPath,
      closeTimeoutMs: 100,
      workerFactory: path => {
        const worker = new Worker(path)
        terminateNative.push(worker.terminate.bind(worker))
        worker.terminate = () => new Promise<number>(() => {})
        return worker
      },
    })
    await runtime.runPromise(WorkspaceStore)
    const worker = workers[0]
    if (!worker) throw new Error('workspace worker was not created')

    const startedAt = Date.now()
    const closing = runtime.dispose()
    try {
      const outcome = await Promise.race([
        closing.then(
          () => ({ status: 'resolved' as const }),
          error => ({ status: 'rejected' as const, error }),
        ),
        new Promise<{ readonly status: 'guard-timeout' }>(resolve =>
          setTimeout(() => resolve({ status: 'guard-timeout' }), 1_500),
        ),
      ])
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') {
        expect(outcome.error).toMatchObject({
          _tag: 'WorkspaceStoreError',
          code: 'database-unavailable',
          message: 'Workspace worker cleanup did not complete.',
        })
      }
      expect(Date.now() - startedAt).toBeLessThan(600)
    } finally {
      if (worker.threadId !== -1) await terminateNative[0]?.()
      await closing.catch(() => {})
    }
  }, 5_000)

  it('rejects invalid and oversized requests, bounds concurrency, and keeps the worker usable', async () => {
    const { runtime } = makeRuntime(join(fixtureDirectory, 'limits.db'))
    try {
      const store = await runtime.runPromise(WorkspaceStore)
      await setup(store)

      await expect(Effect.runPromise(store.pageEvents(-1, 20))).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'invalid-data',
      })
      await expect(
        Effect.runPromise(store.beginRun({ ...beginRun, prompt: 'x'.repeat(1_100_000) })),
      ).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'database-unavailable',
        message: 'Workspace worker request limit exceeded.',
      })

      const requests = Array.from({ length: 65 }, () => Effect.runPromise(store.pageEvents(0, 500)))
      const results = await Promise.allSettled(requests)
      expect(
        results.some(
          result =>
            result.status === 'rejected' &&
            result.reason instanceof Error &&
            'message' in result.reason &&
            result.reason.message === 'Workspace worker request limit exceeded.',
        ),
      ).toBe(true)
      await expect(Effect.runPromise(store.readTaskSnapshot(task.id, 10))).resolves.toMatchObject({
        task: { id: task.id },
      })
    } finally {
      await runtime.dispose()
    }
  }, 20_000)
})
