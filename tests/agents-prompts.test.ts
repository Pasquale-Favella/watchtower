import { describe, expect, it } from 'vitest'

import {
  buildCoachPrompt,
  buildLedgerBriefing,
  buildProsePrompt,
  scopeWindowLabel,
} from '../src/main/agents/prompts.js'

const scope30 = { period: '30days' as const, provider: 'claude' }
const scopeAll = { period: 'lifetime' as const }
const scopeRange = { period: '30days' as const, range: { since: '2026-07-01', until: '2026-07-31' } }

const evidence = {
  source: 'bash' as const,
  name: 'git commit',
  frequency: 6,
  spreadSessions: 2,
  spreadProjects: 1,
  costUSD: 3.5,
  turns: 4,
}

describe('scopeWindowLabel — the agent-facing data-window caption (matches the UI)', () => {
  it('labels a period + provider window', () => {
    expect(scopeWindowLabel(scope30)).toBe('Last 30 days · claude')
  })

  it('labels a provider-less window as all providers', () => {
    expect(scopeWindowLabel(scopeAll)).toBe('Lifetime · all providers')
  })

  it('labels a custom range with its dates', () => {
    expect(scopeWindowLabel(scopeRange)).toBe('custom range 2026-07-01 → 2026-07-31 · all providers')
  })
})

describe('buildLedgerBriefing — the MCP tool briefing', () => {
  it('names every ledger tool and the data window', () => {
    const briefing = buildLedgerBriefing(scope30)
    for (const tool of ['ledger_scope', 'ledger_overview', 'ledger_sessions', 'ledger_models', 'ledger_skills', 'ledger_calls']) {
      expect(briefing).toContain(tool)
    }
    expect(briefing).toContain('Last 30 days · claude')
    expect(briefing).toContain('READ-ONLY')
  })

  it('grounds the answer rule: never invent numbers', () => {
    expect(buildLedgerBriefing(scopeAll)).toContain('Never invent numbers')
  })
})

describe('buildCoachPrompt — briefing prepended only when present', () => {
  it('prepends the briefing then the user question', () => {
    const prompt = buildCoachPrompt('Summarise my spend', buildLedgerBriefing(scope30))
    expect(prompt).toContain("The user's question:\nSummarise my spend")
    expect(prompt.indexOf('ledger_scope')).toBeLessThan(prompt.indexOf('The user'))
  })

  it('passes the user text through untouched without a briefing', () => {
    expect(buildCoachPrompt('Summarise my spend', '')).toBe('Summarise my spend')
  })
})

describe('buildProsePrompt — MCP-aware skill authoring with evidence guardrails', () => {
  it('keeps ONLY normalized evidence plus the MCP grounding note', () => {
    const prompt = buildProsePrompt(evidence, buildLedgerBriefing(scopeAll))
    expect(prompt).toContain('Pattern: git commit')
    expect(prompt).toContain('Frequency: 6 occurrences')
    expect(prompt).toContain('Cost: 3.50 USD across 4 turn(s)')
    // Never a raw command line or transcript in the prompt itself.
    expect(prompt).not.toContain('git commit -m')
    expect(prompt).not.toContain('--amend')
    // The ledger is offered as a real grounding source, never as a way to
    // fabricate specifics.
    expect(prompt).toContain('ledger_skills')
    expect(prompt).toContain('ledger_calls')
    expect(prompt).toContain('never invent')
  })

  it('stays evidence-only when there is no briefing (fresh install)', () => {
    const prompt = buildProsePrompt(evidence, '')
    expect(prompt).toContain('Pattern: git commit')
    expect(prompt).not.toContain('ledger_')
  })
})
