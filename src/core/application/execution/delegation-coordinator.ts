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
  type DelegationSettledStatus,
} from '@/shared/schemas/delegation.js'
import { agentDriverEventSchema, type AgentRunStatus } from '@/shared/schemas/execution.js'
import type { AgentRunId, TaskId } from '@/shared/schemas/workspace.js'
import type {
  BeginRunCommand,
  ReopenDelegationCommand,
  WorkspaceExecutionEvent,
  WorkspaceStoreError,
} from '@/shared/schemas/workspace-store.js'

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
 * The first child Run keeps the original wake id, so a wake queued before resume existed is not queued twice. A resumed
 * Delegation settles again, so each later child Run owes its own wake.
 */
const wakeCommandId = (record: Pick<DelegationRecord, 'id' | 'childRunId'>): string =>
  record.childRunId === null || record.childRunId === `run-${record.id.slice('dlg-'.length)}`
    ? `delegation-wake:${record.id}`
    : `delegation-wake:${record.id}:${record.childRunId}`

/**
 * A `wait` caller's claim on a Delegation's settlement. It is registered before the child launches, so a child that
 * settles during launch hands its result to the caller and no wake is queued for the parent.
 */
export interface DelegationWatch {
  /** Blocks until settlement or the timeout. On timeout it returns null and the wake is upgraded to `always`. */
  readonly awaitSettled: (timeoutMs: number) => Effect.Effect<DelegationRecord | null, WorkspaceStoreError>
  /** Detaches a watch that was never awaited to the end, such as when its caller is interrupted. Idempotent. */
  readonly release: () => Effect.Effect<void>
}

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
    /**
     * Starts a child Run under the Delegation lock. A cancel or settlement either lands before the launch decision,
     * which then launches nothing, or after it, when the cancel interrupts the Run that now exists.
     */
    readonly launch: (
      delegationId: DelegationId,
      command: BeginRunCommand,
    ) => Effect.Effect<boolean, WorkspaceStoreError | ExecutionServiceError | DelegationError>
    /**
     * Re-opens a settled Delegation and starts its follow-up Run under the Delegation lock. Returns null when the
     * Delegation is still live, so the caller can message the running child instead.
     */
    readonly resume: (
      delegationId: DelegationId,
      reopen: ReopenDelegationCommand,
      command: BeginRunCommand,
    ) => Effect.Effect<DelegationRecord | null, WorkspaceStoreError | ExecutionServiceError | DelegationError>
    /** Registers a `wait` caller. Call it before the child launches, then await the returned watch. */
    readonly watch: (
      delegationId: DelegationId,
    ) => Effect.Effect<DelegationWatch, WorkspaceStoreError | DelegationError>
    /**
     * Settles a Delegation whose child Run never started. The parent hears of it through the wake, unless a waiter
     * is attached and receives the result directly.
     */
    readonly settleLaunchFailure: (
      delegationId: DelegationId,
    ) => Effect.Effect<DelegationRecord, WorkspaceStoreError | ExecutionServiceError | DelegationError>
    /**
     * Requests cancellation: the child Run is interrupted, its queued follow-ups are dropped, and no wake is sent. A
     * child whose Run was never claimed has no worker to report back, so it settles as cancelled here.
     */
    readonly cancel: (
      delegationId: DelegationId,
    ) => Effect.Effect<DelegationRecord, WorkspaceStoreError | ExecutionServiceError | DelegationError>
    /**
     * Owner-epoch recovery: settle children whose Runs ended while the app was down, settle children that were
     * queued but never claimed as failed, and deliver due wakes. A child is never re-dispatched after a restart,
     * because the parent Run that asked for it has ended.
     */
    readonly recover: (ownerEpoch: number) => Effect.Effect<void, WorkspaceStoreError | ExecutionServiceError>
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
          commandId: wakeCommandId(record),
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
        // A resumed Delegation settles more than once, so only a wake message from after this settlement counts.
        const latestWake = new Map<string, string>()
        for (const item of conversation.items) {
          const message = item.userMessage
          if (!message?.delegation) continue
          const seen = latestWake.get(message.delegation.delegationId)
          if (!seen || message.createdAt > seen) latestWake.set(message.delegation.delegationId, message.createdAt)
        }
        for (const record of pending) {
          const wakeAt = latestWake.get(record.id)
          if (!wakeAt || record.settledAt === null || wakeAt < record.settledAt) continue
          // A resume may have replaced this settlement since the listing; only the settlement that was read is marked.
          yield* withLock(
            record.id,
            Effect.gen(function* () {
              const current = yield* store.getDelegation(record.id)
              if (!current || current.settledAt !== record.settledAt || current.wakeState !== 'pending') return
              yield* store.setDelegationWake({
                commandId: `delegation-wake-delivered:${record.id}`,
                delegationId: record.id,
                wakeState: 'delivered',
                occurredAt: yield* now,
              })
            }),
          )
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

      /**
       * Writes the terminal state, hands it to an attached waiter and decides the wake. Runs under the Delegation lock,
       * so a waiter is either attached here or has already detached, never both.
       */
      const finish = Effect.fn('DelegationCoordinator.finish')(function* (
        delegationId: DelegationId,
        outcome: {
          readonly status: DelegationSettledStatus
          readonly resultText: string | null
          readonly resultTruncated: boolean
        },
      ) {
        const settled = yield* store.settleDelegation({
          commandId: `delegation-settle:${delegationId}`,
          delegationId,
          status: outcome.status,
          resultText: outcome.resultText,
          resultTruncated: outcome.resultTruncated,
          occurredAt: yield* now,
        })
        const waiter = waiters.get(delegationId)
        waiters.delete(delegationId)
        if (waiter) yield* Deferred.succeed(waiter, settled)
        yield* deliverWake(settled, waiter !== undefined)
        return settled
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
        return yield* finish(record.id, {
          status,
          resultText: result.text.length > 0 ? result.text : null,
          resultTruncated: result.truncated,
        })
      })

      const launchFailure = {
        status: 'failed',
        resultText: 'The delegated task could not start.',
        resultTruncated: false,
      } as const

      const settleLaunchFailure = Effect.fn('DelegationCoordinator.settleLaunchFailure')(function* (
        delegationId: DelegationId,
      ) {
        return yield* withLock(
          delegationId,
          Effect.gen(function* () {
            const current = yield* store.getDelegation(delegationId)
            if (!current) return yield* Effect.fail(notFound())
            if (current.settledAt !== null) return current
            return yield* finish(delegationId, launchFailure)
          }),
        )
      })

      const launch = Effect.fn('DelegationCoordinator.launch')(function* (
        delegationId: DelegationId,
        command: BeginRunCommand,
      ) {
        return yield* withLock(
          delegationId,
          Effect.gen(function* () {
            const current = yield* store.getDelegation(delegationId)
            if (!current) return yield* Effect.fail(notFound())
            if (current.settledAt !== null || current.cancelRequestedAt !== null) return false
            yield* execution.start(command)
            return true
          }),
        )
      })

      const resume = Effect.fn('DelegationCoordinator.resume')(function* (
        delegationId: DelegationId,
        reopen: ReopenDelegationCommand,
        command: BeginRunCommand,
      ) {
        return yield* withLock(
          delegationId,
          Effect.gen(function* () {
            const current = yield* store.getDelegation(delegationId)
            if (!current) return yield* Effect.fail(notFound())
            if (current.childRunId === reopen.childRunId) return current
            if (current.settledAt === null) return null
            const reopened = yield* store.reopenDelegation(reopen)
            const started = yield* Effect.exit(execution.start(command))
            if (started._tag === 'Success') return reopened
            return yield* finish(delegationId, launchFailure)
          }),
        )
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
            // The store caps a page at 50 items, so the queue is walked page by page.
            let afterPosition = 0
            while (true) {
              const queued = yield* store.listQueuedFollowUps(requested.childConversationId, {
                afterPosition,
                limit: 50,
              })
              for (const item of queued.items)
                yield* execution.cancelQueuedFollowUp(requested.childConversationId, item.commandId)
              if (queued.nextAfterPosition === null) break
              afterPosition = queued.nextAfterPosition
            }
            const runStatus = yield* childRunStatus(requested)
            if (runStatus === null || runStatus === 'queued')
              return yield* finish(delegationId, { status: 'cancelled', resultText: null, resultTruncated: false })
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

      /** Upgrades a `settledOnly` wake to `always`, so the settled result still reaches the parent. */
      const upgradeWake = Effect.fn('DelegationCoordinator.upgradeWake')(function* (delegationId: DelegationId) {
        const current = yield* store.getDelegation(delegationId)
        if (!current || current.settledAt !== null || current.wake === 'always') return
        yield* store.setDelegationWake({
          commandId: `delegation-wake-upgraded:${delegationId}`,
          delegationId,
          wakeState: current.wakeState,
          wake: 'always',
          occurredAt: yield* now,
        })
      })

      /** Detaches the waiter unless settlement has already taken it. A detached waiter's result now queues as a wake. */
      const detachWaiter = (delegationId: DelegationId, deferred: Deferred.Deferred<DelegationRecord>) =>
        withLock(
          delegationId,
          Effect.suspend(() => {
            if (waiters.get(delegationId) !== deferred) return Effect.void
            waiters.delete(delegationId)
            return upgradeWake(delegationId)
          }),
        )

      const watch = Effect.fn('DelegationCoordinator.watch')(function* (delegationId: DelegationId) {
        const deferred = yield* Deferred.make<DelegationRecord>()
        yield* withLock(
          delegationId,
          Effect.gen(function* () {
            const current = yield* store.getDelegation(delegationId)
            if (!current) return yield* Effect.fail(notFound())
            if (current.settledAt !== null) yield* Deferred.succeed(deferred, current)
            else waiters.set(delegationId, deferred)
          }),
        )
        return {
          awaitSettled: timeoutMs =>
            Effect.gen(function* () {
              const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs))
              if (Option.isSome(result)) return result.value
              yield* detachWaiter(delegationId, deferred)
              // Settlement takes the waiter under the lock, so a completed deferred means its result is here.
              if (!(yield* Deferred.isDone(deferred))) return null
              return yield* Deferred.await(deferred)
            }),
          release: () => detachWaiter(delegationId, deferred).pipe(Effect.ignore),
        } satisfies DelegationWatch
      })

      const recover = Effect.fn('DelegationCoordinator.recover')(function* (ownerEpoch: number) {
        // Read before settling: a child settled below queues its own wake, so it must not also appear here.
        const due = yield* store.listDueDelegationWakes(RECOVERY_BATCH)
        const active = yield* store.listDelegations({ activeOnly: true, limit: RECOVERY_BATCH })
        for (const record of active.items) {
          const read = yield* childRunStatus(record).pipe(Effect.option)
          if (Option.isNone(read)) continue
          const runStatus = read.value
          if (runStatus === null) {
            // The Delegation names a child Run that was never written, as when the app stopped between a resume and its
            // launch. Nothing will report back for it, so it settles as a failed launch.
            if (record.childRunId === null) continue
            yield* withLock(
              record.id,
              Effect.gen(function* () {
                const current = yield* store.getDelegation(record.id)
                if (!current || current.settledAt !== null || (yield* childRunStatus(current)) !== null) return
                yield* finish(current.id, launchFailure)
              }),
            ).pipe(Effect.catch(() => Effect.void))
            continue
          }
          if (runStatus === 'queued') {
            yield* withLock(
              record.id,
              Effect.gen(function* () {
                const current = yield* store.getDelegation(record.id)
                if (!current || current.settledAt !== null || !current.childRunId) return
                if ((yield* childRunStatus(current)) !== 'queued') return
                yield* store.failDispatch(current.childRunId, {
                  ownerEpoch,
                  occurredAt: yield* now,
                  outcome: 'failed',
                  reason: 'launch-failed',
                })
                yield* finish(current.id, launchFailure)
              }),
            ).pipe(Effect.catch(() => Effect.void))
            continue
          }
          if (!RUN_TERMINAL.has(runStatus)) continue
          yield* withLock(
            record.id,
            Effect.gen(function* () {
              const current = yield* store.getDelegation(record.id)
              if (current && current.settledAt === null) yield* settleFromRun(current, runStatus)
            }),
          )
        }
        for (const record of due) yield* enqueueWake(record).pipe(Effect.catch(() => Effect.void))
      })

      return DelegationCoordinator.of({
        observe: event => observe(event).pipe(Effect.catchCause(() => Effect.void)),
        runFinished,
        watch,
        settleLaunchFailure,
        launch,
        resume,
        cancel: cancelRecord,
        recover,
      })
    }),
  )
}
