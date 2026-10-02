import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import * as pullRequests from '../src/shared/schemas/pull-requests.js'
import * as skills from '../src/shared/schemas/skills.js'
import { preEffectPullRequestContracts, preEffectSkillsContracts } from './fixtures/pre-effect-skills-pr-schemas.js'

type LegacySchema = { safeParse: (input: unknown) => { success: boolean; data?: unknown } }

function assertParity(legacy: LegacySchema, current: Schema.ConstraintDecoder<unknown>, input: unknown): void {
  const before = legacy.safeParse(input)
  const after = Schema.decodeUnknownResult(current)(input)
  expect(after._tag === 'Success').toBe(before.success)
  if (before.success && after._tag === 'Success') expect(after.success).toStrictEqual(before.data)
}

const sourceSession = { sessionId: 's', project: 'p', date: '2026-01-01', turns: 2, costUSD: 3 }
const candidate: skills.SkillCandidate = {
  name: 'data-fetch',
  source: 'skill',
  frequency: 3,
  spreadSessions: 2,
  spreadProjects: 1,
  costUSD: 4,
  turns: 5,
  latest: '2026-01-01T00:00:00.000Z',
  sample: 'data-fetch',
  sourceSessions: [sourceSession],
}
const ghost = { name: 'unused', root: '/skills' }
const pullRequestRow = {
  url: 'https://example.test/org/repo/pull/1',
  label: 'org/repo#1',
  cost: 1,
  sessions: 2,
  calls: 3,
  firstStarted: '2026-01-01T00:00:00.000Z',
  lastEnded: '2026-01-02T00:00:00.000Z',
  models: ['model'],
}

const contracts = [
  ['skills source', preEffectSkillsContracts.skillsSourceSchema, skills.skillsSourceSchema, 'skill'],
  ['skills thresholds', preEffectSkillsContracts.skillsThresholdsSchema, skills.skillsThresholdsSchema, {}],
  [
    'candidate source session',
    preEffectSkillsContracts.candidateSourceSessionSchema,
    skills.candidateSourceSessionSchema,
    sourceSession,
  ],
  ['skill candidate', preEffectSkillsContracts.skillCandidateSchema, skills.skillCandidateSchema, candidate],
  ['ghost skill', preEffectSkillsContracts.ghostSkillSchema, skills.ghostSkillSchema, ghost],
  [
    'skills dismissal',
    preEffectSkillsContracts.skillsDismissalSchema,
    skills.skillsDismissalSchema,
    { source: 'bash', name: 'git status', reason: 'not a skill', created: '2026-01-01' },
  ],
  [
    'skills dismissal request',
    preEffectSkillsContracts.skillsDismissalRequestSchema,
    skills.skillsDismissalRequestSchema,
    { source: 'tool', name: 'Read', reason: 'not a skill' },
  ],
  [
    'skills dismissal success result',
    preEffectSkillsContracts.skillsDismissalResultSchema,
    skills.skillsDismissalResultSchema,
    { ok: true },
  ],
  [
    'skills dismissal failure result',
    preEffectSkillsContracts.skillsDismissalResultSchema,
    skills.skillsDismissalResultSchema,
    { ok: false, error: 'offline' },
  ],
  [
    'skills save request',
    preEffectSkillsContracts.skillsSaveRequestSchema,
    skills.skillsSaveRequestSchema,
    { name: 'data-fetch', content: '---\nname: data-fetch\n---' },
  ],
  [
    'skills save success result',
    preEffectSkillsContracts.skillsSaveResultSchema,
    skills.skillsSaveResultSchema,
    { ok: true, path: '/skills/data-fetch/SKILL.md' },
  ],
  [
    'skills save failure result',
    preEffectSkillsContracts.skillsSaveResultSchema,
    skills.skillsSaveResultSchema,
    { ok: false, error: 'cancelled' },
  ],
  [
    'skills payload',
    preEffectSkillsContracts.skillsPayloadSchema,
    skills.skillsPayloadSchema,
    {
      period: { start: null, end: null },
      summary: {
        sessions: 1,
        calls: 2,
        skillEvents: 3,
        bashEvents: 4,
        toolEvents: 5,
        drafts: 1,
        opportunities: 0,
        ghosts: 1,
      },
      drafts: [candidate],
      opportunities: [],
      ghosts: [ghost],
    },
  ],
  [
    'pull request category',
    preEffectPullRequestContracts.pullRequestCategorySchema,
    pullRequests.pullRequestCategorySchema,
    { name: 'coding', cost: 1 },
  ],
  [
    'pull request row',
    preEffectPullRequestContracts.pullRequestRowSchema,
    pullRequests.pullRequestRowSchema,
    pullRequestRow,
  ],
  [
    'pull requests payload',
    preEffectPullRequestContracts.pullRequestsPayloadSchema,
    pullRequests.pullRequestsPayloadSchema,
    {
      rows: [pullRequestRow],
      distinctCost: 1,
      distinctSessions: 1,
      subagentSessions: 0,
      attributedCost: 1,
      unattributedCost: 0,
    },
  ],
] as const

