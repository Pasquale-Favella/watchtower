import { beforeEach, describe, expect, it, vi } from 'vitest'

import { candidateKey, craftSkillPrompt } from '../src/renderer/src/features/coach-skills/lib.js'
import type { SkillCandidate } from '../src/shared/schemas/skills.js'

function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() { return store.size },
    clear: () => { store.clear() },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
}

// The settings store persists via `createJSONStorage(() => localStorage)` at
// module load — install the memory storage BEFORE the dynamic import.
const memory = createMemoryStorage()
vi.stubGlobal('localStorage', memory)

const { useCoachSkillsStore } = await import('../src/renderer/src/features/coach-skills/store.js')

const candidate: SkillCandidate = {
  name: 'data-fetch',
  source: 'skill',
  frequency: 6,
  spreadSessions: 2,
  spreadProjects: 1,
  costUSD: 3.5,
  turns: 4,
  latest: '2026-07-13T12:00:00.000Z',
  sample: 'data-fetch',
  sourceSessions: [{ sessionId: 'sess-a', project: 'demo', date: '2026-07-13', turns: 3, costUSD: 2 }],
}

const payload = {
  period: { start: '2026-07-01', end: '2026-07-31' },
  summary: {
    sessions: 4, calls: 40, skillEvents: 8, bashEvents: 10, toolEvents: 3,
    drafts: 1, opportunities: 1, ghosts: 0,
  },
  drafts: [candidate],
  opportunities: [],
  ghosts: [],
}

beforeEach(() => {
  useCoachSkillsStore.setState(useCoachSkillsStore.getInitialState(), true)
})

describe('Coach & Skills detection pool (the welcome-screen suggested-skill chips)', () => {
  it('loads the detection pool for a scope', async () => {
    mockWindow({ getSkills: () => Promise.resolve(payload) })
    await useCoachSkillsStore.getState().detection.load({ period: 'lifetime' })
    expect(useCoachSkillsStore.getState().detection.data?.drafts[0]?.name).toBe('data-fetch')
  })

  it('switching scope clears to a fresh load (stale-while-revalidate)', async () => {
    const requests: string[] = []
    mockWindow({
      getSkills: (scope: unknown) => {
        requests.push(JSON.stringify(scope))
        return Promise.resolve(null)
      },
    })
    await useCoachSkillsStore.getState().detection.load({ period: 'lifetime' })
    await useCoachSkillsStore.getState().detection.load({ period: 'today' })
    expect(requests).toEqual([JSON.stringify({ period: 'lifetime' }), JSON.stringify({ period: 'today' })])
    expect(useCoachSkillsStore.getState().detection.data).toBeNull()
    expect(useCoachSkillsStore.getState().detection.dataKey).toBe(JSON.stringify({ period: 'today' }))
  })

  it('a failed load surfaces the error without clearing the last payload', async () => {
    mockWindow({ getSkills: () => Promise.resolve(payload) })
    await useCoachSkillsStore.getState().detection.load({ period: 'lifetime' })
    // Same scope refetch fails — the last-known payload must stay visible.
    mockWindow({ getSkills: () => Promise.reject(new Error('ipc down')) })
    await useCoachSkillsStore.getState().detection.load({ period: 'lifetime' })
    const s = useCoachSkillsStore.getState()
    expect(s.detection.error).toBe('ipc down')
    expect(s.detection.data?.drafts[0]?.name).toBe('data-fetch')
  })
})

describe('the suggested-skill chip chat-starter', () => {
  it('candidateKey disambiguates the same name across sources', () => {
    expect(candidateKey(candidate)).toBe('skill\u0000data-fetch')
  })

  it('craftSkillPrompt is evidence-first: real pattern material + ledger grounding, no shape template', () => {
    const prompt = craftSkillPrompt(candidate)
    // Names the pattern with its normalized evidence.
    expect(prompt).toContain('Craft a SKILL.md for the skill `data-fetch`')
    expect(prompt).toContain('6 occurrences across 2 sessions / 1 project')
    expect(prompt).toContain('3.50 USD across 4 turns')
    // Rides the RAW sample AND the concrete evidence sessions so the agent
    // starts from real occurrences, not guesses.
    expect(prompt).toContain('- Sample: `data-fetch`')
    expect(prompt).toContain('`demo` · 2026-07-13 · 3 turns · 2.00 USD')
    // Points the harness at the ledger tools for the verbatim invocations.
    expect(prompt).toContain('`ledger_skills`')
    expect(prompt).toContain('`ledger_calls`')
    expect(prompt).toContain('quote the real invocations')
    expect(prompt).toContain('Never invent')
    // The SHAPE is the harness's call — no section template in the prompt.
    expect(prompt).toContain('format your own harness reads')
    expect(prompt).not.toContain('## Description')
    expect(prompt).not.toContain('## When to use')
    expect(prompt).not.toContain('## Example')
    expect(prompt).not.toContain('under 40 lines')
    // A plain coach run — no build-skill mode, no draft-card plumbing.
    expect(prompt).not.toContain('build-skill')
  })

  it('craftSkillPrompt keeps a messy raw sample to a single clean line', () => {
    // A bash sample with command substitution + a trailing line must not
    // break the markdown bullet — backticks stripped, newline dropped.
    const messy = { ...candidate, source: 'bash' as const, sample: 'git log --format="%h `git branch --show-current`"\nmore' }
    const prompt = craftSkillPrompt(messy)
    const lines = prompt.split('\n').filter(l => l.startsWith('- Sample:'))
    // Exactly ONE Sample line, wrapped in a single pair of code backticks with
    // no backticks inside the sample itself — the raw command's substitution
    // backticks are stripped, and the trailing newline is dropped.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^- Sample: `[^`]+`$/)
    expect(lines[0]).toContain('git log --format="%h git branch --show-current"')
  })
})
