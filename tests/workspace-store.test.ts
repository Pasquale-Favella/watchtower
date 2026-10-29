import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as SqlClient from 'effect/sql/SqlClient'
import { describe, expect, it } from 'vitest'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import type { BeginRunCommand } from '@/shared/schemas/workspace-store.js'

type RunEffect = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>

const project = {
  id: 'p-1' as never,
  name: 'Project',
  repositoryIdentity: 'repo:one',
  createdAt: '2026-10-29T10:00:00Z',
  updatedAt: '2026-10-29T10:00:00Z',
}
const checkout = { id: 'co-1' as never, kind: 'main' as const, path: 'C:/repo', createdAt: '2026-10-29T10:00:00Z' }
const task = {
  id: 't-1' as never,
  projectId: project.id,
  title: 'Task',
  description: '',
  createdAt: '2026-10-29T10:00:00Z',
}
const conversation = { id: 'c-1' as never, title: 'Conversation', createdAt: '2026-10-29T10:00:00Z' }
const command: BeginRunCommand = {
  commandId: 'cmd-1',
  issuedAt: '2026-10-29T10:00:01Z',
  runId: 'run-1' as never,
  taskId: task.id,
  conversationId: conversation.id,
  checkoutId: checkout.id,
  provisionalAgentSessionId: 'session-1',
  generation: 1,
  driverId: 'codex',
  connectionId: 'conn-1',
  prompt: 'Fix the bug',
}

const withStore = async (use: (store: WorkspaceStore['Service'], run: RunEffect) => Promise<void>) => {
  const runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
  try {
    await use(await runtime.runPromise(WorkspaceStore), effect => runtime.runPromise(effect))
  } finally {
    await runtime.dispose()
  }
}

const setup = async (store: WorkspaceStore['Service'], run: RunEffect) => {
  await run(store.registerProject({ project, mainCheckout: checkout }))
  await run(store.createTask({ task, conversation }))
}

const acceptRun = async (
  store: WorkspaceStore['Service'],
  run: RunEffect,
  runCommand: BeginRunCommand = command,
  ownerEpoch = 7,
) => {
  await run(store.beginRun(runCommand))
  await run(store.claimDispatch(runCommand.runId, ownerEpoch, '2026-10-29T10:00:02Z'))
  await run(
    store.acknowledgeDispatch(runCommand.runId, {
      ownerEpoch,
      nativeSessionId: 'native-session-1',
      nativeTurnId: 'native-turn-1',
      acknowledgedAt: '2026-10-29T10:00:03Z',
    }),
  )
}

