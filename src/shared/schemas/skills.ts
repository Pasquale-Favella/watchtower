import { z } from 'zod'

/**
 * The Skills section wire contract (ticket 24, ADR 0005): the deterministic
 * detection payload mined from the aggregation seam plus the on-disk skill
 * inventory. Everything here is pure local data — no consent, no network.
 */

/** Where a candidate pattern came from: explicit per-call skills + the
 *  classifier's `subCategory` capabilities (seam a), normalized recurring
 *  bash commands (seam b), or non-primitive tool usage (seam a tool breakdown). */
export const skillsSourceSchema = z.enum(['skill', 'bash', 'tool'])
export type SkillsSource = z.infer<typeof skillsSourceSchema>

/** The tunable frequency × spread gate (defaults 5 × 2) that splits a
 *  candidate into a draft vs the opportunity list. App settings, never code
 *  constants: the renderer owns the values (Settings › Skills) and passes
 *  them with every view request. */
export const skillsThresholdsSchema = z.object({
  frequency: z.number().int().min(1).default(5),
  spread: z.number().int().min(1).default(2),
})
export type SkillsThresholds = z.infer<typeof skillsThresholdsSchema>

export const DEFAULT_SKILLS_THRESHOLDS: SkillsThresholds = { frequency: 5, spread: 2 }

/** One session where a candidate pattern appeared (evidence rows, newest
 *  first, capped per candidate). */
export const candidateSourceSessionSchema = z.object({
  sessionId: z.string(),
  project: z.string(),
  date: z.string(),
  turns: z.number(),
  costUSD: z.number(),
})
export type CandidateSourceSession = z.infer<typeof candidateSourceSessionSchema>

/** A mined candidate pattern: a normalized key (skill id, capability
 *  subCategory, normalized bash command, or tool name), its frequency and
 *  spread across sessions/projects in the current scope, cost/turn totals,
 *  and the evidence sessions behind it. The same shape serves drafts
 *  (threshold-qualifying) and opportunities (repeated but below threshold). */
export const skillCandidateSchema = z.object({
  name: z.string(),
  source: skillsSourceSchema,
  frequency: z.number(),
  spreadSessions: z.number(),
  spreadProjects: z.number(),
  costUSD: z.number(),
  turns: z.number(),
  /** Newest occurrence timestamp (evidence sort key). */
  latest: z.string(),
  /** First raw occurrence (the un-normalized bash command, or the skill id). */
  sample: z.string(),
  sourceSessions: z.array(candidateSourceSessionSchema),
})
export type SkillCandidate = z.infer<typeof skillCandidateSchema>

/** An on-disk skill-inventory entry never invoked in the current scope. */
export const ghostSkillSchema = z.object({
  name: z.string(),
  /** The inventory root the entry was found in (e.g. ~/.claude/skills). */
  root: z.string(),
})
export type GhostSkill = z.infer<typeof ghostSkillSchema>

/** A not-a-skill dismissal: a candidate pattern the user rejected, so the
 *  detector never resurfaces it. Ledger-persisted (like consent) — the
 *  dismissal survives `clear()` and the detector filters on every fetch. */
export const skillsDismissalSchema = z.object({
  source: skillsSourceSchema,
  name: z.string(),
  reason: z.string(),
  created: z.string(),
})
export type SkillsDismissal = z.infer<typeof skillsDismissalSchema>

export const skillsDismissalRequestSchema = z.object({
  source: skillsSourceSchema,
  name: z.string(),
  reason: z.string(),
})
export type SkillsDismissalRequest = z.infer<typeof skillsDismissalRequestSchema>

export const skillsDismissalResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type SkillsDismissalResult = z.infer<typeof skillsDismissalResultSchema>

/** The one-shot harness prose request: a candidate's NORMALIZED evidence only
 *  (never raw transcripts — the harness authors from what the detector saw). */
export const skillsProseRequestSchema = z.object({
  source: skillsSourceSchema,
  name: z.string(),
  frequency: z.number(),
  spreadSessions: z.number(),
  spreadProjects: z.number(),
  costUSD: z.number(),
  turns: z.number(),
})
export type SkillsProseRequest = z.infer<typeof skillsProseRequestSchema>

export const skillsProseResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), markdown: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type SkillsProseResult = z.infer<typeof skillsProseResultSchema>

/** User-initiated save: the renderer asks, main opens the OS save dialog
 *  (defaulting to `.agents/skills/`), and only a dialog-confirmed path is
 *  written — the app never writes on its own. */
export const skillsSaveRequestSchema = z.object({
  name: z.string(),
  content: z.string(),
})
export type SkillsSaveRequest = z.infer<typeof skillsSaveRequestSchema>

export const skillsSaveResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type SkillsSaveResult = z.infer<typeof skillsSaveResultSchema>

export const skillsPayloadSchema = z.object({
  period: z.object({ start: z.string().nullable(), end: z.string().nullable() }),
  summary: z.object({
    sessions: z.number(),
    calls: z.number(),
    skillEvents: z.number(),
    bashEvents: z.number(),
    toolEvents: z.number(),
    drafts: z.number(),
    opportunities: z.number(),
    ghosts: z.number(),
  }),
  drafts: z.array(skillCandidateSchema),
  opportunities: z.array(skillCandidateSchema),
  ghosts: z.array(ghostSkillSchema),
})
export type SkillsPayload = z.infer<typeof skillsPayloadSchema>
