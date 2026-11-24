import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it, vi } from 'vitest'

import { ExecutionService } from '@/core/application/commands/execution-service.js'
import { DelegationCoordinator, makeKeyedLock } from '@/core/application/execution/delegation-coordinator.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { WORKSPACE_WORKER_RESPONSE_BYTE_CAPACITY } from '@/shared/rpc/workspace-worker.js'
import { DELEGATION_RESULT_MAX_CHARS, type DelegationRecord } from '@/shared/schemas/delegation.js'
import type { AgentDriverEvent } from '@/shared/schemas/execution.js'
import type { BeginRunCommand, CreateDelegationCommand } from '@/shared/schemas/workspace-store.js'

const ts = '2026-10-29T10:00:00Z'
const project = { id: 'p-1' as never, name: 'Project', repositoryIdentity: 'repo:one', createdAt: ts, updatedAt: ts }
const checkout = { id: 'co-1' as never, kind: 'main' as const, path: 'C:/repo', createdAt: ts, branch: 'main' }
const parentTask = { id: 't-parent' as never, projectId: project.id, title: 'Parent', description: '', createdAt: ts }
const parentConversation = { id: 'c-parent' as never, title: 'Parent chat', createdAt: ts }
const parentCommand: BeginRunCommand = {
  commandId: 'cmd-parent',
  issuedAt: ts,
  runId: 'run-parent' as never,
  taskId: parentTask.id,
  conversationId: parentConversation.id,
  checkoutId: checkout.id,
  provisionalAgentSessionId: 'session-parent',
  generation: 1,
  driverId: 'codex-app-server',
  connectionId: 'codex-1',
  prompt: 'Coordinate the audit',
}

const childTask = { id: 't-child' as never, title: 'Audit', description: '', createdAt: ts }
const childConversation = { id: 'c-child' as never, title: 'Audit', createdAt: ts }
const childRunId = 'run-child' as never

const childRecord = (wake: 'always' | 'settledOnly'): DelegationRecord => ({
  id: 'dlg-1' as never,
  commandId: 'delegation:key-1',
  projectId: project.id,
  parentTaskId: parentTask.id,
  parentConversationId: parentConversation.id,
  parentRunId: parentCommand.runId,
  childTaskId: childTask.id,
  childConversationId: childConversation.id,
  childRunId,
  checkoutId: checkout.id,
  depth: 1,
  title: 'Audit',
  driverId: 'codex-app-server',
  connectionId: 'codex-1',
  modelId: null,
  modeId: null,
  accessMode: 'approval-required',
  accessModeRequested: null,
  accessModeSteppedDownFrom: null,
  isolation: 'shared',
  status: 'queued',
  wake,
  wakeState: 'notDue',
  pendingRequest: null,
  resultText: null,
  resultTruncated: false,
  cancelRequestedAt: null,
  resultReadAt: null,
  createdAt: ts,
  settledAt: null,
})

const createCommand = (wake: 'always' | 'settledOnly'): CreateDelegationCommand => ({
  commandId: 'delegation:key-1',
  issuedAt: ts,
  parentRunId: parentCommand.runId,
  parentTaskId: parentTask.id,
  parentConversationId: parentConversation.id,
  task: { ...childTask, projectId: project.id, title: 'Audit' },
  conversation: childConversation,
  record: childRecord(wake),
  limits: { maxDepth: 1 },
})

const childCommand: BeginRunCommand = {
  ...parentCommand,
  commandId: 'cmd-child',
  runId: childRunId,
  taskId: childTask.id,
  conversationId: childConversation.id,
  provisionalAgentSessionId: 'session-child',
  prompt: 'Audit the parser',
  origin: 'delegation',
  delegationId: 'dlg-1' as never,
}

/** Drives a Run from claim through acceptance, the same path the execution service takes. */
const acceptRun = (store: WorkspaceStore['Service'], command: BeginRunCommand) =>
  Effect.gen(function* () {
    yield* store.beginRun(command)
    yield* store.claimDispatch(command.runId, 7, ts)
    yield* store.acknowledgeDispatch(command.runId, {
      ownerEpoch: 7,
      nativeSessionId: `native-${command.runId}`,
      nativeTurnId: 'native-turn',
      acknowledgedAt: ts,
    })
  })

