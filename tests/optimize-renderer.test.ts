import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DeliveryEvidence } from '../src/renderer/features/optimize/DeliveryOutcomes.js'
import { FindingRow, OptimizeFindings } from '../src/renderer/features/optimize/OptimizeFindings.js'
import { OptimizeSummary } from '../src/renderer/features/optimize/OptimizeSummary.js'
import type { OptimizeFinding, OptimizePayload } from '../src/shared/schemas/optimize.js'
import { calculateYieldPayload } from '../src/core/analytics/attribution/yield-calculation.js'
import { buildFixtureReport } from './fixtures/report.js'

describe('Optimize evidence presentation', () => {
  const base = buildFixtureReport()[0]!.sessions[0]!
  const range = { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-07-01T12:00:00Z') }

  it('shows unknown inspection and associated spend without an abandonment verdict', () => {
    const payload = calculateYieldPayload(
      [
        {
          sessions: [base],
          commits: [],
          projectNames: ['review-project'],
          inspected: false,
          mainRef: null,
          inspectionIssues: [{ operation: 'repository-identity', message: 'Repository unavailable.' }],
        },
      ],
      range,
    )
    const markup = renderToStaticMarkup(createElement(DeliveryEvidence, { payload }))
    expect(markup).toContain('Unknown')
    expect(markup).toContain('Associated spend')
    expect(markup).toContain('Repository unavailable.')
    expect(markup).toContain('Open session sess-0')
    expect(markup).not.toMatch(/abandon|potential savings/i)
  })

  it('keeps mixed sessions in Reverts and exposes surviving and reverted evidence', () => {
    const commit = { sha: 'abcdef012345', timestamp: new Date('2026-07-01T10:00:00Z'), inMain: true, wasReverted: true }
    const payload = calculateYieldPayload(
      [
        {
          sessions: [base],
          commits: [commit, { ...commit, sha: 'fedcba543210', wasReverted: false }],
          projectNames: ['mixed-project'],
          inspected: true,
          mainRef: 'refs/heads/main',
        },
      ],
      range,
    )
    const markup = renderToStaticMarkup(createElement(DeliveryEvidence, { payload, revertsOnly: true }))
    expect(markup).toContain('mixed-project')
    expect(markup).toContain('Mixed changes')
    expect(markup).toContain('abcdef012345')
    expect(markup).toContain('fedcba543210')
    expect(markup).toContain('Revert recorded')
    expect(markup).toContain('No revert recorded')
    expect(markup).not.toContain('No sessions match')
  })

  it('shows modeled quantities and copyable suggestions without invented savings', () => {
    const finding: OptimizeFinding = {
      id: 'context-heavy-sessions',
      title: 'Context-heavy review',
      explanation: 'Review context needs.',
      severity: 'low',
      trend: null,
      findingClass: 'information',
      basis: 'modeled',
      quantity: { value: 1200, unit: 'tokens' },
      assumptions: ['Task complexity is unknown.'],
      affectedSessions: [
        {
          key: '1:sess-0',
          sourceId: 1,
          sessionId: 'sess-0',
          project: 'review-project',
          costUSD: 4,
          reasons: ['Large context.'],
        },
      ],
      associatedSpendUSD: 4,
      tokensSaved: null,
      estimatedSavingsUSD: null,
      fix: {
        type: 'paste',
        label: 'Review context',
        text: 'Review the relevant context first.',
        destination: 'prompt',
      },
    }
    const list = renderToStaticMarkup(createElement(OptimizeFindings, { findings: [finding] }))
    expect(list).toContain('For review')
    expect(list).toContain('Modeled 1.2K tokens')
    expect(list).toContain('Associated spend')
    expect(list).not.toContain('Copy suggestion')

    const markup = renderToStaticMarkup(createElement(FindingRow, { finding, defaultExpanded: true }))
    expect(markup).toContain('Task complexity is unknown.')
    expect(markup).toContain('Copy suggestion')
    expect(markup).toContain('Open supporting session sess-0')
    expect(markup).not.toMatch(/estimated avoidable cost|potential savings|tokens saved/i)
  })

  it('summarises findings, spend, coverage and setup health at a glance', () => {
    const payload: OptimizePayload = {
      period: { start: null, end: null },
      summary: {
        healthScore: 72,
        healthGrade: 'C',
        findingCount: 3,
        periodCostUSD: 12.5,
        sessions: 9,
        calls: 90,
        potentialSavingsTokens: null,
        potentialSavingsCostUSD: null,
        potentialSavingsPercent: null,
        setupCoverage: { eligibleSessions: 8, observedSessions: 5 },
        behaviorSessions: 7,
        excludedSidechainSessions: 2,
      },
      findings: [],
    }
    const markup = renderToStaticMarkup(createElement(OptimizeSummary, { payload }))
    expect(markup).toContain('Review opportunities')
    expect(markup).toContain('2 delegated excluded from comparisons')
    expect(markup).toContain('role="progressbar"')
    expect(markup).toContain('72/100')
    expect(markup).toContain('MCP inventory observed in 5 of 8 eligible sessions')

    const ungraded = { ...payload, summary: { ...payload.summary, healthGrade: null, healthScore: null } }
    const ungradedMarkup = renderToStaticMarkup(createElement(OptimizeSummary, { payload: ungraded }))
    expect(ungradedMarkup).toContain('Insufficient setup evidence')
    expect(ungradedMarkup).not.toContain('role="progressbar"')
  })
})
