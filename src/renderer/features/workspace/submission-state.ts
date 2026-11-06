import * as Schema from 'effect/Schema'

import { WorkspaceRpcError } from '@/shared/rpc/workspace.js'
import type { AgentRunId } from '@/shared/schemas/workspace.js'
import type { WorkspaceConversationPageItem } from '@/shared/schemas/workspace-store.js'

import type { ConversationUserMessage } from './conversation-view.js'
import type { PendingStartRecord } from './pending-start-state.js'

export interface ConversationSubmission {
  readonly record: PendingStartRecord
  readonly runId: AgentRunId | null
  readonly state: 'sending' | 'sent' | 'reconnecting' | 'failed'
  readonly error: string | null
}

/** Request errors can be corrected in the editor; transport failures keep the original command. */
export function isRejectedSubmission(error: unknown): boolean {
  return (
    Schema.is(WorkspaceRpcError)(error) &&
    [
      'invalid-request',
      'unsupported-access-mode',
      'not-found',
      'stale',
      'conflict',
      'checkout-busy',
      'checkout-in-use',
    ].includes(error.code)
  )
}

export function submissionErrorMessage(error: unknown): string {
  if (Schema.is(WorkspaceRpcError)(error)) return error.message
  return 'The connection was interrupted while sending. Your message is saved.'
}

export function submissionEcho(
  submission: ConversationSubmission,
  items: readonly WorkspaceConversationPageItem[],
): WorkspaceConversationPageItem | undefined {
  return items.find(
    item =>
      item.userMessage &&
      (item.event.runId === submission.runId || item.event.data.commandId === submission.record.command.commandId),
  )
}

export function optimisticUserMessage(submission: ConversationSubmission): ConversationUserMessage {
  const { record } = submission
  const id = `pending:${record.command.commandId}`
  return {
    kind: 'user',
    id: `message:${id}`,
    sequence: 0,
    message: {
      id,
      content: record.rawDraft,
      attachments: record.command.attachments,
      createdAt: new Date(record.updatedAt).toISOString(),
    },
  }
}
