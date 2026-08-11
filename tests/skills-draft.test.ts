import { describe, expect, it } from 'vitest'
import { assembleDraftMarkdown, describeCandidate, slugifyCandidateName } from '../src/shared/lib/skills-draft.js'
import type { SkillCandidate } from '../src/shared/schemas/skills.js'

const bashCandidate: SkillCandidate = {
  name: 'git commit',
  source: 'bash',
  frequency: 6,
  spreadSessions: 2,
  spreadProjects: 1,
  costUSD: 3.5,
  turns: 4,
  latest: '2026-07-13T12:00:00.000Z',
  sample: 'git commit -m "wip"',
  sourceSessions: [
    { sessionId: 'sess-a', project: 'demo', date: '2026-07-13', turns: 3, costUSD: 2 },
    { sessionId: 'sess-b', project: 'demo', date: '2026-07-14', turns: 1, costUSD: 1.5 },
  ],
}

const skillCandidate: SkillCandidate = {
  ...bashCandidate,
  name: 'data-fetch',
  source: 'skill',
  sample: 'data-fetch',
  sourceSessions: [],
}

describe('assembleDraftMarkdown (template mode, no LLM)', () => {
  it('produces a labeled SKILL.md skeleton with the evidence appendix', () => {
    const md = assembleDraftMarkdown(bashCandidate)
    expect(md).toContain('# git commit')
    expect(md).toContain('Template draft — generated locally from normalized evidence (no LLM)')
    expect(md).toContain('## Description')
    expect(md).toContain('## When to use')
    expect(md).toContain('## Example')
    expect(md).toContain('## Evidence')
    expect(md).toContain('- Frequency: 6')
    expect(md).toContain('2026-07-13 · demo (sess-a)')
  })

  it('draws the worked example from the normalized sample (bash)', () => {
    expect(assembleDraftMarkdown(bashCandidate)).toContain('```sh\ngit commit -m "wip"\n```')
  })

  it('uses the pattern key as the example for non-bash sources', () => {
    expect(assembleDraftMarkdown(skillCandidate)).toContain('`data-fetch`')
  })

  it('never includes raw session transcripts', () => {
    const md = assembleDraftMarkdown(bashCandidate)
    expect(md).not.toContain('prompt')
  })
})

describe('describeCandidate', () => {
  it('builds a one-line card description per source', () => {
    expect(describeCandidate(bashCandidate)).toContain('command pattern')
    expect(describeCandidate(skillCandidate)).toContain('skill')
  })
})

describe('slugifyCandidateName', () => {
  it('produces filename-safe slugs', () => {
    expect(slugifyCandidateName('git commit')).toBe('git-commit')
    expect(slugifyCandidateName('data-fetch')).toBe('data-fetch')
    expect(slugifyCandidateName('  npm run build ')).toBe('npm-run-build')
    expect(slugifyCandidateName('///')).toBe('skill')
  })
})
