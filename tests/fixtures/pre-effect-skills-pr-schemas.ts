import { z } from 'zod'

const source = z.enum(['skill', 'bash', 'tool'])
const sourceSession = z.object({
  sessionId: z.string(),
  project: z.string(),
  date: z.string(),
  turns: z.number(),
  costUSD: z.number(),
})
const skillCandidate = z.object({
  name: z.string(),
  source,
  frequency: z.number(),
  spreadSessions: z.number(),
  spreadProjects: z.number(),
  costUSD: z.number(),
  turns: z.number(),
  latest: z.string(),
  sample: z.string(),
  sourceSessions: z.array(sourceSession),
})
const ghostSkill = z.object({ name: z.string(), root: z.string() })

export const preEffectSkillsContracts = {
  skillsSourceSchema: source,
  skillsThresholdsSchema: z.object({
    frequency: z.number().int().min(1).default(5),
    spread: z.number().int().min(1).default(2),
  }),
  candidateSourceSessionSchema: sourceSession,
  skillCandidateSchema: skillCandidate,
  ghostSkillSchema: ghostSkill,
  skillsDismissalSchema: z.object({ source, name: z.string(), reason: z.string(), created: z.string() }),
  skillsDismissalRequestSchema: z.object({ source, name: z.string(), reason: z.string() }),
  skillsDismissalResultSchema: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
  skillsSaveRequestSchema: z.object({ name: z.string(), content: z.string() }),
  skillsSaveResultSchema: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), path: z.string() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
  skillsPayloadSchema: z.object({
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
    drafts: z.array(skillCandidate),
    opportunities: z.array(skillCandidate),
    ghosts: z.array(ghostSkill),
  }),
}

const pullRequestCategory = z.object({ name: z.string(), cost: z.number() })
const pullRequestRow = z.object({
  url: z.string(),
  label: z.string(),
  cost: z.number(),
  sessions: z.number(),
  calls: z.number(),
  firstStarted: z.string(),
  lastEnded: z.string(),
  models: z.array(z.string()),
  modelProvenance: z.record(z.string(), z.array(z.string())).optional(),
  categories: z.array(pullRequestCategory).optional(),
})

export const preEffectPullRequestContracts = {
  pullRequestCategorySchema: pullRequestCategory,
  pullRequestRowSchema: pullRequestRow,
  pullRequestsPayloadSchema: z.object({
    rows: z.array(pullRequestRow),
    distinctCost: z.number(),
    distinctSessions: z.number(),
    subagentSessions: z.number(),
    attributedCost: z.number(),
    unattributedCost: z.number(),
  }),
}
