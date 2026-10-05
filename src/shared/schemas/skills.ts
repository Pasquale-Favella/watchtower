import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { DEFAULT_SKILLS_THRESHOLDS } from '../skills-defaults.js'

export { DEFAULT_SKILLS_THRESHOLDS } from '../skills-defaults.js'

const finiteNumber = Schema.Finite
const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))
const positiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** The Skills section wire contract (ticket 24, ADR 0005): the deterministic
 * detection payload mined from the aggregation seam plus the on-disk skill
 * inventory. Everything here is pure local data — no consent, no network. */

/** Where a candidate pattern came from: explicit per-call skills + the
 * classifier's `subCategory` capabilities (seam a), normalized recurring
 * bash commands (seam b), or non-primitive tool usage (seam a tool breakdown). */
export const skillsSourceSchema = Schema.Literals(['skill', 'bash', 'tool'])
export type SkillsSource = Schema.Schema.Type<typeof skillsSourceSchema>

/** The tunable frequency × spread gate (defaults 5 × 2) that splits a
 * candidate into a draft vs the opportunity list. App settings, never code
 * constants: the renderer owns the values (Settings › Skills) and passes
 * them with every view request. */
export const skillsThresholdsSchema = Schema.Struct({
  frequency: writable(
    positiveInteger.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SKILLS_THRESHOLDS.frequency))),
  ),
  spread: writable(positiveInteger.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SKILLS_THRESHOLDS.spread)))),
})
export type SkillsThresholds = Schema.Schema.Type<typeof skillsThresholdsSchema>

/** One session where a candidate pattern appeared (evidence rows, newest
 * first, capped per candidate). */
export const candidateSourceSessionSchema = Schema.Struct({
  sessionId: writable(Schema.String),
  project: writable(Schema.String),
  date: writable(Schema.String),
  turns: writable(finiteNumber),
  costUSD: writable(finiteNumber),
})
export type CandidateSourceSession = Schema.Schema.Type<typeof candidateSourceSessionSchema>

/** A mined candidate pattern: a normalized key (skill id, capability
 * subCategory, normalized bash command, or tool name), its frequency and
 * spread across sessions/projects in the current scope, cost/turn totals,
 * and the evidence sessions behind it. The same shape serves drafts
 * (threshold-qualifying) and opportunities (repeated but below threshold). */
export const skillCandidateSchema = Schema.Struct({
  name: writable(Schema.String),
  source: writable(skillsSourceSchema),
  frequency: writable(finiteNumber),
  spreadSessions: writable(finiteNumber),
  spreadProjects: writable(finiteNumber),
  costUSD: writable(finiteNumber),
  turns: writable(finiteNumber),
  /** Newest occurrence timestamp (evidence sort key). */
  latest: writable(Schema.String),
  /** First raw occurrence (the un-normalized bash command, or the skill id). */
  sample: writable(Schema.String),
  sourceSessions: writable(mutableArray(candidateSourceSessionSchema)),
})
export type SkillCandidate = Schema.Schema.Type<typeof skillCandidateSchema>

/** An on-disk skill-inventory entry never invoked in the current scope. */
export const ghostSkillSchema = Schema.Struct({
  name: writable(Schema.String),
  /** The inventory root the entry was found in (e.g. ~/.claude/skills). */
  root: writable(Schema.String),
})
export type GhostSkill = Schema.Schema.Type<typeof ghostSkillSchema>

/** A not-a-skill dismissal: a candidate pattern the user rejected, so the
 * detector never resurfaces it. Ledger-persisted (like consent) — the
 * dismissal survives `clear()` and the detector filters on every fetch. */
export const skillsDismissalSchema = Schema.Struct({
  source: writable(skillsSourceSchema),
  name: writable(Schema.String),
  reason: writable(Schema.String),
  created: writable(Schema.String),
})
export type SkillsDismissal = Schema.Schema.Type<typeof skillsDismissalSchema>

export const skillsDismissalRequestSchema = Schema.Struct({
  source: writable(skillsSourceSchema),
  name: writable(Schema.String),
  reason: writable(Schema.String),
})
export type SkillsDismissalRequest = Schema.Schema.Type<typeof skillsDismissalRequestSchema>

export const skillsDismissalResultSchema = Schema.Union([
  Schema.Struct({ ok: writable(Schema.Literal(true)) }),
  Schema.Struct({ ok: writable(Schema.Literal(false)), error: writable(Schema.String) }),
])
export type SkillsDismissalResult = Schema.Schema.Type<typeof skillsDismissalResultSchema>

/** User-initiated save: the renderer asks, main opens the OS save dialog
 * (defaulting to `.agents/skills/`), and only a dialog-confirmed path is
 * written — the app never writes on its own. */
export const skillsSaveRequestSchema = Schema.Struct({
  name: writable(Schema.String),
  content: writable(Schema.String),
})
export type SkillsSaveRequest = Schema.Schema.Type<typeof skillsSaveRequestSchema>

export const skillsSaveResultSchema = Schema.Union([
  Schema.Struct({ ok: writable(Schema.Literal(true)), path: writable(Schema.String) }),
  Schema.Struct({ ok: writable(Schema.Literal(false)), error: writable(Schema.String) }),
])
export type SkillsSaveResult = Schema.Schema.Type<typeof skillsSaveResultSchema>

export const skillsPayloadSchema = Schema.Struct({
  period: writable(
    Schema.Struct({ start: writable(Schema.NullOr(Schema.String)), end: writable(Schema.NullOr(Schema.String)) }),
  ),
  summary: writable(
    Schema.Struct({
      sessions: writable(finiteNumber),
      calls: writable(finiteNumber),
      skillEvents: writable(finiteNumber),
      bashEvents: writable(finiteNumber),
      toolEvents: writable(finiteNumber),
      drafts: writable(finiteNumber),
      opportunities: writable(finiteNumber),
      ghosts: writable(finiteNumber),
    }),
  ),
  drafts: writable(mutableArray(skillCandidateSchema)),
  opportunities: writable(mutableArray(skillCandidateSchema)),
  ghosts: writable(mutableArray(ghostSkillSchema)),
})
export type SkillsPayload = Schema.Schema.Type<typeof skillsPayloadSchema>
