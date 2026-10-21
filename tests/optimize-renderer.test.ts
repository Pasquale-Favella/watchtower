import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DeliveryEvidence } from '../src/renderer/src/features/optimize/DeliveryOutcomes.js'
import { OptimizeFindings } from '../src/renderer/src/features/optimize/OptimizeFindings.js'
import type { OptimizeFinding } from '../src/shared/schemas/optimize.js'
import { calculateYieldPayload } from '../src/main/yield-calculation.js'
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
    const markup = renderToStaticMarkup(createElement(OptimizeFindings, { findings: [finding], showFix: true }))
    expect(markup).toContain('For review')
    expect(markup).toContain('Modeled 1.2K tokens')
    expect(markup).toContain('Task complexity is unknown.')
    expect(markup).toContain('Associated spend')
    expect(markup).toContain('Copy suggestion')
    expect(markup).toContain('Open supporting session sess-0')
    expect(markup).not.toMatch(/estimated avoidable cost|potential savings|tokens saved/i)
  })
})
