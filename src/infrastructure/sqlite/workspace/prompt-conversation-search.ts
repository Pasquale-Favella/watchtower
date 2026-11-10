import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as SqlClient from 'effect/sql/SqlClient'

import {
  promptConversationMatchesSchema,
  type promptConversationSearchSchema,
} from '@/shared/schemas/prompt-context.js'
import { conversationIdSchema, taskIdSchema } from '@/shared/schemas/workspace.js'
import { normalizeSearchQuery, scorePromptCommandMatch } from '@/shared/search-ranking.js'

const rowSchema = Schema.Struct({
  conversationId: conversationIdSchema,
  taskId: taskIdSchema,
  title: Schema.String,
  updatedAt: Schema.String,
})

/** Rank titles inside the storage worker; only the best eight identities cross its RPC boundary. */
export const searchPromptConversations = Effect.fn('WorkspaceStore.searchPromptConversations')(function* (
  sql: SqlClient.SqlClient,
  request: Schema.Schema.Type<typeof promptConversationSearchSchema>,
) {
  const rows = yield* sql`
    SELECT c.id AS conversationId, c.task_id AS taskId,
      COALESCE(NULLIF(json_extract(c.payload, '$.title'), ''), json_extract(t.payload, '$.title')) AS title,
      COALESCE(json_extract(c.payload, '$.updatedAt'), json_extract(t.payload, '$.updatedAt')) AS updatedAt
    FROM workspace_conversation c
    JOIN workspace_task t ON t.id = c.task_id
    JOIN workspace_project p ON p.id = t.project_id
    WHERE t.archived = 0 AND json_extract(p.payload, '$.archivedAt') IS NULL
      AND c.id != ${request.excludeConversationId ?? ''}
  `
  const needle = normalizeSearchQuery(request.query)
  const ranked: Array<{ readonly row: Schema.Schema.Type<typeof rowSchema>; readonly score: number }> = []
  for (const raw of rows) {
    const row = yield* Schema.decodeUnknownEffect(rowSchema)(raw)
    const score = needle ? scorePromptCommandMatch(row.title, undefined, needle) : 0
    if (score === null) continue
    ranked.push({ row, score })
    ranked.sort(
      (a, b) =>
        a.score - b.score ||
        b.row.updatedAt.localeCompare(a.row.updatedAt) ||
        a.row.conversationId.localeCompare(b.row.conversationId),
    )
    if (ranked.length > 8) ranked.pop()
  }
  return yield* Schema.decodeUnknownEffect(promptConversationMatchesSchema)(
    ranked.map(({ row }) => ({
      conversationId: row.conversationId,
      taskId: row.taskId,
      title: row.title.slice(0, 512),
    })),
  )
})
