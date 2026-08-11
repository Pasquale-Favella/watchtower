import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore } from '../src/main/store/ledger.js'
import type { ClassifiedTurn, ParsedApiCall, SessionSummary } from '../src/main/pipeline/types.js'
import type { CachedCall, CachedFile } from '../src/main/pipeline/session-cache.js'
import { buildFixtureReport } from './fixtures/report.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn, buildFixtureCachedCall } from './fixtures/cached-file.js'
import {
  buildSkillsViewFromLedger,
  collectSkillCandidates,
  findGhostSkills,
  normalizeBashCommand,
  partitionSkillCandidates,
} from '../src/main/skills-view.js'
import { DEFAULT_SKILLS_THRESHOLDS, skillsThresholdsSchema } from '../src/shared/schemas/skills.js'

const BASE_SESSION = buildFixtureReport()[0]!.sessions[0]!
const BASE_TURN = BASE_SESSION.turns[0]!
const BASE_CALL = BASE_TURN.assistantCalls[0]!

function makeCall(
  index: number,
  opts: {
    cost?: number
    skills?: string[]
    bashCommands?: string[]
    tools?: string[]
    date?: string
  } = {},
): ParsedApiCall {
  const iso = new Date(`${opts.date ?? '2026-07-10'}T12:00:00`).toISOString()
  return {
    ...BASE_CALL,
    costUSD: opts.cost ?? 0,
    skills: opts.skills ?? [],
    bashCommands: opts.bashCommands ?? [],
    tools: opts.tools ?? ['Edit'],
    timestamp: iso,
    deduplicationKey: `dedup-${index}`,
  }
}

function makeTurn(index: number, calls: ParsedApiCall[], subCategory?: string): ClassifiedTurn {
  const iso = new Date(`2026-07-10T1${index % 10}:00:00`).toISOString()
  return {
    ...BASE_TURN,
    userMessage: `prompt ${index}`,
    sessionId: `sess-${index}`,
    assistantCalls: calls,
    timestamp: iso,
    ...(subCategory ? { subCategory } : {}),
  }
}

function makeSession(
  index: number,
  opts: { turns: ClassifiedTurn[]; project?: string; date?: string },
): SessionSummary {
  const iso = new Date(`${opts.date ?? '2026-07-10'}T09:00:00`).toISOString()
  const calls = opts.turns.flatMap(t => t.assistantCalls)
  return {
    ...BASE_SESSION,
    sessionId: `sess-${index}`,
    project: opts.project ?? 'demo-project',
    firstTimestamp: iso,
    lastTimestamp: iso,
    totalCostUSD: calls.reduce((s, c) => s + c.costUSD, 0),
    totalInputTokens: calls.reduce((s, c) => s + c.usage.inputTokens, 0),
    totalOutputTokens: calls.reduce((s, c) => s + c.usage.outputTokens, 0),
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: calls.length,
    turns: opts.turns,
  }
}

const NOW = new Date(2026, 6, 15)

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'skills-'))
}

describe('normalizeBashCommand (seam b clustering)', () => {
  it('strips flags, values and quoted arguments', () => {
    expect(normalizeBashCommand('git commit -m "wip"')).toBe('git commit')
    expect(normalizeBashCommand('git commit -m "fix"')).toBe('git commit')
    expect(normalizeBashCommand('npx eslint src/')).toBe('npx eslint')
    expect(normalizeBashCommand('npm test -- --watch')).toBe('npm test')
  })

  it('keeps subcommand chains (verb chains are the pattern)', () => {
    expect(normalizeBashCommand('npm run build')).toBe('npm run build')
    expect(normalizeBashCommand('docker compose up -d')).toBe('docker compose up')
  })

  it('strips paths and file values from the lead', () => {
    expect(normalizeBashCommand('cd /Users/me/repo')).toBe('cd')
    expect(normalizeBashCommand('cat file.txt')).toBe('cat')
    expect(normalizeBashCommand('node script.js')).toBe('node')
  })

  it('keeps a command with no bare-word lead whole', () => {
    expect(normalizeBashCommand('./script.sh --flag')).toBe('./script.sh --flag')
  })

  it('trims surrounding whitespace and stops at the first flag', () => {
    expect(normalizeBashCommand('  git push -f origin main  ')).toBe('git push')
  })
})

