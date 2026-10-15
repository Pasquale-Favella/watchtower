import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))

/** The pipeline's parsed token-usage record. Raw SQLite counts arrive as
 * numbers; the schema enforces that (no silent string coercion). */
export const tokenUsageSchema = Schema.Struct({
  inputTokens: Schema.mutableKey(finiteNumber),
  outputTokens: Schema.mutableKey(finiteNumber),
  cacheCreationInputTokens: Schema.mutableKey(finiteNumber),
  cacheReadInputTokens: Schema.mutableKey(finiteNumber),
  cachedInputTokens: Schema.mutableKey(finiteNumber),
  reasoningTokens: Schema.mutableKey(finiteNumber),
  webSearchRequests: Schema.mutableKey(finiteNumber),
})
export type TokenUsage = Schema.Schema.Type<typeof tokenUsageSchema>

/** A single tool invocation within a call's tool sequence (rich capture). The
 * optional `file`/`command` make the shape tolerant of providers that only
 * record the tool name. */
export const toolCallSchema = Schema.Struct({
  tool: Schema.mutableKey(Schema.String),
  file: Schema.mutableKey(Schema.optional(Schema.String)),
  command: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type ToolCall = Schema.Schema.Type<typeof toolCallSchema>