describe('skills and pull requests Effect Schema parity', () => {
  it.each(contracts)(
    '%s preserves decoded values, verdicts, and unknown-key stripping',
    (_name, before, after, sample) => {
      assertParity(before, after, sample)
      if (typeof sample === 'object' && sample !== null && !Array.isArray(sample)) {
        assertParity(before, after, { ...sample, unknownExtension: true })
      }
      assertParity(before, after, { invalid: true })
    },
  )

  it('keeps skill threshold safe-integer, lower-bound, default, and null behavior', () => {
    const before = preEffectSkillsContracts.skillsThresholdsSchema
    const after = skills.skillsThresholdsSchema
    for (const input of [undefined, {}, { frequency: undefined }, { frequency: 3 }, { frequency: 3, spread: 1 }]) {
      assertParity(before, after, input)
    }
    for (const value of [
      null,
      -0,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
    ]) {
      assertParity(before, after, { frequency: value })
    }
    assertParity(before, after, { frequency: Number.MAX_SAFE_INTEGER, spread: 1 })
  })

  it('keeps decoded threshold fields mutable', () => {
    const decoded = Schema.decodeUnknownSync(skills.skillsThresholdsSchema)({})
    decoded.frequency = 6
    decoded.spread = 3
    expect(decoded).toEqual({ frequency: 6, spread: 3 })
  })

  it('preserves optional PR fields for omitted, undefined, and null inputs', () => {
    const before = preEffectPullRequestContracts.pullRequestRowSchema
    const after = pullRequests.pullRequestRowSchema
    assertParity(before, after, pullRequestRow)
    assertParity(before, after, { ...pullRequestRow, categories: undefined, modelProvenance: undefined })
    assertParity(before, after, { ...pullRequestRow, categories: null })
    assertParity(before, after, { ...pullRequestRow, modelProvenance: null })
  })

  it('preserves nested unknown-key stripping and rejects invalid enums, branches, and null fields', () => {
    const skillsPayload = {
      period: { start: null, end: null },
      summary: {
        sessions: 0,
        calls: 0,
        skillEvents: 0,
        bashEvents: 0,
        toolEvents: 0,
        drafts: 1,
        opportunities: 0,
        ghosts: 0,
      },
      drafts: [{ ...candidate, sourceSessions: [{ ...sourceSession, extension: true }] }],
      opportunities: [],
      ghosts: [],
    }
    assertParity(preEffectSkillsContracts.skillsPayloadSchema, skills.skillsPayloadSchema, skillsPayload)
    assertParity(preEffectPullRequestContracts.pullRequestRowSchema, pullRequests.pullRequestRowSchema, {
      ...pullRequestRow,
      categories: [{ name: 'coding', cost: 1, extension: true }],
    })
    assertParity(preEffectSkillsContracts.skillCandidateSchema, skills.skillCandidateSchema, {
      ...candidate,
      source: 'invalid',
    })
    assertParity(preEffectSkillsContracts.skillsDismissalResultSchema, skills.skillsDismissalResultSchema, {
      ok: true,
      error: 'wrong branch',
    })
    assertParity(preEffectSkillsContracts.skillCandidateSchema, skills.skillCandidateSchema, {
      ...candidate,
      name: null,
    })
    assertParity(preEffectPullRequestContracts.pullRequestRowSchema, pullRequests.pullRequestRowSchema, {
      ...pullRequestRow,
      models: null,
    })
  })

  it('rejects non-finite numeric contract values', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assertParity(preEffectSkillsContracts.candidateSourceSessionSchema, skills.candidateSourceSessionSchema, {
        ...sourceSession,
        costUSD: value,
      })
      assertParity(preEffectPullRequestContracts.pullRequestRowSchema, pullRequests.pullRequestRowSchema, {
        ...pullRequestRow,
        cost: value,
      })
    }
  })

  it('keeps decoded collections and object fields mutable', () => {
    const decodedSkills = Schema.decodeUnknownSync(skills.skillsPayloadSchema)({
      period: { start: null, end: null },
      summary: {
        sessions: 0,
        calls: 0,
        skillEvents: 0,
        bashEvents: 0,
        toolEvents: 0,
        drafts: 0,
        opportunities: 0,
        ghosts: 0,
      },
      drafts: [candidate],
      opportunities: [],
      ghosts: [],
    })
    const firstCandidate = decodedSkills.drafts[0]
    if (!firstCandidate) throw new Error('fixture must include a draft')
    firstCandidate.name = 'changed'
    decodedSkills.drafts.push({ ...candidate, name: 'another', sourceSessions: [] })
    expect(decodedSkills.drafts.map(({ name }) => name)).toEqual(['changed', 'another'])

    const decodedPullRequests = Schema.decodeUnknownSync(pullRequests.pullRequestsPayloadSchema)({
      rows: [{ ...pullRequestRow, categories: [{ name: 'coding', cost: 1 }] }],
      distinctCost: 1,
      distinctSessions: 1,
      subagentSessions: 0,
      attributedCost: 1,
      unattributedCost: 0,
    })
    const firstPullRequest = decodedPullRequests.rows[0]
    const firstCategory = firstPullRequest?.categories?.[0]
    if (!firstCategory) throw new Error('fixture must include a pull request category')
    firstCategory.name = 'changed'
    decodedPullRequests.rows.push({ ...pullRequestRow, models: [] })
    expect(firstCategory.name).toBe('changed')
    expect(decodedPullRequests.rows).toHaveLength(2)
  })
})