describe('collectSkillCandidates (three seams)', () => {
  it('mines per-call skills with per-session evidence', () => {
    const sessionA = makeSession(0, {
      turns: [
        makeTurn(0, [makeCall(0, { skills: ['data-fetch'], cost: 1 })]),
        makeTurn(1, [makeCall(1, { skills: ['data-fetch'], cost: 1 })]),
      ],
      project: 'proj-a',
    })
    const sessionB = makeSession(1, {
      turns: [makeTurn(2, [makeCall(2, { skills: ['data-fetch'], cost: 1 })])],
      project: 'proj-b',
    })
    const candidates = collectSkillCandidates([sessionA, sessionB])
    const dataFetch = candidates.find(c => c.name === 'data-fetch')
    expect(dataFetch).toBeDefined()
    expect(dataFetch!.source).toBe('skill')
    expect(dataFetch!.frequency).toBe(3)
    expect(dataFetch!.sessions.size).toBe(2)
    expect(dataFetch!.projects.size).toBe(2)
    expect(dataFetch!.costUSD).toBe(3)
    expect(dataFetch!.perSession.get('sess-0')).toMatchObject({ project: 'proj-a', turns: 2, costUSD: 2 })
  })

  it('mines the classifier subCategory as a skill signal', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, [makeCall(0, { cost: 1 })], 'data-fetch')],
    })
    const candidates = collectSkillCandidates([session])
    expect(candidates.find(c => c.name === 'data-fetch')?.frequency).toBe(1)
  })

  it('clusters normalized bash variants into one pattern', () => {
    const session = makeSession(0, {
      turns: [
        makeTurn(0, [makeCall(0, { bashCommands: ['git commit -m "wip"'] })]),
        makeTurn(1, [makeCall(1, { bashCommands: ['git commit -m "fix bug"'] })]),
      ],
    })
    const candidates = collectSkillCandidates([session])
    const commit = candidates.find(c => c.name === 'git commit')
    expect(commit).toBeDefined()
    expect(commit!.source).toBe('bash')
    expect(commit!.frequency).toBe(2)
    expect(commit!.sample).toBe('git commit -m "wip"')
  })

  it('excludes primitive tools and mcp tools from the tool seam', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, [makeCall(0, { tools: ['Edit', 'Bash', 'Read', 'mcp__db__query', 'codex_tool'] })])],
    })
    const candidates = collectSkillCandidates([session])
    expect(candidates.find(c => c.name === 'Edit')).toBeUndefined()
    expect(candidates.find(c => c.name === 'mcp__db__query')).toBeUndefined()
    const tool = candidates.find(c => c.name === 'codex_tool')
    expect(tool).toBeDefined()
    expect(tool!.source).toBe('tool')
  })
})

describe('partitionSkillCandidates (frequency × spread gate)', () => {
  function withSkill(frequency: number, sessions: number): ReturnType<typeof collectSkillCandidates>[number] {
    const perSession = Math.ceil(frequency / sessions)
    const summaries = Array.from({ length: sessions }, (_, i) =>
      makeSession(i, {
        turns: Array.from({ length: perSession }, (_, j) =>
          makeTurn(i * 10 + j, [makeCall(i * 10 + j, { skills: ['pattern-x'], cost: 0.1 })]),
        ),
        project: `proj-${i}`,
      }),
    )
    return collectSkillCandidates(summaries).find(c => c.name === 'pattern-x')!
  }

  it('promotes frequency ≥ 5 AND spread ≥ 2 (sessions or projects) to a draft', () => {
    const candidate = withSkill(6, 2)
    const { drafts, opportunities } = partitionSkillCandidates([candidate])
    expect(drafts.map(d => d.name)).toEqual(['pattern-x'])
    expect(opportunities).toEqual([])
    expect(drafts[0]!).toMatchObject({ frequency: 6, spreadSessions: 2, spreadProjects: 2, turns: 6 })
  })

  it('sends frequency ≥ threshold but spread 1 to the opportunity list', () => {
    const candidate = withSkill(6, 1)
    const { drafts, opportunities } = partitionSkillCandidates([candidate])
    expect(drafts).toEqual([])
    expect(opportunities.map(o => o.name)).toEqual(['pattern-x'])
  })

  it('sends below-frequency but repeated patterns to the opportunity list', () => {
    const candidate = withSkill(3, 2)
    const { drafts, opportunities } = partitionSkillCandidates([candidate])
    expect(drafts).toEqual([])
    expect(opportunities.map(o => o.name)).toEqual(['pattern-x'])
  })

  it('drops single-use patterns entirely', () => {
    const candidate = withSkill(1, 1)
    const { drafts, opportunities } = partitionSkillCandidates([candidate])
    expect(drafts).toEqual([])
    expect(opportunities).toEqual([])
  })

  it('honors custom threshold settings (not code constants)', () => {
    const candidate = withSkill(3, 1)
    const { drafts, opportunities } = partitionSkillCandidates([candidate], { frequency: 3, spread: 1 })
    expect(drafts.map(d => d.name)).toEqual(['pattern-x'])
    expect(opportunities).toEqual([])
  })
})

