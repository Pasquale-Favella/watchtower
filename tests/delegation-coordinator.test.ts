import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import { ExecutionService } from '@/core/application/commands/execution-service.js'
import { DelegationCoordinator } from '@/core/application/execution/delegation-coordinator.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import type { DelegationRecord } from '@/shared/schemas/delegation.js'
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
  limits: { maxDepth: 1, maxActivePerParentRun: 4 },
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
function coordinatorRuntime(followUps: Array<string>, interrupts: Array<string>) {
  const execution = Layer.effect(
    ExecutionService,
    Effect.sync(() =>
      ExecutionService.of({
        enqueueFollowUp: (command: { readonly commandId: string }) =>
          Effect.sync(() => {
            followUps.push(command.commandId)
          }).pipe(Effect.as({} as never)),
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

async function harness(wake: 'always' | 'settledOnly' = 'always', seeded = true, childClaimed = true): Promise<Harness> {
  const followUps: Array<string> = []
  const interrupts: Array<string> = []
  const runtime = coordinatorRuntime(followUps, interrupts)
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

const childTerminal = (
  h: Harness,
  terminal: AgentDriverEvent,
): Effect.Effect<DelegationRecord | null, unknown> =>
  Effect.gen(function* () {
    yield* childEvent(h.store, 'child-start', { kind: 'turnStarted', nativeTurnId: 'native-turn' })
    yield* childEvent(h.store, 'child-text', { kind: 'textDelta', text: 'Audit done' })
    yield* childEvent(h.store, 'child-terminal', terminal)
    yield* h.coordinator.runFinished({ runId: childRunId, taskId: childTask.id })
    return yield* h.store.getDelegation('dlg-1')
  })

describe('DelegationCoordinator settlement', () => {
  it('settles a completed child with its captured result and queues one wake for the parent', async () => {
    const h = await harness()
    try {
      const record = await h.runtime.runPromise(childTerminal(h, { kind: 'turnCompleted', nativeTurnId: 'native-turn' }))
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
    try {
      const pending = await h.runtime.runPromise(
        Effect.gen(function* () {
          yield* childEvent(h.store, 'child-start', { kind: 'turnStarted', nativeTurnId: 'native-turn' })
          const committed = yield* childEvent(h.store, 'child-request', {
            kind: 'requestPending',
            request: {
              requestId: 'req-1',
              runId: childRunId,
              generation: 1,
              kind: 'approval',
              prompt: 'Run the test suite?',
              questions: [],
            },
          })
          yield* h.coordinator.observe(committed)
          return yield* h.store.getDelegation('dlg-1')
        }),
      )
      expect(pending?.pendingRequest).toEqual({ requestId: 'req-1', kind: 'approval' })
      expect(h.followUps).toEqual([])

      const resolved = await h.runtime.runPromise(
        Effect.gen(function* () {
          const committed = yield* childEvent(h.store, 'child-resolved', {
            kind: 'requestResolved',
            requestId: 'req-1',
            decision: { kind: 'approve' },
          })
          yield* h.coordinator.observe(committed)
          return yield* h.store.getDelegation('dlg-1')
        }),
      )
      expect(resolved?.pendingRequest).toBeNull()
      expect(h.followUps).toEqual([])
    } finally {
      await h.runtime.dispose()
    }
  })

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
      expect(record).toMatchObject({ status: 'cancelled', wakeState: 'disposed', cancelRequestedAt: expect.any(String) })
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
      expect(record).toMatchObject({ status: 'failed', wakeState: 'pending', resultText: 'The delegated task could not start.' })
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

  it('re-queues a due wake that was still pending when the app stopped', async () => {
    const h = await harness('always', true)
    try {
      await h.runtime.runPromise(
        Effect.gen(function* () {
          yield* h.store.settleDelegation({
            commandId: 'settle-before-restart',
            delegationId: 'dlg-1' as never,
            status: 'failed',
            resultText: null,
            resultTruncated: false,
            occurredAt: ts,
          })
          yield* h.store.setDelegationWake({
            commandId: 'wake-before-restart',
            delegationId: 'dlg-1' as never,
            wakeState: 'pending',
            occurredAt: ts,
          })
          yield* h.coordinator.recover(8)
        }),
      )
      expect(h.followUps).toEqual(['delegation-wake:dlg-1:run-child'])
    } finally {
      await h.runtime.dispose()
    }
  })
})
