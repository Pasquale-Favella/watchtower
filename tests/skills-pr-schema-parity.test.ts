import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import * as pullRequests from '../src/shared/schemas/pull-requests.js'
import * as skills from '../src/shared/schemas/skills.js'

function assertAccepted(current: Schema.ConstraintDecoder<unknown>, input: unknown, expected: unknown): void {
  const result = Schema.decodeUnknownResult(current)(input)
  expect(result._tag).toBe('Success')
  if (result._tag === 'Success') expect(result.success).toStrictEqual(expected)
}

function assertRejected(current: Schema.ConstraintDecoder<unknown>, input: unknown): void {
  expect(Schema.decodeUnknownResult(current)(input)._tag).toBe('Failure')
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
  ['skills source', skills.skillsSourceSchema, 'skill'],
  ['candidate source session', skills.candidateSourceSessionSchema, sourceSession],
  ['skill candidate', skills.skillCandidateSchema, candidate],
  ['ghost skill', skills.ghostSkillSchema, ghost],
  [
    'skills dismissal',
    skills.skillsDismissalSchema,
    { source: 'bash', name: 'git status', reason: 'not a skill', created: '2026-01-01' },
  ],
  [
    'skills dismissal request',
    skills.skillsDismissalRequestSchema,
    { source: 'tool', name: 'Read', reason: 'not a skill' },
  ],
  ['skills dismissal success result', skills.skillsDismissalResultSchema, { ok: true }],
  ['skills dismissal failure result', skills.skillsDismissalResultSchema, { ok: false, error: 'offline' }],
  [
    'skills save request',
    skills.skillsSaveRequestSchema,
    { name: 'data-fetch', content: '---\nname: data-fetch\n---' },
  ],
  ['skills save success result', skills.skillsSaveResultSchema, { ok: true, path: '/skills/data-fetch/SKILL.md' }],
  ['skills save failure result', skills.skillsSaveResultSchema, { ok: false, error: 'cancelled' }],
  [
    'skills payload',
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
  ['pull request category', pullRequests.pullRequestCategorySchema, { name: 'coding', cost: 1 }],
  ['pull request row', pullRequests.pullRequestRowSchema, pullRequestRow],
  [
    'pull requests payload',
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
    '%s decodes the expected value, rejects invalid values, and strips unknown keys',
    (_name, schema, sample) => {
      assertAccepted(schema, sample, sample)
      if (typeof sample === 'object' && sample !== null && !Array.isArray(sample)) {
        assertAccepted(schema, { ...sample, unknownExtension: true }, sample)
      }
      assertRejected(schema, { invalid: true })
    },
  )

  it('keeps skill threshold safe-integer, lower-bound, default, and null behavior', () => {
    assertRejected(skills.skillsThresholdsSchema, undefined)
    assertAccepted(skills.skillsThresholdsSchema, {}, { frequency: 5, spread: 2 })
    assertAccepted(skills.skillsThresholdsSchema, { frequency: undefined }, { frequency: 5, spread: 2 })
    assertAccepted(skills.skillsThresholdsSchema, { frequency: 3 }, { frequency: 3, spread: 2 })
    assertAccepted(skills.skillsThresholdsSchema, { frequency: 3, spread: 1 }, { frequency: 3, spread: 1 })
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
      assertRejected(skills.skillsThresholdsSchema, { frequency: value })
    }
    assertAccepted(
      skills.skillsThresholdsSchema,
      { frequency: Number.MAX_SAFE_INTEGER, spread: 1 },
      { frequency: Number.MAX_SAFE_INTEGER, spread: 1 },
    )
  })

  it('keeps decoded threshold fields mutable', () => {
    const decoded = Schema.decodeUnknownSync(skills.skillsThresholdsSchema)({})
    decoded.frequency = 6
    decoded.spread = 3
    expect(decoded).toEqual({ frequency: 6, spread: 3 })
  })

  it('preserves optional PR fields for omitted, undefined, and null inputs', () => {
    assertAccepted(pullRequests.pullRequestRowSchema, pullRequestRow, pullRequestRow)
    assertAccepted(
      pullRequests.pullRequestRowSchema,
      { ...pullRequestRow, categories: undefined, modelProvenance: undefined },
      { ...pullRequestRow, categories: undefined, modelProvenance: undefined },
    )
    assertRejected(pullRequests.pullRequestRowSchema, { ...pullRequestRow, categories: null })
    assertRejected(pullRequests.pullRequestRowSchema, { ...pullRequestRow, modelProvenance: null })
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
    assertAccepted(skills.skillsPayloadSchema, skillsPayload, {
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
      drafts: [candidate],
      opportunities: [],
      ghosts: [],
    })
    assertAccepted(
      pullRequests.pullRequestRowSchema,
      {
        ...pullRequestRow,
        categories: [{ name: 'coding', cost: 1, extension: true }],
      },
      {
        ...pullRequestRow,
        categories: [{ name: 'coding', cost: 1 }],
      },
    )
    assertRejected(skills.skillCandidateSchema, {
      ...candidate,
      source: 'invalid',
    })
    assertAccepted(
      skills.skillsDismissalResultSchema,
      {
        ok: true,
        error: 'wrong branch',
      },
      { ok: true },
    )
    assertRejected(skills.skillCandidateSchema, {
      ...candidate,
      name: null,
    })
    assertRejected(pullRequests.pullRequestRowSchema, {
      ...pullRequestRow,
      models: null,
    })
  })

  it('rejects non-finite numeric contract values', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assertRejected(skills.candidateSourceSessionSchema, {
        ...sourceSession,
        costUSD: value,
      })
      assertRejected(pullRequests.pullRequestRowSchema, {
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