/** A real SQLite store with a recording execution service, so settlement reads genuine Run state. */
type FollowUpHook = (store: WorkspaceStore['Service'], commandId: string) => Effect.Effect<unknown, unknown>

function coordinatorRuntime(followUps: Array<string>, interrupts: Array<string>, onFollowUp?: FollowUpHook) {
  const execution = Layer.effect(
    ExecutionService,
    Effect.map(WorkspaceStore, store =>
      ExecutionService.of({
        enqueueFollowUp: (command: { readonly commandId: string }) =>
          Effect.sync(() => {
            followUps.push(command.commandId)
          }).pipe(
            Effect.andThen(onFollowUp ? Effect.orDie(onFollowUp(store, command.commandId)) : Effect.void),
            Effect.as({} as never),
          ),
        cancelQueuedFollowUp: () => Effect.void,
        interrupt: (runId: string) =>
          Effect.sync(() => {
            interrupts.push(runId)
          }),
      } as unknown as ExecutionService['Service']),
    ),
  ).pipe(Layer.provideMerge(WorkspaceStoreLive({ filename: ':memory:' })))
  return ManagedRuntime.make(DelegationCoordinator.layer.pipe(Layer.provideMerge(execution)))
}

type CoordinatorRuntime = ReturnType<typeof coordinatorRuntime>

interface Harness {
  readonly runtime: CoordinatorRuntime
  readonly store: WorkspaceStore['Service']
  readonly coordinator: DelegationCoordinator['Service']
  /** Command ids of every follow-up the coordinator queued into a parent conversation. */
  readonly followUps: Array<string>
  /** Run ids the coordinator asked the execution service to interrupt. */
  readonly interrupts: Array<string>
}

async function harness(
  wake: 'always' | 'settledOnly' = 'always',
  seeded = true,
  childClaimed = true,
  onFollowUp?: FollowUpHook,
): Promise<Harness> {
  const followUps: Array<string> = []
  const interrupts: Array<string> = []
  const runtime = coordinatorRuntime(followUps, interrupts, onFollowUp)
  const store = await runtime.runPromise(WorkspaceStore)
  const coordinator = await runtime.runPromise(DelegationCoordinator)
  if (seeded) {
    await runtime.runPromise(store.registerProject({ project, mainCheckout: checkout }))
    await runtime.runPromise(store.createTask({ task: parentTask, conversation: parentConversation }))
    await runtime.runPromise(acceptRun(store, parentCommand))
    await runtime.runPromise(store.createDelegation(createCommand(wake)))
    if (childClaimed) await runtime.runPromise(acceptRun(store, childCommand))
    else await runtime.runPromise(store.beginRun(childCommand))
  }
  return { runtime, store, coordinator, followUps, interrupts }
}

const childEvent = (
  store: WorkspaceStore['Service'],
  eventId: string,
  event: AgentDriverEvent,
  runId: typeof childRunId = childRunId,
) => store.recordDriverEvent(runId, { ownerEpoch: 7, generation: 1, eventId, occurredAt: ts, event })

const childTerminal = (h: Harness, terminal: AgentDriverEvent): Effect.Effect<DelegationRecord | null, unknown> =>
  Effect.gen(function* () {
    yield* childEvent(h.store, 'child-start', { kind: 'turnStarted', nativeTurnId: 'native-turn' })
    yield* childEvent(h.store, 'child-text', { kind: 'textDelta', text: 'Audit done' })
    yield* childEvent(h.store, 'child-terminal', terminal)
    yield* h.coordinator.runFinished({ runId: childRunId, taskId: childTask.id })
    return yield* h.store.getDelegation('dlg-1')
  })

/** Creates a Delegation under the seeded parent Run. Its child Run is not begun. */
const createDelegationFor = (store: WorkspaceStore['Service'], id: string) => {
  const create = createCommand('always')
  const taskId = `task-${id}` as never
  const conversationId = `conv-${id}` as never
  const commandId = `create-${id}`
  return store.createDelegation({
    ...create,
    commandId,
    task: { ...create.task, id: taskId },
    conversation: { ...create.conversation, id: conversationId },
    record: {
      ...create.record,
      id: id as never,
      commandId,
      childTaskId: taskId,
      childConversationId: conversationId,
      childRunId: `run-${id}` as never,
    },
  })
}