describe('skillsThresholdsSchema (the handler tripwire)', () => {
  it('defaults missing fields to 5 × 2', () => {
    expect(skillsThresholdsSchema.safeParse({}).data).toEqual(DEFAULT_SKILLS_THRESHOLDS)
    expect(skillsThresholdsSchema.safeParse({ frequency: 3 }).data).toEqual({ frequency: 3, spread: 2 })
  })

  it('fails on absent input so the handler falls back to defaults', () => {
    expect(skillsThresholdsSchema.safeParse(undefined).success).toBe(false)
  })

  it('rejects out-of-range values so the handler falls back to defaults', () => {
    expect(skillsThresholdsSchema.safeParse({ frequency: -5, spread: 0 }).success).toBe(false)
    expect(skillsThresholdsSchema.safeParse({ frequency: 1.5, spread: 2 }).success).toBe(false)
  })

  it('accepts a valid tuning pair', () => {
    expect(skillsThresholdsSchema.safeParse({ frequency: 3, spread: 1 }).data).toEqual({ frequency: 3, spread: 1 })
  })
})

describe('findGhostSkills', () => {
  it('flags inventory entries never invoked in the scope', () => {
    const inventory = [
      { name: 'debugger', root: '/home/u/.claude/skills' },
      { name: 'data-fetch', root: '/home/u/.claude/skills' },
    ]
    const ghosts = findGhostSkills(inventory, ['data-fetch'])
    expect(ghosts).toEqual([{ name: 'debugger', root: '/home/u/.claude/skills' }])
  })

  it('stays empty when every inventory entry was invoked', () => {
    expect(findGhostSkills([{ name: 'data-fetch', root: '/x' }], ['data-fetch'])).toEqual([])
  })
})

// ── Ledger-backed Skills view (aggregation seam scope) ──────────────────────

function makeLedger(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'skills-ledger-'))
  return new LedgerStore(join(dir, 'data.db'))
}

function cachedCall(index: number, opts: {
  sessionId: string
  date?: string
  cost?: number
  skills?: string[]
  bashCommands?: string[]
  tools?: string[]
}): CachedCall {
  const iso = new Date(`${opts.date ?? '2026-07-13'}T12:00:00`).toISOString()
  return {
    ...buildFixtureCachedCall(index),
    costUSD: opts.cost ?? 0.5,
    skills: opts.skills ?? [],
    bashCommands: opts.bashCommands ?? [],
    tools: opts.tools ?? ['Edit'],
    timestamp: iso,
  }
}

function portSession(
  store: LedgerStore,
  sessionId: string,
  calls: CachedCall[],
): void {
  const iso = new Date('2026-07-13T12:00:00').toISOString()
  const turn = buildFixtureCachedTurn(0, `prompt ${sessionId}`, { sessionId, timestamp: iso, calls })
  const file: CachedFile = buildFixtureCachedFile({ canonicalProjectName: 'demo-project', turns: [turn] })
  store.portIn({
    provider: 'opencode',
    envFingerprint: 'env-demo',
    filePath: `/cache/opencode/${sessionId}.jsonl`,
    verdict: 'new',
    cachedFile: file,
  })
}

