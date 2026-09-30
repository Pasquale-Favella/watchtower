import { z } from 'zod'

import type { LedgerCallRow } from '../../shared/schemas/ledger.js'
import { toolCallSchema } from '../../shared/schemas/pipeline.js'

/**
 * Purpose-shaped read projections for the ledger's bulk reads.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT `src/shared/schemas/ledger.ts`.
 * `docs/research/query-path-measurement.md` measured the query path on a
 * 500k-call ledger: `read:getCalls` 11.5 s and `read:getTurns` 7.2 s are 97%
 * of a 19.3 s `store:views`, and 47% of `getCalls` is the `z.array(...)` pass
 * over 38 columns of which six are `*_json` blobs. The study's own conclusion
 * (§4.2) is that the reachable win is "cutting the column set", not re-grouping
 * the aggregation.
 *
 * That cut is a DATA-ACCESS change with internal consumers only, so the shapes
 * live here rather than in the shared wire schemas: a parallel programme owns
 * `src/shared/schemas/ledger.ts` and is migrating it to Effect Schema, and an
 * edit from this side would collide with it for no benefit. Nothing here is a
 * wire contract — the wire is whatever the Section builders emit, and it is
 * unchanged by these reads.
 *
 * The row schemas stay Zod, matching the four existing reads. The measured win
 * here is BYTES READ, not decode speed: `docs/plans/effect-adoption.md` §7
 * already records that "Effect Schema is not faster than Zod 4, and the
 * 47%-of-`getCalls` decode cost is fixed by _reading less_". Switching libraries
 * would also widen `LedgerQueriesPort`'s error channel from `SqlError` to
 * `SqlError | ParseError` and force every fake to change, for no measured gain;
 * the library decision belongs to the schema-migration programme.
 */

// ── Column helpers, mirrored from the shared row schemas ───────────────────
// `src/shared/schemas/ledger.ts` keeps its JSON helpers private, and this file
// may not modify it, so the two are restated here. Same semantics, same order:
// a `*_json` column is TEXT holding `JSON.stringify` output and is parsed AND
// validated in one pipe.

const jsonParse = z.string().transform(s => JSON.parse(s) as unknown)

const stringArrayJson = jsonParse.pipe(z.array(z.string()))
const toolCallMatrixJson = jsonParse.pipe(z.array(z.array(toolCallSchema)))

/** Coerce an INTEGER/REAL column to a JS number, as the shared row schemas do. */
const num = z.coerce.number()

/**
 * The `ledger_call` columns this read selects, as a type. The compile-time
 * half of "the narrow row is a strict subset of the wide row": the schema's
 * transform is annotated with exactly this type, so a renamed or mistyped
 * column in the transform is a type error rather than a silently absent field.
 */
export type LedgerCallFactsRow = Omit<
  LedgerCallRow,
  | 'callKey'
  | 'projectPath'
  | 'agentType'
  | 'locAdded'
  | 'locRemoved'
  | 'interrupted'
  | 'userModified'
  | 'toolErrors'
  | 'editFailed'
>

