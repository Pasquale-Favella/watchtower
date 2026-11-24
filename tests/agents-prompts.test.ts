import { describe, expect, it } from 'vitest'

import { buildLedgerBriefing, scopeWindowLabel } from '../src/infrastructure/agent-harnesses/prompts.js'

const scope30 = { period: '30days' as const, provider: 'claude' }
const scopeAll = { period: 'lifetime' as const }
const scopeRange = { period: '30days' as const, range: { since: '2026-07-01', until: '2026-07-31' } }

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

describe('buildLedgerBriefing — the MCP tool briefing (lifetime-serving)', () => {
  it('names every ledger tool and the scope-argument filtering mechanism', () => {
    const briefing = buildLedgerBriefing()
    for (const tool of [
      'ledger_scope',
      'ledger_overview',
      'ledger_sessions',
      'ledger_models',
      'ledger_skills',
      'ledger_calls',
    ]) {
      expect(briefing).toContain(tool)
    }
    // The server serves the FULL lifetime ledger, filtered per-tool by the
    // agent itself through the optional `scope` argument.
    expect(briefing).toContain('FULL usage history')
    expect(briefing).toContain('scope')
    expect(briefing).toContain('READ-ONLY')
    // The tool list doubles as SELECTION guidance — when to pick each tool,
    // not just that it exists — and ledger_scope is the mandatory first call.
    expect(briefing).toContain('Choose the tool by question')
    expect(briefing).toContain('Call this FIRST')
  })

  it('tells the harness to state which window it queried, so scoped answers are transparent', () => {
    const briefing = buildLedgerBriefing()
    expect(briefing).toContain('Say which window you queried')
    expect(briefing).toContain('so the user always knows what your numbers cover')
  })

  it("names the user's current window ONLY as a suggested default when one is provided", () => {
    const briefing = buildLedgerBriefing(scope30)
    expect(briefing).toContain('Last 30 days · claude')
    expect(briefing).toContain('a good default window')
    // A hint, never a boundary: the lifetime access is still stated.
    expect(briefing).toContain('FULL usage history')
  })

  it('carries no window hint when no scope is provided', () => {
    const briefing = buildLedgerBriefing()
    expect(briefing).not.toContain('good default window')
    expect(briefing).not.toContain('Last 30 days')
  })

  it('grounds the answer rule: never invent numbers', () => {
    expect(buildLedgerBriefing(scopeAll)).toContain('Never invent numbers')
    // The briefing closes on an explicit non-negotiables section.
    expect(buildLedgerBriefing(scopeAll)).toContain('## Non-negotiables')
  })

  it('defines the ONE agent across TWO scopes — coaching AND skill authoring (the build-skill mode is gone)', () => {
    const briefing = buildLedgerBriefing(scopeAll)
    expect(briefing).toContain('TWO scopes')
    expect(briefing).toContain('1. Coaching')
    expect(briefing).toContain('2. Skill authoring')
    // The authoring scope is EVIDENCE-FIRST: it hands the agent the ledger
    // tools + the real-invocation rule, and leaves the SKILL.md shape to the
    // harness's own conventions — no section template is prescribed.
    expect(briefing).toContain('ledger_skills')
    expect(briefing).toContain('ledger_calls')
    expect(briefing).toContain('never inventing')
    expect(briefing).toContain('no template needed here')
    expect(briefing).not.toContain('## Description')
    expect(briefing).not.toContain('## When to use')
    expect(briefing).not.toContain('## Example')
    expect(briefing).not.toContain('under 40 lines')
  })
})
