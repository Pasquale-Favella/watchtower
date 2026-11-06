import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import type { CommandReceipt } from '@/shared/schemas/workspace-store.js'

import { updateWorkspaceDraftAtom, workspaceDraftsAtom } from './draft-atoms.js'
import { conversationSubmissionsAtom, updatePendingStartStoreAtom } from './pending-start-atoms.js'
import type { PendingStartCommand } from './pending-start-state.js'
import { isRejectedSubmission, submissionErrorMessage } from './submission-state.js'

/** Delivery and recovery belong to the window, including when the composer changes route. */
export const deliverConversationSubmission = Effect.fnUntraced(function* <E, R>(
  registry: AtomRegistry.AtomRegistry,
  command: PendingStartCommand,
  send: Effect.Effect<CommandReceipt, E, R>,
) {
  const outcome = yield* Effect.exit(send)
  yield* Effect.sync(() => {
    const current = registry.get(conversationSubmissionsAtom)[command.conversationId]
    if (!current || current.record.command.commandId !== command.commandId) return
    if (Exit.isSuccess(outcome)) {
      registry.set(updatePendingStartStoreAtom, {
        kind: 'clear',
        conversationId: command.conversationId,
        commandId: command.commandId,
      })
      registry.set(conversationSubmissionsAtom, {
        ...registry.get(conversationSubmissionsAtom),
        [command.conversationId]: { ...current, runId: outcome.value.runId, state: 'sent', error: null },
      })
      return
    }
    const found = Cause.findError(outcome.cause)
    const error = found._tag === 'Success' ? found.success : undefined
    const rejected = isRejectedSubmission(error)
    registry.set(updatePendingStartStoreAtom, {
      kind: rejected ? 'clear' : 'uncertain',
      conversationId: command.conversationId,
      commandId: command.commandId,
    })
    registry.set(conversationSubmissionsAtom, {
      ...registry.get(conversationSubmissionsAtom),
      [command.conversationId]: {
        ...current,
        state: rejected ? 'failed' : 'reconnecting',
        error: submissionErrorMessage(error),
      },
    })
    if (rejected && !registry.get(workspaceDraftsAtom)[command.conversationId]?.text) {
      registry.set(updateWorkspaceDraftAtom, { conversationId: command.conversationId, text: current.record.rawDraft })
    }
  })
  if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause)
  return outcome.value
})