const createSettledWithPendingWake = (h: Harness, id: string, resultText: string | null) =>
  Effect.gen(function* () {
    yield* createDelegationFor(h.store, id)
    yield* h.store.settleDelegation({
      commandId: `settle-${id}`,
      delegationId: id as never,
      status: 'completed',
      resultText,
      resultTruncated: false,
      occurredAt: ts,
    })
    yield* h.store.setDelegationWake({
      commandId: `wake-${id}`,
      delegationId: id as never,
      wakeState: 'pending',
      occurredAt: ts,
    })
  })

describe('DelegationCoordinator settlement', () => {
  it('settles a completed child with its captured result and queues one wake for the parent', async () => {
    const h = await harness()
    try {
      const record = await h.runtime.runPromise(
        childTerminal(h, { kind: 'turnCompleted', nativeTurnId: 'native-turn' }),
      )
      expect(record).toMatchObject({ status: 'completed', resultText: 'Audit done', wakeState: 'pending' })
      expect(record?.settledAt).not.toBeNull()
      expect(h.followUps).toEqual(['delegation-wake:dlg-1:run-child'])
    } finally {
      await h.runtime.dispose()
    }
  })

  it('settles a failed child as failed', async () => {
    const h = await harness()
    try {
      const record = await h.runtime.runPromise(
        childTerminal(h, { kind: 'turnFailed', nativeTurnId: 'native-turn', message: 'Tool crashed' }),
      )
      expect(record).toMatchObject({ status: 'failed', wakeState: 'pending' })
      expect(h.followUps).toEqual(['delegation-wake:dlg-1:run-child'])
    } finally {
      await h.runtime.dispose()
    }
  })

  it('settles an interrupted child as interrupted when the parent did not ask for the stop', async () => {
    const h = await harness()
    try {
      const record = await h.runtime.runPromise(
        childTerminal(h, { kind: 'turnInterrupted', nativeTurnId: 'native-turn' }),
      )
      expect(record).toMatchObject({ status: 'interrupted', wakeState: 'pending' })
      expect(h.followUps).toEqual(['delegation-wake:dlg-1:run-child'])
    } finally {
      await h.runtime.dispose()
    }
  })

  it('settles a child interrupted after a parent cancel as cancelled, with no wake', async () => {
    const h = await harness()
    try {
      await h.runtime.runPromise(h.coordinator.cancel('dlg-1' as never))
      expect(h.interrupts).toEqual([childRunId])
      const record = await h.runtime.runPromise(
        childTerminal(h, { kind: 'turnInterrupted', nativeTurnId: 'native-turn' }),
      )
      expect(record).toMatchObject({ status: 'cancelled', wakeState: 'disposed' })
      expect(record?.cancelRequestedAt).not.toBeNull()
      expect(h.followUps).toEqual([])
    } finally {
      await h.runtime.dispose()
    }
  })

  it('mirrors a pending approval onto the Delegation without waking the parent, and clears it on resolution', async () => {
    const h = await harness()
    const requestId = `${'thread-id-'.repeat(40)}:approval`
    try {
      const pending = await h.runtime.runPromise(
        Effect.gen(function* () {
          yield* childEvent(h.store, 'child-start', { kind: 'turnStarted', nativeTurnId: 'native-turn' })
          yield* childEvent(h.store, 'child-request', {
            kind: 'requestPending',
            request: {
              requestId,
              runId: childRunId,
              generation: 1,
              kind: 'approval',
              prompt: 'Run the test suite?',
              questions: [],
            },
          })
          return yield* h.store.getDelegation('dlg-1')
        }),
      )
      expect(pending).toMatchObject({ status: 'waiting', pendingRequest: { requestId, kind: 'approval' } })
      expect(h.followUps).toEqual([])

      await h.runtime.runPromise(
        childEvent(h.store, 'child-request-second', {
          kind: 'requestPending',
          request: {
            requestId: 'req-2',
            runId: childRunId,
            generation: 1,
            kind: 'approval',
            prompt: 'Run the linter?',
            questions: [],
          },
        }),
      )
      await h.runtime.runPromise(
        childEvent(h.store, 'child-resolved-second', {
          kind: 'requestResolved',
          requestId: 'req-2',
          decision: { kind: 'approve' },
        }),
      )
      expect(await h.runtime.runPromise(h.store.getDelegation('dlg-1'))).toMatchObject({
        status: 'waiting',
        pendingRequest: { requestId, kind: 'approval' },
      })

      const resolved = await h.runtime.runPromise(
        Effect.gen(function* () {
          yield* childEvent(h.store, 'child-resolved', {
            kind: 'requestResolved',
            requestId,
            decision: { kind: 'approve' },
          })
          return yield* h.store.getDelegation('dlg-1')
        }),
      )
      expect(resolved).toMatchObject({ status: 'running', pendingRequest: null })
      expect(h.followUps).toEqual([])
    } finally {
      await h.runtime.dispose()
    }
  })

  it.each(['turnCompleted', 'turnInterrupted', 'turnFailed', 'dispatch failure', 'worker recovery'] as const)(
    'clears the mirrored request on %s before the coordinator settles the delegation',
    async kind => {
      const h = await harness()
      try {
        await h.runtime.runPromise(
          Effect.gen(function* () {
            yield* childEvent(h.store, 'child-start', { kind: 'turnStarted', nativeTurnId: 'native-turn' })
            yield* childEvent(h.store, 'child-request', {
              kind: 'requestPending',
              request: {
                requestId: 'pending-approval',
                runId: childRunId,
                generation: 1,
                kind: 'approval',
                prompt: 'Approve?',
                questions: [],
              },
            })
            expect(yield* h.store.getDelegation('dlg-1')).toMatchObject({ status: 'waiting' })
            if (kind === 'dispatch failure') {
              yield* h.store.failDispatch(childRunId, {
                ownerEpoch: 7,
                outcome: 'uncertain',
                occurredAt: ts,
                reason: 'event-stream-ended',
              })
            } else if (kind === 'worker recovery') {
              yield* h.store.recoverWorker(7, ts)
            } else {
              yield* childEvent(
                h.store,
                'child-terminal',
                kind === 'turnFailed' ? { kind, message: 'Child failed' } : { kind },
              )
            }
            expect(yield* h.store.getDelegation('dlg-1')).toMatchObject({
              pendingRequest: null,
              settledAt: null,
              wakeState: 'notDue',
            })
            expect(h.followUps).toEqual([])
          }),
        )
      } finally {
        await h.runtime.dispose()
      }
    },
  )

  it('disposes the wake when a waiting caller receives the settled result directly', async () => {
    const h = await harness('settledOnly')
    try {
      const received = await h.runtime.runPromise(
        Effect.gen(function* () {
          const watch = yield* h.coordinator.watch('dlg-1' as never)
          const waiter = yield* Effect.forkChild(watch.awaitSettled(60_000), {
            startImmediately: true,
          })
          yield* Effect.yieldNow
          yield* childEvent(h.store, 'child-start', { kind: 'turnStarted', nativeTurnId: 'native-turn' })
          yield* childEvent(h.store, 'child-text', { kind: 'textDelta', text: 'Audit done' })
          yield* childEvent(h.store, 'child-terminal', { kind: 'turnCompleted', nativeTurnId: 'native-turn' })
          yield* h.coordinator.runFinished({ runId: childRunId, taskId: childTask.id })
          return yield* Fiber.join(waiter)
        }),
      )
      expect(received).toMatchObject({ status: 'completed', resultText: 'Audit done' })
      const record = await h.runtime.runPromise(h.store.getDelegation('dlg-1'))
      expect(record).toMatchObject({ wakeState: 'disposed' })
      expect(h.followUps).toEqual([])
    } finally {
      await h.runtime.dispose()
    }
  })

  it('returns null when a wait times out, upgrades the wake to always, and queues it on settlement', async () => {
    const h = await harness('settledOnly')
    try {
      const outcome = await h.runtime.runPromise(
        Effect.gen(function* () {
          const watch = yield* h.coordinator.watch('dlg-1' as never)
          const waiter = yield* Effect.forkChild(watch.awaitSettled(1_000), {
            startImmediately: true,
          })
          yield* Effect.yieldNow
          yield* TestClock.adjust(1_000)
          const timedOut = yield* Fiber.join(waiter)
          const upgraded = yield* h.store.getDelegation('dlg-1')
          yield* childEvent(h.store, 'child-start', { kind: 'turnStarted', nativeTurnId: 'native-turn' })
          yield* childEvent(h.store, 'child-terminal', { kind: 'turnCompleted', nativeTurnId: 'native-turn' })
          yield* h.coordinator.runFinished({ runId: childRunId, taskId: childTask.id })
          return { timedOut, upgraded, record: yield* h.store.getDelegation('dlg-1') }
        }).pipe(Effect.provide(TestClock.layer())),
      )
      expect(outcome.timedOut).toBeNull()
      expect(outcome.upgraded).toMatchObject({ wake: 'always', wakeState: 'notDue' })
      expect(outcome.record).toMatchObject({ status: 'completed', wake: 'always', wakeState: 'pending' })
      expect(h.followUps).toEqual(['delegation-wake:dlg-1:run-child'])
    } finally {
      await h.runtime.dispose()
    }
  })

  it('settles a cancelled child that was never claimed, so its slot is released', async () => {
    const h = await harness('always', true, false)
    try {
      const record = await h.runtime.runPromise(h.coordinator.cancel('dlg-1' as never))
      expect(record).toMatchObject({
        status: 'cancelled',
        wakeState: 'disposed',
        cancelRequestedAt: expect.any(String),
      })
      expect(record.settledAt).not.toBeNull()
      expect(h.interrupts).toEqual([])
      expect(h.followUps).toEqual([])
    } finally {
      await h.runtime.dispose()
    }
  })

  it('cancels the running children of a parent Run that was stopped', async () => {
    const h = await harness()
    try {
      await h.runtime.runPromise(
        Effect.gen(function* () {
          yield* h.store.recordDriverEvent(parentCommand.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: 'parent-start',
            occurredAt: ts,
            event: { kind: 'turnStarted', nativeTurnId: 'native-turn' },
          })
          yield* h.store.recordDriverEvent(parentCommand.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: 'parent-stop',
            occurredAt: ts,
            event: { kind: 'turnInterrupted', nativeTurnId: 'native-turn' },
          })
          yield* h.coordinator.runFinished({ runId: parentCommand.runId, taskId: parentTask.id })
        }),
      )
      expect(h.interrupts).toEqual([childRunId])
      const record = await h.runtime.runPromise(h.store.getDelegation('dlg-1'))
      expect(record?.cancelRequestedAt).not.toBeNull()
      expect(h.followUps).toEqual([])
    } finally {
      await h.runtime.dispose()
    }
  })

  it('settles children whose Runs ended while the app was closed and re-queues their wakes', async () => {
    const h = await harness()
    try {
      await h.runtime.runPromise(
        Effect.gen(function* () {
          yield* childEvent(h.store, 'child-start', { kind: 'turnStarted', nativeTurnId: 'native-turn' })
          yield* childEvent(h.store, 'child-text', { kind: 'textDelta', text: 'Recovered answer' })
          yield* childEvent(h.store, 'child-terminal', { kind: 'turnCompleted', nativeTurnId: 'native-turn' })
          yield* h.coordinator.recover(8)
        }),
      )
      const record = await h.runtime.runPromise(h.store.getDelegation('dlg-1'))
      expect(record).toMatchObject({ status: 'completed', resultText: 'Recovered answer', wakeState: 'pending' })
      expect(h.followUps).toEqual(['delegation-wake:dlg-1:run-child'])
    } finally {
      await h.runtime.dispose()
    }
  })

  it('settles a queued child that was never claimed as failed and wakes the parent on recovery', async () => {
    const h = await harness('always', true, false)
    try {
      await h.runtime.runPromise(h.coordinator.recover(8))
      const record = await h.runtime.runPromise(h.store.getDelegation('dlg-1'))
      expect(record).toMatchObject({
        status: 'failed',
        wakeState: 'pending',
        resultText: 'The delegated task could not start.',
      })
      expect(record?.settledAt).not.toBeNull()
      const snapshot = await h.runtime.runPromise(h.store.readTaskSnapshot(childTask.id, 20))
      expect(snapshot.runs.find(run => run.id === childRunId)?.status).toBe('failed')
      expect(h.followUps).toEqual(['delegation-wake:dlg-1:run-child'])
    } finally {
      await h.runtime.dispose()
    }
  })

  it('settles a Delegation whose child Run was never written as a failed launch on recovery', async () => {
    const h = await harness('always', false)
    try {
      await h.runtime.runPromise(h.store.registerProject({ project, mainCheckout: checkout }))
      await h.runtime.runPromise(h.store.createTask({ task: parentTask, conversation: parentConversation }))
      await h.runtime.runPromise(acceptRun(h.store, parentCommand))
      await h.runtime.runPromise(h.store.createDelegation(createCommand('always')))
      await h.runtime.runPromise(h.coordinator.recover(8))
      const record = await h.runtime.runPromise(h.store.getDelegation('dlg-1'))
      expect(record).toMatchObject({ status: 'failed', resultText: 'The delegated task could not start.' })
      expect(record?.settledAt).not.toBeNull()
    } finally {
      await h.runtime.dispose()
    }
  })

  it('replays pending wakes oldest first in bounded pages, even while they remain pending', async () => {
    const h = await harness('always', true)
    try {
      const ids = ['dlg-1', ...Array.from({ length: 54 }, (_, index) => `dlg-batch-${String(index).padStart(2, '0')}`)]
      const listDue = h.store.listDueDelegationWakes
      const enqueuedBeforeRead: number[] = []
      const reads = vi.spyOn(h.store, 'listDueDelegationWakes').mockImplementation((...args) => {
        enqueuedBeforeRead.push(h.followUps.length)
        return listDue(...args)
      })
      await h.runtime.runPromise(
        Effect.gen(function* () {
          for (const id of ids) {
            if (id !== 'dlg-1') {
              const create = createCommand('always')
              const taskId = `task-${id}` as never
              const conversationId = `conv-${id}` as never
              const commandId = `create-${id}`
              yield* h.store.createDelegation({
                ...create,
                commandId,
                task: { ...create.task, id: taskId },
                conversation: { ...create.conversation, id: conversationId },
                record: {
                  ...create.record,
                  id: id as never,
                  commandId,
                  childTaskId: taskId,
                  childConversationId: conversationId,
                  childRunId: `run-${id}` as never,
                },
              })
            }
            yield* h.store.settleDelegation({
              commandId: `settle-${id}`,
              delegationId: id as never,
              status: 'failed',
              resultText: null,
              resultTruncated: false,
              occurredAt: ts,
            })
            yield* h.store.setDelegationWake({
              commandId: `wake-${id}`,
              delegationId: id as never,
              wakeState: 'pending',
              occurredAt: ts,
            })
          }
          yield* h.coordinator.recover(8)
        }),
      )
      expect(reads.mock.calls).toEqual([
        [50, undefined],
        [50, { createdAt: ts, id: ids[49] }],
        [50, { createdAt: ts, id: ids[54] }],
      ])
      expect(enqueuedBeforeRead).toEqual([0, 50, 55])
      expect(h.followUps).toEqual(ids.map(id => `delegation-wake:${id}:${id === 'dlg-1' ? 'run-child' : `run-${id}`}`))
    } finally {
      await h.runtime.dispose()
    }
  })
  it('cuts due-wake pages by size, so maximum results stay inside the worker response cap', async () => {
    const h = await harness('always', true)
    try {
      // Control characters are escaped six bytes each, the worst case for an encoded result.
      const resultText = String.fromCharCode(1).repeat(DELEGATION_RESULT_MAX_CHARS)
      const ids = Array.from({ length: 50 }, (_, index) => `dlg-large-${String(index).padStart(2, '0')}`)
      const listDue = h.store.listDueDelegationWakes
      const pageBytes: number[] = []
      vi.spyOn(h.store, 'listDueDelegationWakes').mockImplementation((...args) =>
        listDue(...args).pipe(Effect.tap(page => Effect.sync(() => pageBytes.push(JSON.stringify(page).length)))),
      )
      await h.runtime.runPromise(
        Effect.gen(function* () {
          for (const id of ids) yield* createSettledWithPendingWake(h, id, resultText)
          yield* h.coordinator.recover(8)
        }),
      )
      expect(pageBytes.length).toBeGreaterThan(2)
      expect(Math.max(...pageBytes)).toBeLessThan(WORKSPACE_WORKER_RESPONSE_BYTE_CAPACITY)
      expect(h.followUps).toEqual(ids.map(id => `delegation-wake:${id}:run-${id}`))
    } finally {
      await h.runtime.dispose()
    }
  })

  it('never settles a Delegation that a replayed wake creates during recovery', async () => {
    const h = await harness('always', true, true, (store, commandId) =>
      commandId === 'delegation-wake:dlg-old:run-dlg-old' ? createDelegationFor(store, 'dlg-new') : Effect.void,
    )
    try {
      await h.runtime.runPromise(
        Effect.gen(function* () {
          yield* createSettledWithPendingWake(h, 'dlg-old', null)
          yield* h.coordinator.recover(8)
        }),
      )
      expect(h.followUps).toContain('delegation-wake:dlg-old:run-dlg-old')
      expect(await h.runtime.runPromise(h.store.getDelegation('dlg-new'))).toMatchObject({ settledAt: null })
    } finally {
      await h.runtime.dispose()
    }
  })

  it('settles a never-claimed child that owner recovery failed as a failed launch', async () => {
    const h = await harness('always', true, false)
    try {
      await h.runtime.runPromise(h.store.acquireOwnerEpoch(ts))
      await h.runtime.runPromise(h.store.acquireOwnerEpoch(ts))
      await h.runtime.runPromise(h.coordinator.recover(9))
      expect(await h.runtime.runPromise(h.store.getDelegation('dlg-1'))).toMatchObject({
        status: 'failed',
        resultText: 'The delegated task could not start.',
      })
    } finally {
      await h.runtime.dispose()
    }
  })

  it('re-delivers a wake whose promoted parent Run never launched, under a new command id', async () => {
    const h = await harness('always', true, true)
    try {
      await h.runtime.runPromise(
        Effect.gen(function* () {
          yield* h.store.recordDriverEvent(parentCommand.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: 'parent-completed',
            occurredAt: ts,
            event: { kind: 'turnCompleted' },
          })
          yield* childEvent(h.store, 'child-start', { kind: 'turnStarted', nativeTurnId: 'native-turn' })
          yield* childEvent(h.store, 'child-terminal', { kind: 'turnCompleted', nativeTurnId: 'native-turn' })
          yield* h.coordinator.runFinished({ runId: childRunId, taskId: childTask.id })
          // The wake is queued, then promoted into a parent Run that the app never claimed before it exited.
          const wakeCommandId = 'delegation-wake:dlg-1:run-child'
          expect(h.followUps).toEqual([wakeCommandId])
          yield* h.store.enqueueFollowUp({
            commandId: wakeCommandId,
            issuedAt: ts,
            taskId: parentTask.id,
            conversationId: parentConversation.id,
            prompt: 'The delegated task finished',
            origin: 'delegation',
            delegationId: 'dlg-1' as never,
          })
          yield* h.store.promoteNextFollowUp(parentConversation.id, {
            ...parentCommand,
            commandId: 'promote-wake',
            runId: 'run-wake' as never,
            provisionalAgentSessionId: 'session-wake',
          })
          yield* h.store.acquireOwnerEpoch(ts)
          yield* h.store.acquireOwnerEpoch(ts)
          h.followUps.length = 0
          yield* h.coordinator.recover(9)
        }),
      )
      expect(h.followUps).toEqual(['delegation-wake:dlg-1:run-child:retry-1'])
      expect(await h.runtime.runPromise(h.store.getDelegation('dlg-1'))).toMatchObject({ wakeState: 'pending' })
    } finally {
      await h.runtime.dispose()
    }
  })
})

describe('Delegation locks', () => {
  it('drops each lock once its last holder or waiter leaves', async () => {
    const { withLock, size } = makeKeyedLock<string>()
    await Effect.runPromise(
      Effect.gen(function* () {
        const holder = yield* Effect.forkChild(withLock('a', Effect.never), { startImmediately: true })
        const waiter = yield* Effect.forkChild(withLock('a', Effect.void), { startImmediately: true })
        yield* withLock('b', Effect.void)
        expect(size()).toBe(1)
        yield* Fiber.interrupt(waiter)
        expect(size()).toBe(1)
        yield* Fiber.interrupt(holder)
        expect(size()).toBe(0)
        yield* Effect.all([withLock('c', Effect.void), withLock('c', Effect.void)], { concurrency: 'unbounded' })
        expect(size()).toBe(0)
      }),
    )
  })
})