describe('WorkspaceStore', () => {
  it('recovers pending deliveries on an already terminal run', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await acceptRun(store, run)
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'terminal-pending',
          occurredAt: command.issuedAt,
          event: {
            kind: 'requestPending',
            request: {
              runId: command.runId,
              requestId: 'terminal-request',
              generation: 1,
              kind: 'approval',
              prompt: 'Allow?',
              questions: [],
            },
          },
        }),
      )
      await run(
        store.recordRequestResponse({
          commandId: 'terminal-response',
          issuedAt: command.issuedAt,
          runId: command.runId,
          ownerEpoch: 7,
          generation: 1,
          requestId: 'terminal-request',
          decision: { kind: 'approve' },
        }),
      )
      await run(
        store.recordSteer({
          commandId: 'terminal-steer',
          issuedAt: command.issuedAt,
          runId: command.runId,
          ownerEpoch: 7,
          generation: 1,
          message: 'Focus',
        }),
      )
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'terminal-completed',
          occurredAt: command.issuedAt,
          event: { kind: 'turnCompleted' },
        }),
      )
      expect(await run(store.recoverWorker(7, command.issuedAt))).toBe(0)
      const snapshot = await run(store.readTaskSnapshot(task.id, 10))
      expect(snapshot.runs).toMatchObject([{ status: 'completed' }])
      expect(snapshot.requestResponses).toMatchObject([{ state: 'uncertain', recoveryReason: 'worker-replaced' }])
      expect(snapshot.steerIntents).toMatchObject([{ state: 'uncertain', recoveryReason: 'worker-replaced' }])
      expect(snapshot.requestResponseSummary).toMatchObject({ pendingCount: 0, uncertainCount: 1 })
      expect(snapshot.steerIntentSummary).toMatchObject({ pendingCount: 0, uncertainCount: 1 })
    })
  })

  it('prioritizes unresolved deliveries in bounded snapshots while cursor pages retain complete history', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await acceptRun(store, run)
      for (let index = 0; index < 6; index += 1) {
        await run(
          store.recordDriverEvent(command.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: `priority-pending-${index}`,
            occurredAt: command.issuedAt,
            event: {
              kind: 'requestPending',
              request: {
                runId: command.runId,
                requestId: `priority-request-${index}`,
                generation: 1,
                kind: 'approval',
                prompt: 'Allow?',
                questions: [],
              },
            },
          }),
        )
        await run(
          store.recordRequestResponse({
            commandId: `priority-response-${index}`,
            issuedAt: command.issuedAt,
            runId: command.runId,
            ownerEpoch: 7,
            generation: 1,
            requestId: `priority-request-${index}`,
            decision: { kind: 'approve' },
          }),
        )
        await run(
          store.recordSteer({
            commandId: `priority-steer-${index}`,
            issuedAt: command.issuedAt,
            runId: command.runId,
            ownerEpoch: 7,
            generation: 1,
            message: 'Focus',
          }),
        )
        if (index > 0) {
          const outcome = {
            ownerEpoch: 7,
            occurredAt: command.issuedAt,
            outcome: index === 1 ? ('uncertain' as const) : ('accepted' as const),
          }
          await run(store.settleRequestResponse(command.runId, `priority-request-${index}`, outcome))
          await run(store.settleSteer(command.runId, `priority-steer-${index}`, outcome))
        }
      }
      const snapshot = await run(store.readTaskSnapshot(task.id, 2))
      expect(snapshot.requestResponses).toMatchObject([
        { commandId: 'priority-response-0', state: 'pending' },
        { commandId: 'priority-response-1', state: 'uncertain' },
      ])
      expect(snapshot.steerIntents).toMatchObject([
        { commandId: 'priority-steer-0', state: 'pending' },
        { commandId: 'priority-steer-1', state: 'uncertain' },
      ])
      expect(snapshot.requestResponseSummary).toMatchObject({
        total: 6,
        truncated: true,
        pendingCount: 1,
        uncertainCount: 1,
      })
      const first = await run(store.listRequestResponses(task.id, { limit: 2 }))
      expect(first.items.map(item => item.commandId)).toEqual(['priority-response-0', 'priority-response-1'])
      expect(first).toMatchObject({ total: 6, truncated: true })
      if (first.nextAfterPosition === null) throw new Error('Expected a response history cursor')
      const second = await run(
        store.listRequestResponses(task.id, { afterPosition: first.nextAfterPosition, limit: 50 }),
      )
      expect(second.items.map(item => item.commandId)).toEqual([
        'priority-response-2',
        'priority-response-3',
        'priority-response-4',
        'priority-response-5',
      ])
      expect(second).toMatchObject({ total: 6, truncated: false, nextAfterPosition: null })
      for (const options of [{ afterPosition: -1 }, { afterPosition: 0.5 }, { limit: 0 }, { limit: 51 }]) {
        await expect(run(store.listQueuedFollowUps(conversation.id, options))).rejects.toMatchObject({
          code: 'invalid-data',
        })
        await expect(run(store.listRequestResponses(task.id, options))).rejects.toMatchObject({ code: 'invalid-data' })
        await expect(run(store.listSteerIntents(task.id, options))).rejects.toMatchObject({ code: 'invalid-data' })
      }
    })
  })

  it.each(['memory', 'file'] as const)(
    'recovers pending deliveries as uncertain without resending (%s)',
    async storage => {
      const directory = storage === 'file' ? mkdtempSync(join(process.cwd(), '.workspace-recovery-')) : undefined
      const filename = directory ? join(directory, 'workspace.db') : ':memory:'
      let runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
      try {
        let store = await runtime.runPromise(WorkspaceStore)
        let run: RunEffect = effect => runtime.runPromise(effect)
        await setup(store, run)
        await acceptRun(store, run)
        await run(
          store.recordDriverEvent(command.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: 'pending-recovery',
            occurredAt: command.issuedAt,
            event: {
              kind: 'requestPending',
              request: {
                runId: command.runId,
                requestId: 'recovery-request',
                generation: 1,
                kind: 'approval',
                prompt: 'Allow?',
                questions: [],
              },
            },
          }),
        )
        await run(
          store.recordRequestResponse({
            commandId: 'recovery-response',
            issuedAt: command.issuedAt,
            runId: command.runId,
            ownerEpoch: 7,
            generation: 1,
            requestId: 'recovery-request',
            decision: { kind: 'approve' },
          }),
        )
        await run(
          store.recordSteer({
            commandId: 'recovery-steer',
            issuedAt: command.issuedAt,
            runId: command.runId,
            ownerEpoch: 7,
            generation: 1,
            message: 'Focus',
          }),
        )
        if (directory) {
          await runtime.dispose()
          runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
          store = await runtime.runPromise(WorkspaceStore)
          run = effect => runtime.runPromise(effect)
        }
        await run(store.recoverWorker(7, command.issuedAt))
        const snapshot = await run(store.readTaskSnapshot(task.id, 10))
        expect(snapshot.requestResponses).toMatchObject([
          { state: 'uncertain', delivery: { outcome: 'uncertain' }, recoveryReason: 'worker-replaced' },
        ])
        expect(snapshot.steerIntents).toMatchObject([
          { state: 'uncertain', delivery: { outcome: 'uncertain' }, recoveryReason: 'worker-replaced' },
        ])
        expect(
          [...(snapshot.requestResponses ?? []), ...(snapshot.steerIntents ?? [])].some(
            intent => intent.state === 'pending',
          ),
        ).toBe(false)
        const page = await run(store.pageEvents(0, 100))
        expect(
          page.events.filter(event => event.kind === 'requestResponseSettled' || event.kind === 'steerSettled'),
        ).toMatchObject([
          { data: { outcome: 'uncertain', reason: 'worker-replaced' } },
          { data: { outcome: 'uncertain', reason: 'worker-replaced' } },
        ])
        await run(store.recoverWorker(7, command.issuedAt))
        expect((await run(store.pageEvents(0, 100))).highWatermark).toBe(page.highWatermark)
        if (directory) {
          await runtime.dispose()
          runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
          store = await runtime.runPromise(WorkspaceStore)
          run = effect => runtime.runPromise(effect)
          expect((await run(store.readTaskSnapshot(task.id, 10))).requestResponses).toMatchObject([
            { state: 'uncertain' },
          ])
        }
      } finally {
        await runtime.dispose()
        if (directory) rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('fences response and steering intent delivery and reconciles a late native resolution', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await acceptRun(store, run)
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'approval-pending',
          occurredAt: command.issuedAt,
          event: {
            kind: 'requestPending',
            request: {
              runId: command.runId,
              requestId: 'approval',
              generation: 1,
              kind: 'approval',
              prompt: 'Allow?',
              questions: [],
            },
          },
        }),
      )
      const response = {
        commandId: 'respond-epoch',
        issuedAt: command.issuedAt,
        runId: command.runId,
        ownerEpoch: 7,
        generation: 1,
        requestId: 'approval',
        decision: { kind: 'approve' as const },
      }
      const steer = {
        commandId: 'steer-epoch',
        issuedAt: command.issuedAt,
        runId: command.runId,
        ownerEpoch: 7,
        generation: 1,
        message: 'Focus',
      }
      await expect(run(store.recordRequestResponse({ ...response, ownerEpoch: 6 }))).rejects.toMatchObject({
        code: 'stale-epoch',
      })
      await expect(run(store.recordSteer({ ...steer, ownerEpoch: 6 }))).rejects.toMatchObject({ code: 'stale-epoch' })
      await expect(run(store.recordSteer({ ...steer, generation: 2 }))).rejects.toMatchObject({
        code: 'membership-conflict',
      })
      await expect(run(store.recordSteer({ ...steer, expectedNativeTurnId: 'wrong-turn' }))).rejects.toMatchObject({
        code: 'membership-conflict',
      })
      await run(store.recordRequestResponse(response))
      await run(store.recordSteer(steer))
      const accepted = {
        ownerEpoch: 7,
        occurredAt: command.issuedAt,
        outcome: 'accepted' as const,
        nativeConfirmation: 'confirmed' as const,
      }
      await expect(
        run(store.settleRequestResponse(command.runId, 'approval', { ...accepted, ownerEpoch: 6 })),
      ).rejects.toMatchObject({ code: 'stale-epoch' })
      await expect(
        run(store.settleSteer(command.runId, steer.commandId, { ...accepted, ownerEpoch: 6 })),
      ).rejects.toMatchObject({ code: 'stale-epoch' })
      await run(store.settleRequestResponse(command.runId, 'approval', accepted))
      await run(store.settleRequestResponse(command.runId, 'approval', accepted))
      await run(store.settleSteer(command.runId, steer.commandId, { ...accepted, outcome: 'failed' }))
      const high = (await run(store.pageEvents(0, 100))).highWatermark
      await run(store.settleSteer(command.runId, steer.commandId, { ...accepted, outcome: 'failed' }))
      expect((await run(store.pageEvents(0, 100))).highWatermark).toBe(high)
      await expect(
        run(store.settleRequestResponse(command.runId, 'approval', { ...accepted, outcome: 'uncertain' })),
      ).rejects.toMatchObject({ code: 'invalid-transition' })
      await expect(run(store.settleSteer(command.runId, steer.commandId, accepted))).rejects.toMatchObject({
        code: 'invalid-transition',
      })
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'approval-resolved',
          occurredAt: command.issuedAt,
          event: { kind: 'requestResolved', requestId: 'approval', decision: { kind: 'approve' } },
        }),
      )
      const snapshot = await run(store.readTaskSnapshot(task.id, 10))
      expect(snapshot.requestResponses).toMatchObject([
        { state: 'resolved', delivery: { outcome: 'accepted', nativeConfirmation: 'confirmed' } },
      ])
      expect(snapshot.steerIntents).toMatchObject([{ state: 'failed' }])
      expect(await run(store.recordRequestResponse(response))).toMatchObject({ replayed: true })
    })
  })

  it.each(['unknown', 'generation', 'resolved', 'expired'] as const)(
    'rejects a stale %s approval without recording an intent',
    async reason => {
      await withStore(async (store, run) => {
        await setup(store, run)
        await acceptRun(store, run)
        if (reason !== 'unknown') {
          await run(
            store.recordDriverEvent(command.runId, {
              ownerEpoch: 7,
              generation: 1,
              eventId: 'pending',
              occurredAt: command.issuedAt,
              event: {
                kind: 'requestPending',
                request: {
                  runId: command.runId,
                  requestId: 'approval',
                  generation: 1,
                  kind: 'approval',
                  prompt: 'Allow?',
                  questions: [],
                },
              },
            }),
          )
        }
        if (reason === 'resolved') {
          await run(
            store.recordDriverEvent(command.runId, {
              ownerEpoch: 7,
              generation: 1,
              eventId: 'resolved',
              occurredAt: command.issuedAt,
              event: { kind: 'requestResolved', requestId: 'approval', decision: { kind: 'approve' } },
            }),
          )
        }
        if (reason === 'expired') {
          await run(
            store.recordDriverEvent(command.runId, {
              ownerEpoch: 7,
              generation: 1,
              eventId: 'complete',
              occurredAt: command.issuedAt,
              event: { kind: 'turnCompleted' },
            }),
          )
        }
        await expect(
          run(
            store.recordRequestResponse({
              commandId: 'respond-stale',
              issuedAt: command.issuedAt,
              runId: command.runId,
              ownerEpoch: 7,
              generation: reason === 'generation' ? 2 : 1,
              requestId: 'approval',
              decision: { kind: 'approve' },
            }),
          ),
        ).rejects.toMatchObject({ code: 'stale-request' })
        expect((await run(store.readTaskSnapshot(task.id, 10))).requestResponses).toEqual([])
      })
    },
  )

  it('rejects steering on a run that failed before a native session existed', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await run(store.beginRun(command))
      await run(
        store.failDispatch(command.runId, {
          ownerEpoch: 7,
          occurredAt: command.issuedAt,
          outcome: 'failed',
          reason: 'launch-failed',
        }),
      )
      await expect(
        run(
          store.recordSteer({
            commandId: 'steer-failed',
            issuedAt: command.issuedAt,
            runId: command.runId,
            ownerEpoch: 7,
            generation: 1,
            message: 'Continue',
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-transition' })
    })
  })

  it('preserves ordered queued follow-ups across file-backed reopen and rolls back failed promotion', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.workspace-queue-'))
    const filename = join(directory, 'workspace.db')
    let runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
    try {
      let store = await runtime.runPromise(WorkspaceStore)
      let run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const followUp = {
        commandId: 'queue-reopen-1',
        taskId: task.id,
        conversationId: conversation.id,
        prompt: 'First',
        issuedAt: command.issuedAt,
        modelId: 'explicit-model',
        modeId: null,
      }
      await run(store.enqueueFollowUp(followUp))
      await run(store.enqueueFollowUp({ ...followUp, commandId: 'queue-reopen-2', prompt: 'Second' }))
      await expect(run(store.enqueueFollowUp({ ...followUp, prompt: 'Conflicting' }))).rejects.toMatchObject({
        code: 'command-conflict',
      })
      await runtime.dispose()
      runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
      store = await runtime.runPromise(WorkspaceStore)
      run = effect => runtime.runPromise(effect)
      expect((await run(store.listQueuedFollowUps(conversation.id))).items).toMatchObject([
        { prompt: 'First' },
        { prompt: 'Second' },
      ])
      expect((await run(store.readTaskSnapshot(task.id, 10))).queuedFollowUps).toHaveLength(2)
      await expect(
        run(store.promoteNextFollowUp(conversation.id, { ...command, checkoutId: 'missing' as never })),
      ).rejects.toMatchObject({ code: 'not-found' })
      expect((await run(store.listQueuedFollowUps(conversation.id))).items).toHaveLength(2)
      const promoted = await run(
        store.promoteNextFollowUp(conversation.id, { ...command, nativeSessionId: 'native-existing' }),
      )
      expect(promoted?.followUp.commandId).toBe(followUp.commandId)
      await runtime.dispose()
      runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
      store = await runtime.runPromise(WorkspaceStore)
      run = effect => runtime.runPromise(effect)
      expect(
        await run(store.promoteNextFollowUp(conversation.id, { ...command, commandId: 'cannot-promote-twice' })),
      ).toBeNull()
      expect((await run(store.listQueuedFollowUps(conversation.id))).items).toMatchObject([{ prompt: 'Second' }])
      const claim = await run(store.claimDispatch(command.runId, 7, command.issuedAt))
      expect(claim).toMatchObject({
        prompt: 'First',
        modelId: 'explicit-model',
        modeId: null,
        nativeSessionId: 'native-existing',
      })
      await run(store.cancelQueuedFollowUp(conversation.id, 'queue-reopen-2'))
      expect(
        await run(store.enqueueFollowUp({ ...followUp, commandId: 'queue-reopen-2', prompt: 'Second' })),
      ).toMatchObject({ replayed: true })
      expect((await run(store.listQueuedFollowUps(conversation.id))).items).toEqual([])
    } finally {
      await runtime.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('records steering before delivery and rejects a terminal run', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await acceptRun(store, run)
      const steer = {
        commandId: 'steer-1',
        runId: command.runId,
        ownerEpoch: 7,
        generation: 1,
        expectedNativeTurnId: 'native-turn-1',
        message: 'Focus on tests',
        issuedAt: command.issuedAt,
      }
      expect(await run(store.recordSteer(steer))).toMatchObject({ replayed: false })
      expect(await run(store.recordSteer(steer))).toMatchObject({ replayed: true })
      await run(
        store.settleSteer(command.runId, steer.commandId, {
          ownerEpoch: 7,
          occurredAt: command.issuedAt,
          outcome: 'accepted',
          nativeConfirmation: 'unconfirmed',
        }),
      )
      expect((await run(store.readTaskSnapshot(task.id, 20))).steerIntents).toMatchObject([
        { state: 'accepted', delivery: { nativeConfirmation: 'unconfirmed' } },
      ])
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'completed',
          occurredAt: command.issuedAt,
          event: { kind: 'turnCompleted' },
        }),
      )
      await expect(run(store.recordSteer({ ...steer, commandId: 'steer-2' }))).rejects.toMatchObject({
        code: 'invalid-transition',
      })
    })
  })

  it('promotes only one queued follow-up atomically and blocks promotion while a run is active', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      const followUp = {
        commandId: 'queue-1',
        taskId: task.id,
        conversationId: conversation.id,
        prompt: 'Follow up',
        issuedAt: command.issuedAt,
      }
      expect(await run(store.enqueueFollowUp(followUp))).toMatchObject({ replayed: false })
      expect(await run(store.enqueueFollowUp(followUp))).toMatchObject({ replayed: true })
      await run(store.enqueueFollowUp({ ...followUp, commandId: 'queue-2', prompt: 'Second' }))
      const promoted = await Promise.all([
        run(store.promoteNextFollowUp(conversation.id, command)),
        run(store.promoteNextFollowUp(conversation.id, { ...command, runId: 'run-2' as never, commandId: 'start-2' })),
      ])
      expect(promoted.filter(Boolean)).toHaveLength(1)
      expect((await run(store.readTaskSnapshot(task.id, 20))).runs).toMatchObject([{ status: 'queued' }])
      expect((await run(store.listQueuedFollowUps(conversation.id))).items).toMatchObject([
        { commandId: 'queue-2', prompt: 'Second' },
      ])
      expect(await run(store.promoteNextFollowUp(conversation.id, { ...command, commandId: 'start-3' }))).toBeNull()
      await run(store.cancelQueuedFollowUp(conversation.id, 'queue-2'))
      expect((await run(store.listQueuedFollowUps(conversation.id))).items).toEqual([])
    })
  })

  it('records a response before delivery, fences stale approvals and retains uncertainty', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await acceptRun(store, run)
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'approval',
          occurredAt: command.issuedAt,
          event: {
            kind: 'requestPending',
            request: {
              requestId: 'approval-1',
              runId: command.runId,
              generation: 1,
              kind: 'approval',
              prompt: 'Approve',
              questions: [],
            },
          },
        }),
      )
      const response = {
        commandId: 'respond-1',
        runId: command.runId,
        ownerEpoch: 7,
        generation: 1,
        requestId: 'approval-1',
        decision: { kind: 'approve' as const },
        issuedAt: command.issuedAt,
      }
      expect(await run(store.recordRequestResponse(response))).toMatchObject({ replayed: false })
      expect((await run(store.readTaskSnapshot(task.id, 20))).requestResponses).toMatchObject([{ state: 'pending' }])
      expect(await run(store.recordRequestResponse(response))).toMatchObject({ replayed: true })
      await expect(run(store.recordRequestResponse({ ...response, decision: { kind: 'deny' } }))).rejects.toMatchObject(
        { code: 'command-conflict' },
      )
      await run(
        store.settleRequestResponse(command.runId, 'approval-1', {
          ownerEpoch: 7,
          occurredAt: command.issuedAt,
          outcome: 'uncertain',
        }),
      )
      expect((await run(store.readTaskSnapshot(task.id, 20))).requestResponses).toMatchObject([{ state: 'uncertain' }])
      await expect(run(store.recordRequestResponse({ ...response, commandId: 'respond-2' }))).rejects.toMatchObject({
        code: 'stale-request',
      })
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'resolved',
          occurredAt: command.issuedAt,
          event: { kind: 'requestResolved', requestId: 'approval-1', decision: { kind: 'approve' } },
        }),
      )
      await expect(run(store.recordRequestResponse({ ...response, commandId: 'respond-3' }))).rejects.toMatchObject({
        code: 'stale-request',
      })
    })
  })

  it('commits a run receipt, prompt, event and intent once, and replays only an exact command', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      expect(await run(store.beginRun(command))).toMatchObject({ commandId: 'cmd-1', runId: 'run-1', replayed: false })
      expect(await run(store.beginRun({ ...command, prompt: 'Fix the bug' }))).toMatchObject({ replayed: true })
      await expect(run(store.beginRun({ ...command, prompt: 'Different prompt' }))).rejects.toMatchObject({
        code: 'command-conflict',
      })
      const claim = await run(store.claimDispatch(command.runId, 7, '2026-10-29T10:00:02Z'))
      expect(claim.prompt).toBe('Fix the bug')
      expect(claim).toMatchObject({ projectId: project.id, workspacePath: checkout.path })
      await expect(run(store.claimDispatch(command.runId, 7, '2026-10-29T10:00:03Z'))).rejects.toMatchObject({
        code: 'admission-conflict',
      })
      expect(await run(store.recoverWorker(7, '2026-10-29T10:00:04Z'))).toBe(1)
      expect(await run(store.recoverWorker(7, '2026-10-29T10:00:05Z'))).toBe(0)
      const events = await run(store.pageEvents(0, 20))
      expect(events.events.map(event => event.kind)).toEqual(['runQueued', 'dispatchClaimed', 'runUncertain'])
      expect(events.highWatermark).toBe(3)
    })
  })

  it('rejects conflicting checkout starts while a dispatch remains unresolved', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await run(store.beginRun(command))
      await expect(
        run(store.beginRun({ ...command, commandId: 'cmd-2', runId: 'run-2' as never })),
      ).rejects.toMatchObject({ code: 'admission-conflict' })
    })
  })

  it('rejects concurrent starts for distinct checkouts with the same stored path', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      const otherProject = { ...project, id: 'p-2' as never, repositoryIdentity: 'repo:two' }
      const otherCheckout = { ...checkout, id: 'co-2' as never }
      const otherTask = { ...task, id: 't-2' as never, projectId: otherProject.id }
      const otherConversation = { ...conversation, id: 'c-2' as never }
      await run(store.registerProject({ project: otherProject, mainCheckout: otherCheckout }))
      await run(store.createTask({ task: otherTask, conversation: otherConversation }))
      await run(store.beginRun(command))

      await expect(
        run(
          store.beginRun({
            ...command,
            commandId: 'cmd-same-path',
            runId: 'run-same-path' as never,
            taskId: otherTask.id,
            conversationId: otherConversation.id,
            checkoutId: otherCheckout.id,
            provisionalAgentSessionId: 'session-same-path',
          }),
        ),
      ).rejects.toMatchObject({ code: 'admission-conflict' })
    })
  })

  it('reserves a provisional Agent Session before native acknowledgement across checkouts', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      const otherProject = { ...project, id: 'p-2' as never, repositoryIdentity: 'repo:two' }
      const otherCheckout = { ...checkout, id: 'co-2' as never, path: 'C:/other-repo' }
      const otherTask = { ...task, id: 't-2' as never, projectId: otherProject.id }
      const otherConversation = { ...conversation, id: 'c-2' as never }
      await run(store.registerProject({ project: otherProject, mainCheckout: otherCheckout }))
      await run(store.createTask({ task: otherTask, conversation: otherConversation }))
      await run(store.beginRun(command))

      await expect(
        run(
          store.beginRun({
            ...command,
            commandId: 'cmd-2',
            runId: 'run-2' as never,
            taskId: otherTask.id,
            conversationId: otherConversation.id,
            checkoutId: otherCheckout.id,
          }),
        ),
      ).rejects.toMatchObject({ code: 'admission-conflict' })
      expect((await run(store.pageEvents(0, 20))).events).toHaveLength(1)
    })
  })

  it('scopes native session identity to its driver connection', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await run(store.beginRun(command))
      await run(store.claimDispatch(command.runId, 7, '2026-10-29T10:00:02Z'))
      await run(
        store.acknowledgeDispatch(command.runId, {
          ownerEpoch: 7,
          nativeSessionId: 'native-shared',
          acknowledgedAt: '2026-10-29T10:00:03Z',
        }),
      )

      const otherProject = { ...project, id: 'p-2' as never, repositoryIdentity: 'repo:two' }
      const otherCheckout = { ...checkout, id: 'co-2' as never, path: 'C:/other-repo' }
      const otherTask = { ...task, id: 't-2' as never, projectId: otherProject.id }
      const otherConversation = { ...conversation, id: 'c-2' as never }
      await run(store.registerProject({ project: otherProject, mainCheckout: otherCheckout }))
      await run(store.createTask({ task: otherTask, conversation: otherConversation }))

      const otherConnectionCommand = {
        ...command,
        commandId: 'cmd-connection-2',
        runId: 'run-connection-2' as never,
        taskId: otherTask.id,
        conversationId: otherConversation.id,
        checkoutId: otherCheckout.id,
        provisionalAgentSessionId: 'session-connection-2',
        connectionId: 'conn-2',
      }
      await run(store.beginRun(otherConnectionCommand))
      await run(store.claimDispatch(otherConnectionCommand.runId, 8, '2026-10-29T10:00:04Z'))
      await run(
        store.acknowledgeDispatch(otherConnectionCommand.runId, {
          ownerEpoch: 8,
          nativeSessionId: 'native-shared',
          acknowledgedAt: '2026-10-29T10:00:05Z',
        }),
      )

      const conflictingProject = { ...project, id: 'p-3' as never, repositoryIdentity: 'repo:three' }
      const conflictingCheckout = { ...checkout, id: 'co-3' as never, path: 'C:/third-repo' }
      const conflictingTask = { ...task, id: 't-3' as never, projectId: conflictingProject.id }
      const conflictingConversation = { ...conversation, id: 'c-3' as never }
      await run(store.registerProject({ project: conflictingProject, mainCheckout: conflictingCheckout }))
      await run(store.createTask({ task: conflictingTask, conversation: conflictingConversation }))

      const conflictingCommand = {
        ...command,
        commandId: 'cmd-connection-2-conflict',
        runId: 'run-connection-2-conflict' as never,
        taskId: conflictingTask.id,
        conversationId: conflictingConversation.id,
        checkoutId: conflictingCheckout.id,
        provisionalAgentSessionId: 'session-connection-2-conflict',
        connectionId: 'conn-2',
      }
      await run(store.beginRun(conflictingCommand))
      await run(store.claimDispatch(conflictingCommand.runId, 9, '2026-10-29T10:00:06Z'))
      await expect(
        run(
          store.acknowledgeDispatch(conflictingCommand.runId, {
            ownerEpoch: 9,
            nativeSessionId: 'native-shared',
            acknowledgedAt: '2026-10-29T10:00:07Z',
          }),
        ),
      ).rejects.toMatchObject({ code: 'membership-conflict' })
    })
  })

  it('rejects a known native-session resume under a different owner before creating an intent', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      const ownerCommand = { ...command, nativeSessionId: 'native-owner' }
      await run(store.beginRun(ownerCommand))
      await run(store.claimDispatch(ownerCommand.runId, 7, '2026-10-29T10:00:02Z'))
      await run(
        store.acknowledgeDispatch(ownerCommand.runId, {
          ownerEpoch: 7,
          nativeSessionId: 'native-owner',
          acknowledgedAt: '2026-10-29T10:00:03Z',
        }),
      )

      const otherProject = { ...project, id: 'p-2' as never, repositoryIdentity: 'repo:two' }
      const otherCheckout = { ...checkout, id: 'co-2' as never, path: 'C:/other-repo' }
      const otherTask = { ...task, id: 't-2' as never, projectId: otherProject.id }
      const otherConversation = { ...conversation, id: 'c-2' as never }
      await run(store.registerProject({ project: otherProject, mainCheckout: otherCheckout }))
      await run(store.createTask({ task: otherTask, conversation: otherConversation }))

      await expect(
        run(
          store.beginRun({
            ...ownerCommand,
            commandId: 'cmd-wrong-native-owner',
            runId: 'run-wrong-native-owner' as never,
            taskId: otherTask.id,
            conversationId: otherConversation.id,
            checkoutId: otherCheckout.id,
            provisionalAgentSessionId: 'session-wrong-native-owner',
          }),
        ),
      ).rejects.toMatchObject({ code: 'membership-conflict' })
      expect((await run(store.pageEvents(0, 20))).events).toHaveLength(3)
    })
  })

  it('rejects claims from a recovered worker epoch after reopening with a pending intent', async () => {
    const directory = mkdtempSync(join(process.cwd(), 'watchtower-workspace-store-'))
    const filename = join(directory, 'workspace.sqlite')
    let runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))

    try {
      let store = await runtime.runPromise(WorkspaceStore)
      let run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      await run(store.beginRun(command))
      expect(await run(store.recoverWorker(7, '2026-10-29T10:00:02Z'))).toBe(0)

      await runtime.dispose()
      runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
      store = await runtime.runPromise(WorkspaceStore)
      run = effect => runtime.runPromise(effect)

      await expect(run(store.claimDispatch(command.runId, 7, '2026-10-29T10:00:03Z'))).rejects.toMatchObject({
        code: 'stale-epoch',
      })
      expect((await run(store.claimDispatch(command.runId, 8, '2026-10-29T10:00:04Z'))).ownerEpoch).toBe(8)
    } finally {
      await runtime.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects non-positive or fractional worker epochs at the store boundary', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await run(store.beginRun(command))

      await expect(run(store.recoverWorker(0, '2026-10-29T10:00:02Z'))).rejects.toMatchObject({
        code: 'invalid-data',
      })
      await expect(run(store.recoverWorker(-1, '2026-10-29T10:00:02Z'))).rejects.toMatchObject({
        code: 'invalid-data',
      })
      await expect(run(store.recoverWorker(1.5, '2026-10-29T10:00:02Z'))).rejects.toMatchObject({
        code: 'invalid-data',
      })
      await expect(run(store.claimDispatch(command.runId, 0, '2026-10-29T10:00:03Z'))).rejects.toMatchObject({
        code: 'invalid-data',
      })
      await run(store.claimDispatch(command.runId, 7, '2026-10-29T10:00:04Z'))
      await expect(
        run(
          store.acknowledgeDispatch(command.runId, {
            ownerEpoch: 0,
            nativeSessionId: 'native-valid-epoch',
            acknowledgedAt: '2026-10-29T10:00:05Z',
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-data' })
      await run(
        store.acknowledgeDispatch(command.runId, {
          ownerEpoch: 7,
          nativeSessionId: 'native-valid-epoch',
          acknowledgedAt: '2026-10-29T10:00:06Z',
        }),
      )
    })
  })

  it('maps malformed stored task JSON to invalid-data when reading a snapshot', async () => {
    const directory = mkdtempSync(join(process.cwd(), 'watchtower-workspace-store-'))
    const filename = join(directory, 'workspace.sqlite')
    const runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)

      const writer = ManagedRuntime.make(Sqlite.SqliteClient.layer({ filename }))
      try {
        await writer.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE workspace_task SET payload = '{' WHERE id = ${task.id}`
          }),
        )
      } finally {
        await writer.dispose()
      }

      await expect(run(store.readTaskSnapshot(task.id, 10))).rejects.toMatchObject({ code: 'invalid-data' })
    } finally {
      await runtime.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers a claimed intent after reopening without allowing a resend or overlapping start', async () => {
    const directory = mkdtempSync(join(process.cwd(), 'watchtower-workspace-store-'))
    const filename = join(directory, 'workspace.sqlite')
    let runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))

    try {
      let store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      await run(store.beginRun(command))
      await run(store.claimDispatch(command.runId, 7, '2026-10-29T10:00:02Z'))

      await runtime.dispose()
      runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
      store = await runtime.runPromise(WorkspaceStore)

      expect(await run(store.recoverWorker(7, '2026-10-29T10:00:03Z'))).toBe(1)
      await expect(run(store.claimDispatch(command.runId, 7, '2026-10-29T10:00:04Z'))).rejects.toMatchObject({
        code: 'stale-epoch',
      })
      await expect(
        run(
          store.beginRun({
            ...command,
            commandId: 'cmd-after-recovery',
            runId: 'run-after-recovery' as never,
            provisionalAgentSessionId: 'session-after-recovery',
          }),
        ),
      ).rejects.toMatchObject({ code: 'admission-conflict' })
    } finally {
      await runtime.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('retires a worker with completed and active runs from the same epoch', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      const completedCommand = {
        ...command,
        commandId: 'cmd-completed-same-epoch',
        runId: 'run-completed-same-epoch' as never,
        provisionalAgentSessionId: 'session-completed-same-epoch',
      }
      await acceptRun(store, run, completedCommand, 7)
      await run(
        store.recordDriverEvent(completedCommand.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-completed-same-epoch',
          occurredAt: '2026-10-29T10:00:04Z',
          event: { kind: 'turnCompleted', nativeTurnId: 'native-turn-1' },
        }),
      )

      await run(store.beginRun(command))
      await run(store.claimDispatch(command.runId, 7, '2026-10-29T10:00:05Z'))

      expect(await run(store.recoverWorker(7, '2026-10-29T10:00:06Z'))).toBe(1)
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: expect.arrayContaining([
          expect.objectContaining({ id: completedCommand.runId, status: 'completed' }),
          expect.objectContaining({ id: command.runId, status: 'uncertain' }),
        ]),
      })
    })
  })

  it('deduplicates driver events by run and event ID and rejects changed payloads', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await acceptRun(store, run)
      const eventCommand = {
        ownerEpoch: 7,
        generation: 1,
        eventId: 'event-1',
        occurredAt: '2026-10-29T10:00:04Z',
        event: { kind: 'textDelta' as const, text: 'hello', itemId: 'item-1' },
      }

      const first = await run(store.recordDriverEvent(command.runId, eventCommand))
      const replay = await run(store.recordDriverEvent(command.runId, eventCommand))
      expect(replay).toEqual(first)
      expect(first.data).toEqual({ eventId: 'event-1', event: eventCommand.event })
      await expect(
        run(
          store.recordDriverEvent(command.runId, {
            ...eventCommand,
            event: { ...eventCommand.event, text: 'changed' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'command-conflict' })

      const events = await run(store.pageEvents(0, 20))
      expect(events.events.filter(event => event.kind === 'driverEvent')).toHaveLength(1)
    })
  })

  it('rejects stale worker epochs and generations before event replay', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await acceptRun(store, run)
      const eventCommand = {
        ownerEpoch: 7,
        generation: 1,
        eventId: 'event-stale',
        occurredAt: '2026-10-29T10:00:04Z',
        event: { kind: 'nativeNotice' as const, message: 'notice' },
      }

      await expect(
        run(store.recordDriverEvent(command.runId, { ...eventCommand, generation: 2 })),
      ).rejects.toMatchObject({ code: 'membership-conflict' })
      await run(store.recordDriverEvent(command.runId, eventCommand))
      await expect(
        run(store.recordDriverEvent(command.runId, { ...eventCommand, generation: 2 })),
      ).rejects.toMatchObject({ code: 'membership-conflict' })
      await expect(
        run(store.recordDriverEvent(command.runId, { ...eventCommand, ownerEpoch: 6 })),
      ).rejects.toMatchObject({ code: 'stale-epoch' })
      expect(await run(store.recoverWorker(7, '2026-10-29T10:00:05Z'))).toBe(1)
      await expect(run(store.recordDriverEvent(command.runId, eventCommand))).rejects.toMatchObject({
        code: 'stale-epoch',
      })
    })
  })

  it('completes a turn atomically, releases its checkout, and keeps the run immutable', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await acceptRun(store, run)
      await expect(
        run(
          store.recordDriverEvent(command.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: 'event-wrong-turn',
            occurredAt: '2026-10-29T10:00:04Z',
            event: { kind: 'turnCompleted', nativeTurnId: 'different-turn' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'membership-conflict' })
      const terminalEvent = {
        ownerEpoch: 7,
        generation: 1,
        eventId: 'event-complete',
        occurredAt: '2026-10-29T10:00:04Z',
        event: { kind: 'turnCompleted' as const, nativeTurnId: 'native-turn-1' },
      }
      const committed = await run(store.recordDriverEvent(command.runId, terminalEvent))
      expect(committed.kind).toBe('driverEvent')
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ id: command.runId, status: 'completed' })],
      })

      await expect(
        run(
          store.recordDriverEvent(command.runId, {
            ...terminalEvent,
            eventId: 'event-after-terminal',
            event: { kind: 'turnFailed', nativeTurnId: 'native-turn-1', message: 'late failure' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-transition' })

      await run(
        store.beginRun({
          ...command,
          commandId: 'cmd-after-completion',
          runId: 'run-after-completion' as never,
          provisionalAgentSessionId: 'session-after-completion',
        }),
      )
    })
  })

  it('persists interrupt intent and preserves it across pending and resolved requests', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await acceptRun(store, run)
      for (let index = 0; index < 40; index += 1) {
        await run(
          store.recordDriverEvent(command.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: `event-delta-${index}`,
            occurredAt: '2026-10-29T10:00:04Z',
            event: { kind: 'textDelta', text: `chunk-${index}`, itemId: 'item-1' },
          }),
        )
      }
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-request-pending-before-interrupt',
          occurredAt: '2026-10-29T10:00:04Z',
          event: {
            kind: 'requestPending',
            request: {
              requestId: 'request-before-interrupt',
              runId: command.runId,
              sessionId: 'session-1' as never,
              generation: 1,
              kind: 'approval',
              prompt: 'Allow action?',
              questions: [],
            },
          },
        }),
      )
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ status: 'awaitingInput' })],
      })
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-second-request-pending-before-interrupt',
          occurredAt: '2026-10-29T10:00:05Z',
          event: {
            kind: 'requestPending',
            request: {
              requestId: 'request-second-before-interrupt',
              runId: command.runId,
              sessionId: 'session-1' as never,
              generation: 1,
              kind: 'question',
              prompt: 'Choose an option',
              questions: [],
            },
          },
        }),
      )
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-request-resolved-before-interrupt',
          occurredAt: '2026-10-29T10:00:05Z',
          event: {
            kind: 'requestResolved',
            requestId: 'request-before-interrupt',
            decision: { kind: 'approve' },
          },
        }),
      )
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ status: 'awaitingInput' })],
      })
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-second-request-resolved-before-interrupt',
          occurredAt: '2026-10-29T10:00:06Z',
          event: {
            kind: 'requestResolved',
            requestId: 'request-second-before-interrupt',
            decision: { kind: 'answers', answers: {} },
          },
        }),
      )
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ status: 'running' })],
      })
      await run(store.requestInterrupt(command.runId, 7, '2026-10-29T10:00:04Z'))
      await run(store.requestInterrupt(command.runId, 7, '2026-10-29T10:00:05Z'))
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ status: 'interruptRequested' })],
      })

      const pendingEvent = {
        ownerEpoch: 7,
        generation: 1,
        eventId: 'event-request-pending',
        occurredAt: '2026-10-29T10:00:06Z',
        event: {
          kind: 'requestPending' as const,
          request: {
            requestId: 'request-1',
            runId: command.runId,
            sessionId: 'session-1' as never,
            generation: 1,
            kind: 'approval' as const,
            prompt: 'Allow action?',
            questions: [],
          },
        },
      }
      await expect(
        run(
          store.recordDriverEvent(command.runId, {
            ...pendingEvent,
            event: { ...pendingEvent.event, request: { ...pendingEvent.event.request, runId: 'other-run' as never } },
          }),
        ),
      ).rejects.toMatchObject({ code: 'membership-conflict' })
      await run(store.recordDriverEvent(command.runId, pendingEvent))
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-request-resolved',
          occurredAt: '2026-10-29T10:00:07Z',
          event: { kind: 'requestResolved', requestId: 'request-1', decision: { kind: 'approve' } },
        }),
      )
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ status: 'interruptRequested' })],
      })

      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-interrupted',
          occurredAt: '2026-10-29T10:00:08Z',
          event: { kind: 'turnInterrupted', nativeTurnId: 'native-turn-1' },
        }),
      )
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ status: 'interrupted' })],
      })
    })
  })

  it('backfills pending driver requests when upgrading an existing workspace database', async () => {
    const directory = mkdtempSync(join(process.cwd(), 'watchtower-workspace-store-'))
    const filename = join(directory, 'workspace.sqlite')
    let runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))

    try {
      let store = await runtime.runPromise(WorkspaceStore)
      let run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      await acceptRun(store, run)
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-request-before-upgrade',
          occurredAt: '2026-10-29T10:00:04Z',
          event: {
            kind: 'requestPending',
            request: {
              requestId: 'request-before-upgrade',
              runId: command.runId,
              sessionId: 'session-1' as never,
              generation: 1,
              kind: 'approval',
              prompt: 'Allow action?',
              questions: [],
            },
          },
        }),
      )
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-resolved-request-pending-before-upgrade',
          occurredAt: '2026-10-29T10:00:05Z',
          event: {
            kind: 'requestPending',
            request: {
              requestId: 'request-resolved-before-upgrade',
              runId: command.runId,
              sessionId: 'session-1' as never,
              generation: 1,
              kind: 'approval',
              prompt: 'Allow action?',
              questions: [],
            },
          },
        }),
      )
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-resolved-request-before-upgrade',
          occurredAt: '2026-10-29T10:00:06Z',
          event: {
            kind: 'requestResolved',
            requestId: 'request-resolved-before-upgrade',
            decision: { kind: 'approve' },
          },
        }),
      )

      const writer = ManagedRuntime.make(Sqlite.SqliteClient.layer({ filename }))
      try {
        await writer.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`DROP TABLE workspace_driver_request_state`
            yield* sql`DROP TABLE workspace_request_response_intent`
            yield* sql`DROP TABLE workspace_steer_intent`
            yield* sql`DROP TABLE workspace_follow_up_queue`
            yield* sql`DELETE FROM watchtower_sql_migrations WHERE migration_id >= 5`
          }),
        )
      } finally {
        await writer.dispose()
      }

      await runtime.dispose()
      runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
      store = await runtime.runPromise(WorkspaceStore)
      run = effect => runtime.runPromise(effect)
      await run(
        store.recordDriverEvent(command.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-request-after-upgrade',
          occurredAt: '2026-10-29T10:00:05Z',
          event: { kind: 'requestResolved', requestId: 'request-before-upgrade', decision: { kind: 'approve' } },
        }),
      )
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ id: command.runId, status: 'running' })],
      })
      await expect(
        run(
          store.recordDriverEvent(command.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: 'event-duplicate-resolution-after-upgrade',
            occurredAt: '2026-10-29T10:00:06Z',
            event: {
              kind: 'requestResolved',
              requestId: 'request-resolved-before-upgrade',
              decision: { kind: 'approve' },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'membership-conflict' })
    } finally {
      await runtime.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists an interrupt request before native dispatch acknowledgement', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await run(store.beginRun(command))
      await run(store.claimDispatch(command.runId, 7, '2026-10-29T10:00:02Z'))
      await run(store.requestInterrupt(command.runId, 7, '2026-10-29T10:00:03Z'))
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ status: 'interruptRequested' })],
      })

      await run(
        store.acknowledgeDispatch(command.runId, {
          ownerEpoch: 7,
          nativeSessionId: 'native-session-1',
          nativeTurnId: 'native-turn-1',
          acknowledgedAt: '2026-10-29T10:00:04Z',
        }),
      )
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ status: 'interruptRequested', startedAt: '2026-10-29T10:00:04Z' })],
      })
    })
  })

  it('distinguishes definite launch failures from ambiguous post-submit failures', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      const failedCommand = { ...command, runId: 'run-launch-failed' as never }
      await run(store.beginRun({ ...failedCommand, commandId: 'cmd-launch-failed' }))
      await run(store.claimDispatch(failedCommand.runId, 7, '2026-10-29T10:00:02Z'))
      const launchFailure = {
        ownerEpoch: 7,
        occurredAt: '2026-10-29T10:00:03Z',
        outcome: 'failed' as const,
        reason: 'launch-failed' as const,
      }
      await run(store.failDispatch(failedCommand.runId, launchFailure))
      await run(store.failDispatch(failedCommand.runId, launchFailure))
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ id: failedCommand.runId, status: 'failed', failure: 'launch-failed' })],
      })

      const uncertainCommand = {
        ...command,
        commandId: 'cmd-stream-ended',
        runId: 'run-stream-ended' as never,
        provisionalAgentSessionId: 'session-stream-ended',
      }
      await acceptRun(store, run, uncertainCommand, 8)
      await run(
        store.failDispatch(uncertainCommand.runId, {
          ownerEpoch: 8,
          occurredAt: '2026-10-29T10:00:04Z',
          outcome: 'failed',
          reason: 'event-stream-ended',
        }),
      )
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: expect.arrayContaining([
          expect.objectContaining({ id: uncertainCommand.runId, status: 'uncertain', failure: 'event-stream-ended' }),
        ]),
      })
      await expect(
        run(
          store.beginRun({
            ...command,
            commandId: 'cmd-after-uncertain',
            runId: 'run-after-uncertain' as never,
            provisionalAgentSessionId: 'session-after-uncertain',
          }),
        ),
      ).rejects.toMatchObject({ code: 'admission-conflict' })
    })
  })

  it('settles an initially pending launch failure idempotently and releases its checkout', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await run(store.beginRun(command))
      const launchFailure = {
        ownerEpoch: 7,
        occurredAt: '2026-10-29T10:00:02Z',
        outcome: 'failed' as const,
        reason: 'launch-failed' as const,
      }

      await run(store.failDispatch(command.runId, launchFailure))
      await run(store.failDispatch(command.runId, launchFailure))
      expect(await run(store.readTaskSnapshot(task.id, 10))).toMatchObject({
        runs: [expect.objectContaining({ id: command.runId, status: 'failed', failure: 'launch-failed' })],
      })
      await run(
        store.beginRun({
          ...command,
          commandId: 'cmd-after-pending-launch-failure',
          runId: 'run-after-pending-launch-failure' as never,
          provisionalAgentSessionId: 'session-after-pending-launch-failure',
        }),
      )
    })
  })

  it('returns not-found for dispatch failure and interruption of unknown runs', async () => {
    await withStore(async (store, run) => {
      await setup(store, run)
      await expect(
        run(
          store.failDispatch('missing-run' as never, {
            ownerEpoch: 7,
            occurredAt: '2026-10-29T10:00:02Z',
            outcome: 'failed',
            reason: 'launch-failed',
          }),
        ),
      ).rejects.toMatchObject({ code: 'not-found' })
      await expect(
        run(store.requestInterrupt('missing-run' as never, 7, '2026-10-29T10:00:02Z')),
      ).rejects.toMatchObject({
        code: 'not-found',
      })
    })
  })
})
