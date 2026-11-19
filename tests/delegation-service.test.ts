import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it } from 'vitest'

import {
  type DelegationCallerScope,
  DelegationService,
  type DelegationServiceOptions,
  type StartDelegationRequest,
} from '@/core/application/commands/delegation-service.js'
import { ExecutionService } from '@/core/application/commands/execution-service.js'
import { DelegationCoordinator } from '@/core/application/execution/delegation-coordinator.js'
import { AgentDriver } from '@/core/ports/agent-driver.js'
import { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import type { WorkspaceCheckout } from '@/shared/schemas/workspace.js'
import type { BeginRunCommand } from '@/shared/schemas/workspace-store.js'

const ts = '2026-10-29T10:00:00Z'
const project = { id: 'p-1' as never, name: 'Project', repositoryIdentity: 'repo:one', createdAt: ts, updatedAt: ts }
const checkout = { id: 'co-1' as never, kind: 'main' as const, path: 'C:/repo', createdAt: ts, branch: 'feature/parent' }
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
  modelId: 'gpt-5',
  prompt: 'Coordinate the audit',
}

const parentCaller: DelegationCallerScope = {
  projectId: project.id,
  taskId: parentTask.id,
  conversationId: parentConversation.id,
  runId: parentCommand.runId,
  accessMode: 'auto',
}

const catalog = [
  {
    id: 'codex-1',
    label: 'Codex',
    driverId: 'codex-app-server',
    models: [{ id: 'gpt-5', label: 'GPT-5', modes: [{ id: 'high', label: 'High' }] }],
  },
  { id: 'acp-1', label: 'ACP agent', driverId: 'acp' },
]

const request = (overrides: Partial<StartDelegationRequest> = {}): StartDelegationRequest => ({
  task: 'Audit the parser',
  wait: false,
  waitTimeoutMs: 1_000,
  ...overrides,
})

/** Drives a Run through claim and acceptance, the path the execution service takes before a Run is live. */
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

interface HarnessOptions {
  readonly createWorktree?: DelegationServiceOptions['createWorktree']
  /** Settles each child inside its launch, before the start call returns, as a fast child can. */
  readonly settleChildOnLaunch?: boolean
}

/**
 * The real delegation services over a real SQLite store. The execution service is a recording stub that accepts each
 * child Run, so children stay live until a test settles them.
 */
function buildHarness(options: HarnessOptions = {}) {
  const starts: Array<BeginRunCommand> = []
  const interrupts: Array<string> = []
  const followUps: Array<string> = []
  /** Set by openParent, so a launch can settle its child through the same coordinator the service uses. */
  const lifecycle: { coordinator?: DelegationCoordinator['Service'] } = {}
  const storeLayer = WorkspaceStoreLive({ filename: ':memory:' })
  const registry = Layer.succeed(
    AgentDriverRegistry,
    AgentDriverRegistry.fromDrivers([
      AgentDriver.of({
        driverId: 'codex-app-server',
        connect: () => Effect.die('connect is not used by delegation service tests'),
        accessModes: ['approval-required', 'auto-accept-edits'],
      }),
      AgentDriver.of({
        driverId: 'acp',
        connect: () => Effect.die('connect is not used by delegation service tests'),
      }),
    ]),
  )
  const base = Layer.merge(storeLayer, registry)
  const execution = Layer.effect(
    ExecutionService,
    Effect.gen(function* () {
      const store = yield* WorkspaceStore
      return ExecutionService.of({
        start: (command: BeginRunCommand) =>
          acceptRun(store, command).pipe(
            Effect.tap(() => Effect.sync(() => starts.push(command))),
            Effect.tap(() =>
              options.settleChildOnLaunch
                ? Effect.gen(function* () {
                    yield* store.recordDriverEvent(command.runId, {
                      ownerEpoch: 7,
                      generation: 1,
                      eventId: 'launch-terminal',
                      occurredAt: ts,
                      event: { kind: 'turnCompleted', nativeTurnId: 'native-turn' },
                    })
                    const coordinator = lifecycle.coordinator
                    if (!coordinator) return yield* Effect.die('The coordinator was not opened for this harness.')
                    yield* coordinator.runFinished({ runId: command.runId, taskId: command.taskId })
                  })
                : Effect.void,
            ),
            Effect.as({} as never),
          ),
        interrupt: (runId: string) =>
          Effect.sync(() => {
            interrupts.push(runId)
          }),
        cancelQueuedFollowUp: () => Effect.void,
        enqueueFollowUp: (command: { readonly commandId: string }) =>
          Effect.sync(() => {
            followUps.push(command.commandId)
          }).pipe(Effect.as({} as never)),
      } as unknown as ExecutionService['Service'])
    }),
  ).pipe(Layer.provideMerge(base))
  const service = DelegationService.layer({
    loadConnections: () => Effect.succeed(catalog),
    ...(options.createWorktree ? { createWorktree: options.createWorktree } : {}),
  }).pipe(Layer.provideMerge(DelegationCoordinator.layer), Layer.provideMerge(execution))
  const runtime = ManagedRuntime.make(service)
  return { runtime, starts, interrupts, followUps, lifecycle }
}