describe('buildSkillsViewFromLedger (aggregation seam scope)', () => {
  it('returns a zero payload for an empty ledger', async () => {
    const store = makeLedger()
    const payload = await buildSkillsViewFromLedger(store, { period: 'lifetime' }, undefined, { now: NOW, homeDir: tempHome() })
    expect(payload.drafts).toEqual([])
    expect(payload.opportunities).toEqual([])
    expect(payload.ghosts).toEqual([])
    expect(payload.summary).toMatchObject({ sessions: 0, calls: 0, drafts: 0, opportunities: 0, ghosts: 0 })
    expect(payload.period.start).not.toBeNull()
    store.close()
  })

  it('promotes a ledger skill pattern to a draft with exact counts', async () => {
    const store = makeLedger()
    portSession(store, 'sess-a', [
      cachedCall(0, { sessionId: 'sess-a', skills: ['data-fetch'], cost: 1 }),
      cachedCall(1, { sessionId: 'sess-a', skills: ['data-fetch'], cost: 1 }),
      cachedCall(2, { sessionId: 'sess-a', skills: ['data-fetch'], cost: 1 }),
    ])
    portSession(store, 'sess-b', [
      cachedCall(3, { sessionId: 'sess-b', skills: ['data-fetch'], cost: 1 }),
      cachedCall(4, { sessionId: 'sess-b', skills: ['data-fetch'], cost: 1 }),
      cachedCall(5, { sessionId: 'sess-b', skills: ['data-fetch'], cost: 1 }),
    ])
    const payload = await buildSkillsViewFromLedger(store, { period: 'lifetime' }, undefined, { now: NOW, homeDir: tempHome() })
    expect(payload.summary.sessions).toBe(2)
    expect(payload.summary.calls).toBe(6)
    // 6 per-call invocations + 2 classifier subCategory turns (the classifier
    // mirrors a call's skills into the turn capability — pipeline behavior).
    expect(payload.summary.skillEvents).toBe(8)
    expect(payload.drafts).toHaveLength(1)
    expect(payload.drafts[0]!).toMatchObject({
      name: 'data-fetch',
      source: 'skill',
      frequency: 8,
      spreadSessions: 2,
      spreadProjects: 1,
      costUSD: 12,
      turns: 2,
    })
    expect(payload.opportunities).toEqual([])
    store.close()
  })

  it('clusters ledger bash commands and sends below-gate patterns to opportunities', async () => {
    const store = makeLedger()
    portSession(store, 'sess-a', [
      cachedCall(0, { sessionId: 'sess-a', bashCommands: ['git commit -m "wip"'] }),
      cachedCall(1, { sessionId: 'sess-a', bashCommands: ['git commit -m "fix"'] }),
    ])
    portSession(store, 'sess-b', [
      cachedCall(2, { sessionId: 'sess-b', bashCommands: ['git commit -m "lint"'] }),
    ])
    const payload = await buildSkillsViewFromLedger(store, { period: 'lifetime' }, undefined, { now: NOW, homeDir: tempHome() })
    expect(payload.summary.bashEvents).toBe(3)
    expect(payload.drafts).toEqual([])
    expect(payload.opportunities).toHaveLength(1)
    expect(payload.opportunities[0]!).toMatchObject({ name: 'git commit', source: 'bash', frequency: 3, spreadSessions: 2 })
    store.close()
  })

  it('flags home skill-dir entries never invoked as ghosts', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.claude', 'skills', 'debugger'), { recursive: true })
    mkdirSync(join(home, '.claude', 'skills', 'data-fetch'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'debugger', 'SKILL.md'), '')
    writeFileSync(join(home, '.claude', 'skills', 'data-fetch', 'SKILL.md'), '')

    const store = makeLedger()
    portSession(store, 'sess-a', [cachedCall(0, { sessionId: 'sess-a', skills: ['data-fetch'] })])
    const payload = await buildSkillsViewFromLedger(store, { period: 'lifetime' }, undefined, { now: NOW, homeDir: home })
    expect(payload.ghosts).toEqual([{ name: 'debugger', root: join(home, '.claude', 'skills') }])
    store.close()
  })

  it('filters dismissed patterns out of drafts and opportunities (ticket 25)', async () => {
    const store = makeLedger()
    portSession(store, 'sess-a', [cachedCall(0, { sessionId: 'sess-a', bashCommands: ['git commit -m "wip"'] })])
    portSession(store, 'sess-b', [cachedCall(1, { sessionId: 'sess-b', bashCommands: ['git commit -m "lint"'] })])
    const payload = await buildSkillsViewFromLedger(
      store,
      { period: 'lifetime' },
      undefined,
      {
        now: NOW,
        homeDir: tempHome(),
        dismissals: [{ source: 'bash', name: 'git commit', reason: 'not-a-skill', created: '2026-07-01T00:00:00.000Z' }],
      },
    )
    // The dismissed candidate is filtered before the gate, so its events stop
    // counting as skill signals (a dismissed pattern is "not a skill") and it
    // never resurfaces as a draft or opportunity.
    expect(payload.summary.bashEvents).toBe(0)
    expect(payload.summary.sessions).toBe(2)
    expect(payload.opportunities).toEqual([])
    expect(payload.drafts).toEqual([])
    store.close()
  })

  it('honors a custom-range scope at the SQL read', async () => {
    const store = makeLedger()
    portSession(store, 'sess-a', [cachedCall(0, { sessionId: 'sess-a', date: '2026-07-13', skills: ['data-fetch'] })])
    portSession(store, 'sess-b', [cachedCall(1, { sessionId: 'sess-b', date: '2026-07-20', skills: ['data-fetch'] })])
    const payload = await buildSkillsViewFromLedger(
      store,
      { period: 'lifetime', range: { since: '2026-07-12', until: '2026-07-14' } },
      undefined,
      { now: NOW, homeDir: tempHome() },
    )
    expect(payload.summary.sessions).toBe(1)
    expect(payload.summary.calls).toBe(1)
    store.close()
  })
})
