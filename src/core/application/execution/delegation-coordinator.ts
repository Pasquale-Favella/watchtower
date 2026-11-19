import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import { ExecutionService, type ExecutionServiceError } from '@/core/application/commands/execution-service.js'
import { captureRunResult } from '@/core/application/execution/run-result.js'
import { delegationStatusFromRun, isSettledDelegationStatus } from '@/core/domain/delegation/status.js'
import { delegationWakePrompt } from '@/core/domain/delegation/wake.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import {
  DELEGATION_RESULT_MAX_CHARS,
  DelegationError,
  type DelegationId,
  type DelegationRecord,
} from '@/shared/schemas/delegation.js'
import { agentDriverEventSchema,type AgentRunStatus } from '@/shared/schemas/execution.js'
import type { AgentRunId, TaskId } from '@/shared/schemas/workspace.js'
import type { WorkspaceExecutionEvent, WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

const RUN_TERMINAL: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  'interrupted',
  'completed',
  'failed',
  'uncertain',
  'recoveryRequired',
])

const RECOVERY_BATCH = 200

const now = Effect.map(DateTime.now, DateTime.formatIso)

const notFound = () => new DelegationError({ code: 'not-found', message: 'Delegation was not found.' })

/**
 * Owns the lifecycle after launch: settlement when a child Run ends, the wake that returns the result to the parent,
 * waiters for `wait` calls, cancellation, the parent-stop cascade, and recovery after a restart.
 *
 * Each Delegation changes under its own lock, so a settle, a cancel and a wait timeout never interleave.
 */
export class DelegationCoordinator extends Context.Service<
  DelegationCoordinator,
  {
    /** Mirrors a child's pending approval or question onto its Delegation. Called for every committed event. */
    readonly observe: (event: WorkspaceExecutionEvent) => Effect.Effect<void>
    /** Called when a worker finishes. Settles a child and wakes its parent, or cancels the children of a stopped parent. */
    readonly runFinished: (claim: { readonly runId: AgentRunId; readonly taskId: TaskId }) => Effect.Effect<void>
    /** Blocks until the Delegation settles or the timeout passes. On timeout it returns null and the wake then queues. */
    readonly awaitSettled: (
      delegationId: DelegationId,
      timeoutMs: number,
    ) => Effect.Effect<DelegationRecord | null, WorkspaceStoreError>
    /** Requests cancellation: the child Run is interrupted, its queued follow-ups are dropped, and no wake is sent. */
    readonly cancel: (
      delegationId: DelegationId,
    ) => Effect.Effect<DelegationRecord, WorkspaceStoreError | ExecutionServiceError | DelegationError>
    /** Owner-epoch recovery: settle children whose Runs ended while the app was down, and deliver due wakes. */
    readonly recover: () => Effect.Effect<void, WorkspaceStoreError | ExecutionServiceError>
  }