/**
 * `getCallFacts` — the aggregation seam's `ledger_call` projection.
 *
 * 29 of `getCalls`'s 38 columns. Every kept column is read by exactly one of
 * the three consumers of the `queryScope` seam, at the sites named below; the
 * nine dropped columns have NO read-path consumer at all. The consumption map
 * is derived by grep over the tree, not assumed — `tests/ledger-narrow-reads.test.ts`
 * re-derives the dropped half by scanning the consumer files and pins the kept
 * half's key set at run time.
 *
 * KEPT, and who reads it (`file:line`, as of this file's introduction; the
 * consumer-file scan in `tests/ledger-narrow-reads.test.ts` is the machine-
 * checked half and does not depend on these staying put):
 *   source_id                  aggregate.ts:135 (provider filter), :516 (session key),
 *                              :532 (session index); tools.ts:91, :173
 *   session_id                 aggregate.ts:198, :516, :532; tools.ts:91, :173
 *   turn_index                 aggregate.ts:516, :524; tools.ts:173
 *   call_index                 aggregate.ts:525 (per-turn call order)
 *   provider                   aggregate.ts:161, :347; tools.ts:97, :182
 *   model                      aggregate.ts:95 (reprice), :136 (alias), :184 (rawModel);
 *                              tools.ts:171, :183
 *   timestamp                  aggregate.ts:175, :197, :396-397; overview.ts:176;
 *                              skills-view.ts:216, :231, :245; spend-view.ts:197;
 *                              views.ts:125; tools.ts:90, :170, :181
 *   speed                      aggregate.ts:103 (reprice), :174; views.ts:247;
 *                              compare-view.ts:274
 *   base_cost_usd              aggregate.ts:93, :106
 *   is_estimated               aggregate.ts:180, :336; views.ts:246; tools.ts:188
 *   savings_usd                aggregate.ts:185-186, :335; tools.ts:187
 *   savings_baseline_model     aggregate.ts:187
 *   input_tokens               aggregate.ts:91, :98, :152; models-view.ts:183, :190,
 *                              :314, :363; optimize-view.ts:1203; views.ts:254;
 *                              tools.ts:190
 *   output_tokens              aggregate.ts:92, :99, :153; models-view.ts:156, :364;
 *                              optimize-view.ts:1204; views.ts:255; tools.ts:191
 *   cache_creation_input_tokens aggregate.ts:100, :154; models-view.ts:192, :322, :366;
 *                              optimize-view.ts:451, :1205; views.ts:258; tools.ts:193
 *   cache_read_input_tokens    aggregate.ts:101, :155; models-view.ts:163, :193, :367;
 *                              compare-view.ts:109; optimize-view.ts:839, :1206;
 *                              views.ts:257; tools.ts:192
 *   cached_input_tokens        aggregate.ts:101 (max with cache-read);
 *                              models-view.ts:163, :368
 *   reasoning_tokens           aggregate.ts:157; models-view.ts:156, :365; views.ts:256;
 *                              tools.ts:194
 *   web_search_requests        aggregate.ts:102, :158; models-view.ts:194, :369
 *   cache_creation_one_hour_tokens aggregate.ts:181
 *   dedup_key                  aggregate.ts:177 — becomes ParsedApiCall.deduplicationKey,
 *                              which tests/aggregate.test.ts:66 pins by deep-equality
 *                              against the parser's own assembly, so it stays.
 *   tools_json                 aggregate.ts:168, :172-173, :376; views.ts:249 (wire);
 *                              compare-view.ts:267, :272; skills-view.ts:237; overview.ts:175;
 *                              tools.ts:175, :196
 *   mcp_tools_json             aggregate.ts:169, :380; views.ts:250 (wire);
 *                              optimize-view.ts:752, :1181
 *   skills_json                aggregate.ts:170; skills-view.ts:209; views.ts:251 (wire);
 *                              optimize-view.ts:455, :1187; tools.ts:197
 *   subagent_types_json        aggregate.ts:171, :389; views.ts:252 (wire);
 *                              optimize-view.ts:454; tools.ts:199
 *   bash_commands_json         aggregate.ts:176, :385, :213 (PR-ref fallback); views.ts:123;
 *                              skills-view.ts:222; tools.ts:198
 *   tool_sequence_json         aggregate.ts:182, :214 (PR-ref fallback);
 *                              overview.ts:211-212; optimize-view.ts:456
 *
 * KEPT although no Section reads them, because `queryScope`'s OTHER consumer —
 * the read-only ledger MCP server's `ledger_calls` drill-down, in a directory
 * this slice may not edit — filters and returns both:
 *   project                    tools.ts:172, :184
 *   working_directory          tools.ts:185
 *
 * DROPPED, with no reader anywhere in `src/main`:
 *   call_key          a STORED generated column whose only job is the UNIQUE
 *                     constraint (store/ledger.ts:125-126). `tests/ledger.test.ts`
 *                     pins it on `getCalls()`, which is why the wide read stays.
 *   project_path      nothing reads the call's path; the seam's project path
 *                     comes from `ledger_session.project_path` (aggregate.ts:483).
 *   agent_type        nothing reads the call's agent type; `SessionSummary.agentType`
 *                     comes from `ledger_session.agent_type` (aggregate.ts:432).
 *   loc_added, loc_removed, interrupted, user_modified, tool_errors, edit_failed
 *                     `reconstructCall` (aggregate.ts:150-189) never copies these
 *                     onto the reconstructed `ParsedApiCall`, and no view reads
 *                     them; they are capture-only fields (pipeline/types.ts:150-160).
 *
 * WHY THERE IS NO MATCHING `getTurnFacts`. The turn read is the other 97%-of-time
 * half of the query path (`read:getTurns` is 9.9 s of a 27.6 s `store:views` at
 * 500k, and `user_message` alone is 525 B of a 717 B turn row), so the obvious
 * next cut is dropping that column. It is not available, and the reason is worth
 * recording so the next reader does not re-derive it:
 *
 *  - All TWELVE `ledger_turn` columns have a reader. `source_id`/`session_id`/
 *    `turn_index` key the scope (aggregate.ts:524), `timestamp` and `retries`
 *    and `has_edits` and `category` and `sub_category` drive the breakdowns
 *    (aggregate.ts:197-218), `git_branch` reaches the wire through
 *    `SessionDetail.gitBranch` (views.ts:237) and the by-branch report
 *    (pipeline/sessions-report.ts:1127-1130), `pr_refs_json` drives PR
 *    attribution, and `spawn_tool_use_ids_json` drives `buildSpawnPrSets`
 *    (aggregate.ts:217, :449). There is no dead turn column.
 *  - `user_message` cannot be dropped even though only four consumers read it
 *    (views.ts:119-120 global search, views.ts:235 `SessionDetail` — the frozen
 *    renderer wire, overview.ts:153 correction scan, optimize-view.ts:447 ghost
 *    commands): `reconstructTurn` ALSO feeds it to the query-time PR-ref
 *    fallback at aggregate.ts:212, so dropping it would change
 *    `turn.prRefs` → `summary.prLinks` → `prRefsAtRangeStart` and therefore the
 *    Pull Requests payload. That is a semantic change to a shared read, not a
 *    data-access one, and `ClassifiedTurn.userMessage` is a required `string` in
 *    `src/main/pipeline/types.ts` — so a purpose flag would degrade it to `''`
 *    with nothing in the type system objecting. Recorded as a follow-up, not
 *    taken here.
 */
