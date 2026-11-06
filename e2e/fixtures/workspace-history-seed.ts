import { join } from 'node:path'

import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Schema from 'effect/Schema'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { agentRunIdSchema } from '@/shared/schemas/workspace.js'
import {
  beginRunCommandSchema,
  createTaskCommandSchema,
  registerProjectCommandSchema,
} from '@/shared/schemas/workspace-store.js'

/** Test-owned writer closes before Electron starts its production worker. */
export async function seedWorkspaceHistory(profile: string, checkoutPath: string) {
  const runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename: join(profile, 'workspace.db') }))
  const at = '2026-10-30T12:00:00Z'
  const runId = Schema.decodeUnknownSync(agentRunIdSchema)('history-run')
  try {
    const store = await runtime.runPromise(WorkspaceStore)
    const run = <A, E>(effect: import('effect/Effect').Effect<A, E>) => runtime.runPromise(effect)
    await run(
      store.registerProject(
        Schema.decodeUnknownSync(registerProjectCommandSchema)({
          project: {
            id: 'history-project',
            name: 'History fixture',
            repositoryIdentity: 'fixture:history',
            createdAt: at,
            updatedAt: at,
          },
          mainCheckout: { id: 'history-checkout', kind: 'main', path: checkoutPath, createdAt: at },
        }),
      ),
    )
    await run(
      store.createTask(
        Schema.decodeUnknownSync(createTaskCommandSchema)({
          task: {
            id: 'history-task',
            projectId: 'history-project',
            title: 'Read recent activity',
            description: '',
            createdAt: at,
          },
          conversation: { id: 'history-conversation', createdAt: at },
        }),
      ),
    )
    const owner = await run(store.acquireOwnerEpoch(at))
    await run(
      store.beginRun(
        Schema.decodeUnknownSync(beginRunCommandSchema)({
          commandId: 'history-start',
          issuedAt: at,
          runId,
          taskId: 'history-task',
          conversationId: 'history-conversation',
          checkoutId: 'history-checkout',
          provisionalAgentSessionId: 'history-session',
          generation: 1,
          driverId: 'fixture',
          connectionId: 'fixture',
          prompt: 'Show the recent work.',
        }),
      ),
    )
    await run(store.claimDispatch(runId, owner.ownerEpoch, at))
    await run(
      store.acknowledgeDispatch(runId, {
        ownerEpoch: owner.ownerEpoch,
        nativeSessionId: 'history-native',
        acknowledgedAt: at,
      }),
    )
    for (let index = 0; index < 350; index++) {
      await run(
        store.recordDriverEvent(runId, {
          ownerEpoch: owner.ownerEpoch,
          generation: 1,
          eventId: `history-event-${index}`,
          occurredAt: at,
          event: {
            kind: 'textDelta',
            text:
              index === 0
                ? 'OLDEST_ACTIVITY_MARKER'
                : index === 349
                  ? 'CURRENT_REPLY_VISIBLE\n\n[Open chat file](chat-link.txt:1)'
                  : '.',
            itemId: `message-${index}`,
          },
        }),
      )
    }
    await run(
      store.recordDriverEvent(runId, {
        ownerEpoch: owner.ownerEpoch,
        generation: 1,
        eventId: 'history-large',
        occurredAt: at,
        event: { kind: 'textDelta', text: `FULL_PAYLOAD_RECOVERED ${'x'.repeat(1_100_000)}`, itemId: 'large-reply' },
      }),
    )
    await run(
      store.recordDriverEvent(runId, {
        ownerEpoch: owner.ownerEpoch,
        generation: 1,
        eventId: 'history-complete',
        occurredAt: at,
        event: { kind: 'turnCompleted' },
      }),
    )
  } finally {
    await runtime.dispose()
  }
}