>()('watchtower/core/application/DelegationCoordinator') {
  static readonly layer = Layer.effect(
    DelegationCoordinator,
    Effect.gen(function* () {
      const store = yield* WorkspaceStore
      const execution = yield* ExecutionService
      const waiters = new Map<DelegationId, Deferred.Deferred<DelegationRecord>>()
      const locks = new Map<DelegationId, Semaphore.Semaphore>()

      const withLock = <A, E, R>(id: DelegationId, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          let lock = locks.get(id)
          if (!lock) {
            lock = yield* Semaphore.make(1)
            locks.set(id, lock)
          }
          return yield* lock.withPermit(effect)
        })

      /**
       * Queues the wake in the parent's follow-up queue. The wake stays `pending` while it waits there, held or not;
       * it becomes `delivered` when the parent's next turn shows the wake message (see markWakesDelivered).
       */
      const enqueueWake = Effect.fn('DelegationCoordinator.enqueueWake')(function* (record: DelegationRecord) {
        yield* execution.enqueueFollowUp({
          commandId: `delegation-wake:${record.id}`,
          issuedAt: yield* now,
          taskId: record.parentTaskId,
          conversationId: record.parentConversationId,
          prompt: delegationWakePrompt(record),
          origin: 'delegation',
          delegationId: record.id,
        })
      })

      /** A parent turn that already carries a wake message delivered that wake. */
      const markWakesDelivered = Effect.fn('DelegationCoordinator.markWakesDelivered')(function* (taskId: TaskId) {
        const page = yield* store.listDelegations({ parentTaskId: taskId, limit: 50 })
        const pending = page.items.filter(record => record.wakeState === 'pending' && record.settledAt !== null)
        const first = pending[0]
        if (!first) return
        const conversation = yield* store.readConversationPage(first.parentConversationId, 0, 100, undefined, {
          direction: 'backward',
        })
        const delivered = new Set(
          conversation.items.flatMap(item => (item.userMessage?.delegation ? [item.userMessage.delegation.delegationId] : [])),
        )
        for (const record of pending) {
          if (!delivered.has(record.id)) continue
          yield* store.setDelegationWake({
            commandId: `delegation-wake-delivered:${record.id}`,
            delegationId: record.id,
            wakeState: 'delivered',
            occurredAt: yield* now,
          })
        }
      })

      /**
       * Decides the wake for a settled child. A `wait` caller that is still attached receives the result directly
       * and no wake is queued. Otherwise the wake is queued, which covers `async` and a `wait` that timed out.
       */
      const deliverWake = Effect.fn('DelegationCoordinator.deliverWake')(function* (
        settled: DelegationRecord,
        waiterAttached: boolean,
      ) {
        if (settled.wakeState === 'disposed') return
        if (settled.wake === 'settledOnly' && waiterAttached) {
          yield* store.setDelegationWake({
            commandId: `delegation-wake-disposed:${settled.id}`,
            delegationId: settled.id,
            wakeState: 'disposed',
            occurredAt: yield* now,
          })
          return
        }
        const pending = yield* store.setDelegationWake({
          commandId: `delegation-wake-pending:${settled.id}`,
          delegationId: settled.id,
          wakeState: 'pending',
          occurredAt: yield* now,
        })
        yield* enqueueWake(pending)
      })

      /** Settles a child from its Run's final status. Runs under the Delegation lock. */
      const settleFromRun = Effect.fn('DelegationCoordinator.settleFromRun')(function* (
        record: DelegationRecord,
        runStatus: AgentRunStatus,
      ) {
        const status = delegationStatusFromRun({
          runStatus,
          cancelRequested: record.cancelRequestedAt !== null,
          pendingRequest: false,
        })
        if (!isSettledDelegationStatus(status)) return record
        const result = record.childRunId
          ? yield* captureRunResult(
              store,
              record.childConversationId,
              record.childRunId,
              DELEGATION_RESULT_MAX_CHARS,
            ).pipe(Effect.catch(() => Effect.succeed({ text: '', truncated: false })))
          : { text: '', truncated: false }
        const settled = yield* store.settleDelegation({
          commandId: `delegation-settle:${record.id}`,
          delegationId: record.id,
          status,
          resultText: result.text.length > 0 ? result.text : null,
          resultTruncated: result.truncated,
          occurredAt: yield* now,
        })
        const waiter = waiters.get(record.id)
        waiters.delete(record.id)
        if (waiter) yield* Deferred.succeed(waiter, settled)
        yield* deliverWake(settled, waiter !== undefined)
        return settled
      })

      const childRunStatus = Effect.fn('DelegationCoordinator.childRunStatus')(function* (record: DelegationRecord) {
        if (!record.childRunId) return null
        const snapshot = yield* store.readTaskSnapshot(record.childTaskId, RECOVERY_BATCH)
        return snapshot.runs.find(run => run.id === record.childRunId)?.status ?? null
      })

      const cancelRecord = Effect.fn('DelegationCoordinator.cancel')(function* (delegationId: DelegationId) {
        return yield* withLock(
          delegationId,
          Effect.gen(function* () {
            const current = yield* store.getDelegation(delegationId)
            if (!current) return yield* Effect.fail(notFound())
            if (current.settledAt !== null) return current
            const requested = yield* store.requestDelegationCancel(delegationId, yield* now)
            // A cancelled Delegation never wakes its parent: the parent asked for the stop, so nothing is owed back.
            yield* store.setDelegationWake({
              commandId: `delegation-wake-cancelled:${delegationId}`,
              delegationId,
              wakeState: 'disposed',
              occurredAt: yield* now,
            })
            const queued = yield* store.listQueuedFollowUps(requested.childConversationId, { limit: 100 })
            for (const item of queued.items)
              yield* execution.cancelQueuedFollowUp(requested.childConversationId, item.commandId)
            if (requested.childRunId)
              yield* execution.interrupt(requested.childRunId).pipe(Effect.catch(() => Effect.void))
            return (yield* store.getDelegation(delegationId)) ?? requested
          }),
        )
      })

      const observe = Effect.fn('DelegationCoordinator.observe')(function* (event: WorkspaceExecutionEvent) {
        if (event.kind !== 'driverEvent') return
        const decoded = Schema.decodeUnknownOption(agentDriverEventSchema)(event.data['event'])
        if (Option.isNone(decoded)) return
        const driver = decoded.value
        if (driver.kind === 'turnStarted') return yield* markWakesDelivered(event.taskId)
        if (driver.kind !== 'requestPending' && driver.kind !== 'requestResolved') return
        const child = yield* store.getDelegationByChildTask(event.taskId)
        if (!child) return
        if (driver.kind === 'requestPending') {
          yield* store.setDelegationPendingRequest({
            commandId: `delegation-request:${child.id}:${driver.request.requestId}`,
            delegationId: child.id,
            pendingRequest: { requestId: driver.request.requestId, kind: driver.request.kind },
            occurredAt: yield* now,
          })
          return
        }
        if (child.pendingRequest?.requestId === driver.requestId)
          yield* store.setDelegationPendingRequest({
            commandId: `delegation-request-resolved:${child.id}:${driver.requestId}`,
            delegationId: child.id,
            pendingRequest: null,
            occurredAt: yield* now,
          })
      })

      const runFinished = Effect.fn('DelegationCoordinator.runFinished')(function* (claim: {
        readonly runId: AgentRunId
        readonly taskId: TaskId
      }) {
        const child = yield* store.getDelegationByChildTask(claim.taskId)
        if (child && child.childRunId === claim.runId) {
          yield* withLock(
            child.id,
            Effect.gen(function* () {
              const current = yield* store.getDelegation(child.id)
              if (!current || current.settledAt !== null) return
              const runStatus = yield* childRunStatus(current)
              if (runStatus === null || !RUN_TERMINAL.has(runStatus)) return
              yield* settleFromRun(current, runStatus)
            }),
          )
        }
        // A stopped parent Run cancels the Delegations it started. A parent that completed keeps them running, and
        // their wakes start the parent again later.
        const started = yield* store.listDelegations({ parentRunId: claim.runId, activeOnly: true, limit: 50 })
        if (started.items.length === 0) return
        const snapshot = yield* store.readTaskSnapshot(claim.taskId, RECOVERY_BATCH)
        if (snapshot.runs.find(run => run.id === claim.runId)?.status !== 'interrupted') return
        for (const delegation of started.items) yield* cancelRecord(delegation.id).pipe(Effect.catch(() => Effect.void))
      }, Effect.catchCause(() => Effect.void))

      const awaitSettled = Effect.fn('DelegationCoordinator.awaitSettled')(function* (
        delegationId: DelegationId,
        timeoutMs: number,
      ) {
        const deferred = yield* Deferred.make<DelegationRecord>()
        const immediate = yield* withLock(
          delegationId,
          Effect.gen(function* () {
            const current = yield* store.getDelegation(delegationId)
            if (!current || current.settledAt !== null) return current
            waiters.set(delegationId, deferred)
            return null
          }),
        )
        if (immediate !== null) return immediate
        const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs))
        if (Option.isSome(result)) return result.value
        // Timed out: detach the waiter unless settlement has already taken it, in which case its result is delivered.
        return yield* withLock(
          delegationId,
          Effect.suspend(() => {
            if (waiters.get(delegationId) !== deferred) return Deferred.await(deferred)
            waiters.delete(delegationId)
            return Effect.succeed(null)
          }),
        )
      })

      const recover = Effect.fn('DelegationCoordinator.recover')(function* () {
        const active = yield* store.listDelegations({ activeOnly: true, limit: RECOVERY_BATCH })
        for (const record of active.items) {
          const runStatus = yield* childRunStatus(record).pipe(Effect.catch(() => Effect.succeed(null)))
          if (runStatus === null || !RUN_TERMINAL.has(runStatus)) continue
          yield* withLock(
            record.id,
            Effect.gen(function* () {
              const current = yield* store.getDelegation(record.id)
              if (current && current.settledAt === null) yield* settleFromRun(current, runStatus)
            }),
          )
        }
        const due = yield* store.listDueDelegationWakes(RECOVERY_BATCH)
        for (const record of due) yield* enqueueWake(record).pipe(Effect.catch(() => Effect.void))
      })

      return DelegationCoordinator.of({
        observe: event => observe(event).pipe(Effect.catchCause(() => Effect.void)),
        runFinished,
        awaitSettled,
        cancel: cancelRecord,
        recover,
      })
    }),
  )
}
