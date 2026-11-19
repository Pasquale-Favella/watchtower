import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { agentDriverEventSchema } from '@/shared/schemas/execution.js'
import type { AgentRunId, ConversationId } from '@/shared/schemas/workspace.js'

const MAX_PAGES = 200

export interface RunResult {
  /** The assistant text of one Run, keeping the most recent `maxChars` characters (the final answer). */
  readonly text: string
  readonly truncated: boolean
}

/**
 * Captures the assistant text one Run produced. Tool output is excluded: a result is the agent's answer, not its
 * transcript. The text is untrusted data from another agent and is framed as such when it is delivered.
 */
export const captureRunResult = Effect.fnUntraced(function* (
  store: WorkspaceStore['Service'],
  conversationId: ConversationId,
  runId: AgentRunId,
  maxChars: number,
): Effect.fn.Return<RunResult, Error> {
  let afterSequence = 0
  let pages = 0
  const chunks: string[] = []
  while (pages < MAX_PAGES) {
    const page = yield* store
      .readConversationPage(conversationId, afterSequence, 200)
      .pipe(Effect.mapError(() => new Error('Run result could not be read.')))
    pages += 1
    for (const item of page.items) {
      const event = item.event
      if (event.kind !== 'driverEvent' || event.runId !== runId || event.payloadTruncated) continue
      const decoded = Schema.decodeUnknownOption(agentDriverEventSchema)(event.data['event'])
      if (decoded._tag === 'None' || decoded.value.kind !== 'textDelta') continue
      chunks.push(decoded.value.text)
    }
    if (!page.hasMore || page.nextAfterSequence === null) break
    afterSequence = page.nextAfterSequence
  }
  const full = chunks.join('')
  return full.length > maxChars
    ? { text: full.slice(full.length - maxChars), truncated: true }
    : { text: full, truncated: false }
})