type Built = ReturnType<typeof buildHarness>

/** Opens the store and seeds a live parent Run, which the start path requires. */
async function openParent(built: Built) {
  const store = await built.runtime.runPromise(WorkspaceStore)
  const service = await built.runtime.runPromise(DelegationService)
  built.lifecycle.coordinator = await built.runtime.runPromise(DelegationCoordinator)
  await built.runtime.runPromise(store.registerProject({ project, mainCheckout: checkout }))
  await built.runtime.runPromise(store.createTask({ task: parentTask, conversation: parentConversation }))
  await built.runtime.runPromise(acceptRun(store, parentCommand))
  return { store, service }
}

const childCallerOf = (command: BeginRunCommand): DelegationCallerScope => ({
  projectId: project.id,
  taskId: command.taskId,
  conversationId: command.conversationId,
  runId: command.runId,
  accessMode: 'auto',
})

describe('DelegationService', () => {
  it('replays a start with the same client request id without launching a second child', async () => {
    const built = buildHarness()
    try {
      const { service } = await openParent(built)
      const first = await built.runtime.runPromise(
        service.start(parentCaller, request({ clientRequestId: 'req-1' })),
      )
      const second = await built.runtime.runPromise(
        service.start(parentCaller, request({ clientRequestId: 'req-1' })),
      )
      expect(second.delegationId).toBe(first.delegationId)
      expect(built.starts).toHaveLength(1)
    } finally {
      await built.runtime.dispose()
    }
  })

  it('answers a replay even when the parent has since reached its limit', async () => {
    const built = buildHarness()
    try {
      const { service } = await openParent(built)
      const first = await built.runtime.runPromise(service.start(parentCaller, request({ clientRequestId: 'keep' })))
      for (const id of ['a', 'b', 'c']) {
        await built.runtime.runPromise(service.start(parentCaller, request({ clientRequestId: id })))
      }
      const replayed = await built.runtime.runPromise(
        service.start(parentCaller, request({ clientRequestId: 'keep' })),
      )
      expect(replayed.delegationId).toBe(first.delegationId)
    } finally {
      await built.runtime.dispose()
    }
  })

  it('refuses to start from a Run that is missing or has finished', async () => {
    const built = buildHarness()
    try {
      const { store, service } = await openParent(built)
      const missing = await built.runtime.runPromise(
        service.start({ ...parentCaller, runId: 'run-missing' as never }, request()).pipe(Effect.flip),
      )
      expect(missing.code).toBe('parent-not-active')

      await built.runtime.runPromise(
        store.recordDriverEvent(parentCommand.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'parent-done',
          occurredAt: ts,
          event: { kind: 'turnCompleted', nativeTurnId: 'native-turn' },
        }),
      )
      const finished = await built.runtime.runPromise(service.start(parentCaller, request()).pipe(Effect.flip))
      expect(finished.code).toBe('parent-not-active')
      expect(built.starts).toHaveLength(0)
    } finally {
      await built.runtime.dispose()
    }
  })

  it('refuses a delegated task that tries to start another delegation', async () => {
    const built = buildHarness()
    try {
      const { service } = await openParent(built)
      await built.runtime.runPromise(service.start(parentCaller, request({ clientRequestId: 'first' })))
      const child = built.starts[0]
      if (!child) throw new Error('The first delegation did not launch a child Run.')
      const refused = await built.runtime.runPromise(
        service.start(childCallerOf(child), request({ clientRequestId: 'grandchild' })).pipe(Effect.flip),
      )
      expect(refused.code).toBe('depth-exceeded')
      expect(built.starts).toHaveLength(1)
    } finally {
      await built.runtime.dispose()
    }
  })

  it('refuses the fifth active delegation of one parent Run', async () => {
    const built = buildHarness()
    try {
      const { service } = await openParent(built)
      for (const id of ['a', 'b', 'c', 'd']) {
        await built.runtime.runPromise(service.start(parentCaller, request({ clientRequestId: id })))
      }
      const refused = await built.runtime.runPromise(
        service.start(parentCaller, request({ clientRequestId: 'e' })).pipe(Effect.flip),
      )
      expect(refused.code).toBe('limit-exceeded')
      expect(built.starts).toHaveLength(4)
    } finally {
      await built.runtime.dispose()
    }
  })

  it('refuses an escalated access mode and an explicit mode the connection lacks', async () => {
    const built = buildHarness()
    try {
      const { service } = await openParent(built)
      const escalated = await built.runtime.runPromise(
        service.start(parentCaller, request({ accessMode: 'full-access' })).pipe(Effect.flip),
      )
      expect(escalated.code).toBe('access-escalation-denied')

      const unsupported = await built.runtime.runPromise(
        service.start(parentCaller, request({ accessMode: 'auto' })).pipe(Effect.flip),
      )
      expect(unsupported.code).toBe('unsupported-access-mode')
      expect(built.starts).toHaveLength(0)
    } finally {
      await built.runtime.dispose()
    }
  })

  it('steps an inherited access mode down to what the connection supports and records the step', async () => {
    const built = buildHarness()
    try {
      const { store, service } = await openParent(built)
      const summary = await built.runtime.runPromise(service.start(parentCaller, request()))
      expect(summary).toMatchObject({ accessMode: 'auto-accept-edits', accessModeSteppedDownFrom: 'auto' })
      expect(built.starts[0]?.accessMode).toBe('auto-accept-edits')
      const record = await built.runtime.runPromise(store.getDelegation(summary.delegationId))
      expect(record).toMatchObject({ accessMode: 'auto-accept-edits', accessModeSteppedDownFrom: 'auto' })
    } finally {
      await built.runtime.dispose()
    }
  })

  it('passes a listed effort to the child Run and refuses one the chosen model does not offer', async () => {
    const built = buildHarness()
    try {
      const { store, service } = await openParent(built)
      const summary = await built.runtime.runPromise(
        service.start(
          parentCaller,
          request({ target: { connectionId: 'codex-1', modelId: 'gpt-5', modeId: 'high' } }),
        ),
      )
      const record = await built.runtime.runPromise(store.getDelegation(summary.delegationId))
      expect(record).toMatchObject({ modelId: 'gpt-5', modeId: 'high' })
      expect(built.starts[0]?.modeId).toBe('high')

      const refused = await built.runtime.runPromise(
        service.start(
          parentCaller,
          request({ clientRequestId: 'bad-effort', target: { connectionId: 'codex-1', modelId: 'gpt-5', modeId: 'turbo' } }),
        ).pipe(Effect.flip),
      )
      expect(refused.code).toBe('invalid-request')
    } finally {
      await built.runtime.dispose()
    }
  })

  it('marks a settled result read on status and leaves a running delegation unread', async () => {
    const built = buildHarness()
    try {
      const { store, service } = await openParent(built)
      const started = await built.runtime.runPromise(service.start(parentCaller, request()))
      const running = await built.runtime.runPromise(service.status(parentCaller, started.delegationId))
      expect(running).toMatchObject({ settled: false })
      expect((await built.runtime.runPromise(store.getDelegation(started.delegationId)))?.resultReadAt).toBeNull()

      await built.runtime.runPromise(
        store.settleDelegation({
          commandId: 'settle-for-status',
          delegationId: started.delegationId,
          status: 'completed',
          resultText: 'Audit done',
          resultTruncated: false,
          occurredAt: ts,
        }),
      )
      const settled = await built.runtime.runPromise(service.status(parentCaller, started.delegationId))
      expect(settled).toMatchObject({ status: 'completed', settled: true, resultText: 'Audit done' })
      expect((await built.runtime.runPromise(store.getDelegation(started.delegationId)))?.resultReadAt).not.toBeNull()
    } finally {
      await built.runtime.dispose()
    }
  })

  it('gives a wait caller a child that settles during launch, and queues no wake for the parent', async () => {
    const built = buildHarness({ settleChildOnLaunch: true })
    try {
      const { store, service } = await openParent(built)
      const summary = await built.runtime.runPromise(service.start(parentCaller, request({ wait: true })))
      expect(summary).toMatchObject({ status: 'completed', settled: true, waitTimedOut: false })
      const record = await built.runtime.runPromise(store.getDelegation(summary.delegationId))
      expect(record).toMatchObject({ wakeState: 'disposed' })
      expect(built.followUps).toEqual([])
    } finally {
      await built.runtime.dispose()
    }
  })

  it('lets only the direct parent cancel a delegation, while the user may cancel any', async () => {
    const built = buildHarness()
    try {
      const { service } = await openParent(built)
      const started = await built.runtime.runPromise(service.start(parentCaller, request()))
      const sibling: DelegationCallerScope = { ...parentCaller, taskId: 'task-other' as never }
      const refused = await built.runtime.runPromise(
        service.cancel(sibling, started.delegationId).pipe(Effect.flip),
      )
      expect(refused.code).toBe('not-found')
      expect(built.interrupts).toEqual([])

      const cancelled = await built.runtime.runPromise(service.cancel(parentCaller, started.delegationId))
      expect(cancelled.cancelRequested).toBe(true)
      expect(built.interrupts).toEqual([built.starts[0]?.runId])

      const second = await built.runtime.runPromise(service.start(parentCaller, request({ clientRequestId: 'second' })))
      const fromUser = await built.runtime.runPromise(service.cancelFromUser(second.delegationId))
      expect(fromUser.cancelRequestedAt).not.toBeNull()
    } finally {
      await built.runtime.dispose()
    }
  })

  it('gives a worktree delegation its own checkout branched from the parent branch', async () => {
    const created: Array<{ readonly baseBranch: string; readonly checkoutId: string }> = []
    const worktree: WorkspaceCheckout = {
      id: 'checkout-wt' as never,
      projectId: project.id,
      kind: 'worktree',
      path: 'C:/worktrees/child',
      branch: 'delegation/child',
      createdAt: ts,
    }
    const built = buildHarness({
      createWorktree: request =>
        Effect.sync(() => {
          created.push({ baseBranch: request.baseBranch, checkoutId: request.checkoutId })
          return worktree
        }),
    })
    try {
      const { store, service } = await openParent(built)
      await built.runtime.runPromise(
        store.registerCheckout({
          commandId: 'register-worktree',
          checkout: { ...worktree, kind: 'worktree' },
        }),
      )
      const summary = await built.runtime.runPromise(service.start(parentCaller, request({ isolation: 'worktree' })))
      expect(summary.isolation).toBe('worktree')
      expect(created).toEqual([{ baseBranch: 'feature/parent', checkoutId: checkout.id }])
      expect(built.starts[0]?.checkoutId).toBe(worktree.id)
    } finally {
      await built.runtime.dispose()
    }
  })
})