export const ledgerCallFactsRowSchema = z
  .object({
    source_id: num,
    session_id: z.string(),
    turn_index: num,
    call_index: num,
    dedup_key: z.string().nullable(),
    provider: z.string(),
    model: z.string(),
    timestamp: z.string(),
    speed: z.enum(['standard', 'fast']),
    project: z.string().nullable(),
    working_directory: z.string().nullable(),
    base_cost_usd: num,
    is_estimated: num,
    savings_usd: num,
    savings_baseline_model: z.string().nullable(),
    input_tokens: num,
    output_tokens: num,
    cache_creation_input_tokens: num,
    cache_read_input_tokens: num,
    cached_input_tokens: num,
    reasoning_tokens: num,
    web_search_requests: num,
    cache_creation_one_hour_tokens: num,
    tools_json: stringArrayJson,
    mcp_tools_json: stringArrayJson,
    skills_json: stringArrayJson,
    subagent_types_json: stringArrayJson,
    bash_commands_json: stringArrayJson,
    tool_sequence_json: toolCallMatrixJson,
  })
  .transform((r): LedgerCallFactsRow => ({
    sourceId: r.source_id,
    sessionId: r.session_id,
    turnIndex: r.turn_index,
    callIndex: r.call_index,
    dedupKey: r.dedup_key,
    provider: r.provider,
    model: r.model,
    timestamp: r.timestamp,
    speed: r.speed,
    project: r.project,
    workingDirectory: r.working_directory,
    baseCostUSD: r.base_cost_usd,
    isEstimated: r.is_estimated,
    savingsUSD: r.savings_usd,
    savingsBaselineModel: r.savings_baseline_model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationInputTokens: r.cache_creation_input_tokens,
    cacheReadInputTokens: r.cache_read_input_tokens,
    cachedInputTokens: r.cached_input_tokens,
    reasoningTokens: r.reasoning_tokens,
    webSearchRequests: r.web_search_requests,
    cacheCreationOneHourTokens: r.cache_creation_one_hour_tokens,
    tools: r.tools_json,
    mcpTools: r.mcp_tools_json,
    skills: r.skills_json,
    subagentTypes: r.subagent_types_json,
    bashCommands: r.bash_commands_json,
    toolSequence: r.tool_sequence_json,
  }))
