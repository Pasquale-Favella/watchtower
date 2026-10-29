import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it, vi } from 'vitest'

import { createCoachAtoms } from '../src/renderer/features/coach-skills/atoms.js'
import { candidateKey, craftSkillPrompt } from '../src/renderer/features/coach-skills/lib.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import type { SkillCandidate, SkillsPayload, SkillsThresholds } from '../src/shared/schemas/skills.js'
import { makeCoachRpcTestClient } from './coach-rpc-test-helper.js'

function setup(getSkills: (scope: OverviewScope, thresholds?: SkillsThresholds) => Promise<SkillsPayload | null>) {
  const registry = AtomRegistry.make()
  const runtime = Atom.context()
  const client = makeCoachRpcTestClient(runtime, { skills: getSkills })
  const atoms = createCoachAtoms(client)
  registry.mount(atoms.coachStateAtom)
  registry.mount(atoms.detection.resultAtom)
  return { registry, atoms }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true))
}

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
    sessions: 4,
    calls: 40,
    skillEvents: 8,
    bashEvents: 10,
    toolEvents: 3,
    drafts: 1,
    opportunities: 1,
    ghosts: 0,
  },
  drafts: [candidate],
  opportunities: [],
  ghosts: [],
}

describe('Coach & Skills detection pool (the welcome-screen suggested-skill chips)', () => {
  it('loads the detection pool for a scope', async () => {
    const getSkills = vi.fn(async () => payload)
    const { registry, atoms } = setup(getSkills)
    registry.set(atoms.detection.requestAtom, { scope: { period: 'lifetime' }, frequency: 5, spread: 2 })
    await waitFor(() => registry.get(atoms.detection.resultAtom)._tag === 'Success')
    expect(registry.get(atoms.detection.resultAtom)).toMatchObject({ value: payload })
    expect(getSkills).toHaveBeenCalledWith({ period: 'lifetime' }, { frequency: 5, spread: 2 })
    registry.dispose()
  })

  it('switching scope clears to a fresh load (stale-while-revalidate)', async () => {
    const requests: string[] = []
    const getSkills = vi.fn(async (scope: OverviewScope) => {
      requests.push(JSON.stringify(scope))
      return scope.period === 'lifetime' ? payload : null
    })
    const { registry, atoms } = setup(getSkills)
    registry.set(atoms.detection.requestAtom, { scope: { period: 'lifetime' }, frequency: 5, spread: 2 })
    await waitFor(() => registry.get(atoms.detection.resultAtom)._tag === 'Success')
    registry.set(atoms.detection.requestAtom, { scope: { period: 'today' }, frequency: 5, spread: 2 })
    await waitFor(() => requests.length === 2 && registry.get(atoms.detection.resultAtom)._tag === 'Success')
    expect(requests).toEqual([JSON.stringify({ period: 'lifetime' }), JSON.stringify({ period: 'today' })])
    expect(registry.get(atoms.detection.resultAtom)).toMatchObject({ value: null })
    registry.dispose()
  })

  it('a failed load surfaces the error without clearing the last payload', async () => {
    let shouldFail = false
    const getSkills = vi.fn(() =>
      shouldFail ? Promise.reject(new Error('skills unavailable')) : Promise.resolve(payload),
    )
    const { registry, atoms } = setup(getSkills)
    const request = { scope: { period: 'lifetime' as const }, frequency: 5, spread: 2 }
    registry.set(atoms.detection.requestAtom, request)
    await waitFor(() => registry.get(atoms.detection.resultAtom)._tag === 'Success')
    shouldFail = true
    registry.set(atoms.detection.refreshAtom, undefined)
    await waitFor(() => registry.get(atoms.detection.resultAtom)._tag === 'Failure')
    const result = registry.get(atoms.detection.resultAtom)
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(JSON.stringify(result.cause)).toContain('AnalyticsRpcError')
      expect(result.previousSuccess._tag).toBe('Some')
    }
    registry.dispose()
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
    const messy = {
      ...candidate,
      source: 'bash' as const,
      sample: 'git log --format="%h `git branch --show-current`"\nmore',
    }
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
